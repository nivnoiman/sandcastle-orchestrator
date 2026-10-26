import { join } from "node:path";
import { assertGitControlUnchanged } from "./gitGuard.js";
import type { TargetRepo } from "../model/runModel.js";
import type { AttemptLogStore } from "./attemptLog.js";
import { runWithIdleTimeout, type CommandRunner } from "./commandRunner.js";
import { execAsRoot, execRequest, removeContainer, stageContainerName } from "./docker.js";
import { bootstrapScript, checkCommand, type OrchestratorConfig } from "./env.js";
import type { FileSystemPort } from "./fileSystem.js";
import { integrationBase } from "../project/projectConfig.js";
import { CONTAINER_HOME, type SandcastleLayout } from "./paths.js";
import { describeAgent, snapshotCredential, syncBackCredential, type ResolvedAgent } from "./agents/index.js";
import { ensureFreshLogin } from "./authProbe.js";
import {
  CHECK_OUTPUT_TAIL,
  CheckFailure,
  claimWorkspaceCommand,
  copyWorkspaceCommand,
  outputTail,
  startWorktreeContainer,
  type WorkspaceMode,
} from "./sandboxRunner.js";
import { messageOf } from "../messageOf.js";

export interface IntegrationWorkspace {
  repo: TargetRepo;
  worktree: string;
  baseline: string;
  checks: string;
}

export interface IntegrationHarness {
  /** The agent can invoke a named command itself (Claude's `Skill` tool); absent means yes. */
  readonly skillTool?: boolean;
  checkout(repo: TargetRepo): IntegrationWorkspace;
  runAgent(workspace: IntegrationWorkspace, prompt: string): Promise<void>;
  commitsSince(workspace: IntegrationWorkspace): string[];
  takeFile(workspace: IntegrationWorkspace, fileName: string): string | undefined;
  discardUncommitted(workspace: IntegrationWorkspace): string[];
  runChecks(workspace: IntegrationWorkspace): Promise<void>;
  push(workspace: IntegrationWorkspace): void;
  release(workspace: IntegrationWorkspace): void;
}

export interface IntegrationGit {
  createItemBranch(repo: TargetRepo, branch: string, baseBranch: string): void;
  worktreeFor(repo: TargetRepo, branch: string): string;
  dropWorktree(repo: TargetRepo, target: string): void;
}

export interface IntegrationAgent {
  stage: string;
  agent: ResolvedAgent;
  requiredCommands: readonly string[];
}

export interface IntegrationHarnessDeps {
  agent: IntegrationAgent;
  runner: CommandRunner;
  fs: FileSystemPort;
  layout: SandcastleLayout;
  config: OrchestratorConfig;
  git: IntegrationGit;
  parentNumber: number;
  integrationBranch: string;
  log: (message: string) => void;
  logs?: AttemptLogStore | undefined;
  now?: () => number;
}

export function commandsCheck(files: readonly string[]): string {
  return files.map((file) => `test -f ${CONTAINER_HOME}/.claude/commands/${file}`).join(" && ");
}

export class DockerIntegrationHarness implements IntegrationHarness {
  private sequence = 0;

  constructor(private readonly deps: IntegrationHarnessDeps) {}

  checkout(repo: TargetRepo): IntegrationWorkspace {
    this.deps.git.createItemBranch(repo, this.deps.integrationBranch, integrationBase());
    const worktree = this.deps.git.worktreeFor(repo, this.deps.integrationBranch);
    const baseline = this.git(worktree, ["rev-parse", "HEAD"]).trim();
    return { repo, worktree, baseline, checks: checkCommand(this.deps.config, repo) };
  }

  get skillTool(): boolean {
    return this.deps.agent.agent.provider.skillTool;
  }

  async runAgent(workspace: IntegrationWorkspace, prompt: string): Promise<void> {
    const { agent } = this.deps.agent;
    await ensureFreshLogin(this.deps, agent);
    await this.inSandbox(workspace, "bind", agent, async (container, log) => {
      await this.assertCommands(container, log);
      this.deps.log(`[${this.deps.agent.stage}] ${workspace.repo}: agent starting (idle budget ${this.deps.config.idleTimeoutSeconds}s, model ${describeAgent(agent)})`);
      await this.exec(container, agent.provider.command(agent.model), log, prompt);
    });
  }

  commitsSince(workspace: IntegrationWorkspace): string[] {
    return this.git(workspace.worktree, ["log", `${workspace.baseline}..HEAD`, "--format=%s"])
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  takeFile(workspace: IntegrationWorkspace, fileName: string): string | undefined {
    const file = join(workspace.worktree, fileName);
    const notes = this.deps.fs.readText(file);
    if (notes !== undefined) this.deps.fs.removeFile(file);
    return notes;
  }

  discardUncommitted(workspace: IntegrationWorkspace): string[] {
    const leftovers = this.git(workspace.worktree, ["status", "--porcelain"])
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (leftovers.length === 0) return [];
    this.git(workspace.worktree, ["reset", "--hard", "HEAD"]);
    this.git(workspace.worktree, ["clean", "-fd"]);
    return leftovers;
  }

  async runChecks(workspace: IntegrationWorkspace): Promise<void> {
    await this.inSandbox(workspace, "copy", undefined, async (container, log) => {
      this.deps.log(`[${this.deps.agent.stage}] ${workspace.repo}: re-running ${workspace.checks}`);
      const tail = outputTail(CHECK_OUTPUT_TAIL);
      try {
        await this.exec(container, workspace.checks, (chunk) => {
          tail.append(chunk);
          log(chunk);
        });
      } catch (cause) {
        throw new CheckFailure(workspace.checks, tail.text(), cause);
      }
    });
  }

  push(workspace: IntegrationWorkspace): void {
    this.git(workspace.worktree, ["push", "origin", `HEAD:refs/heads/${this.deps.integrationBranch}`]);
  }

  release(workspace: IntegrationWorkspace): void {
    try {
      this.deps.git.dropWorktree(workspace.repo, workspace.worktree);
    } catch (cause) {
      this.deps.log(`[${this.deps.agent.stage}][warn] could not drop ${workspace.worktree}: ${messageOf(cause)}`);
    }
  }

  private async assertCommands(container: string, log: (chunk: string) => void): Promise<void> {
    const files = this.deps.agent.requiredCommands;
    if (files.length === 0) return;
    await this.exec(container, commandsCheck(files), log).catch((cause: unknown) => {
      throw new Error(
        `~/.claude/commands/{${files.join(",")}} check failed (${messageOf(cause)}) — if they are missing from the agent home, run: sandcastle skills install`,
        { cause },
      );
    });
  }

  private async inSandbox(
    workspace: IntegrationWorkspace,
    mode: WorkspaceMode,
    agent: ResolvedAgent | undefined,
    work: (container: string, log: (chunk: string) => void) => Promise<void>,
  ): Promise<void> {
    const container = this.containerName();
    const provider = (agent ?? this.deps.agent.agent).provider;
    const login = agent ? snapshotCredential(this.deps.fs, this.deps.layout, provider) : undefined;
    const gitControl = startWorktreeContainer(this.deps, {
      name: container,
      repo: workspace.repo,
      worktree: workspace.worktree,
      workspace: mode,
      provider,
      branch: undefined,
    });
    const writer = this.deps.logs?.begin(this.deps.parentNumber, this.deps.agent.stage);
    const log = (chunk: string): void => writer?.write(chunk);
    log(`--- ${this.deps.agent.stage} ${workspace.repo} (${mode}) ---\n`);
    let outcome = "failure";
    try {
      await this.exec(container, provider.hydrateCommand(), log);
      execAsRoot(this.deps.runner, container, claimWorkspaceCommand(mode));
      if (mode === "copy") await this.exec(container, copyWorkspaceCommand(), log);
      await this.exec(container, bootstrapScript(this.deps.config, workspace.repo), log);
      await work(container, log);
      outcome = "success";
    } finally {
      writer?.finish(outcome);
      syncBackCredential(this.deps, container, login);
      this.removeQuietly(container);
      assertGitControlUnchanged(this.deps.fs, gitControl);
    }
  }

  private removeQuietly(container: string): void {
    try {
      removeContainer(this.deps.runner, container);
    } catch (cause) {
      this.deps.log(`[${this.deps.agent.stage}][warn] could not remove container ${container}: ${messageOf(cause)}`);
    }
  }

  private async exec(container: string, command: string, onOutput: (chunk: string) => void, input?: string): Promise<void> {
    await runWithIdleTimeout(
      this.deps.runner,
      execRequest(container, command, input === undefined ? { onOutput } : { input, onOutput }),
      this.deps.config.idleTimeoutSeconds,
    );
  }

  private git(cwd: string, args: readonly string[]): string {
    return this.deps.runner.run({ command: "git", args, cwd }).stdout;
  }

  private containerName(): string {
    this.sequence += 1;
    const stamp = `${(this.deps.now ?? Date.now)().toString(36)}${this.sequence.toString(36)}`;
    return stageContainerName(this.deps.agent.stage, this.deps.parentNumber, stamp);
  }
}

export type LandOutcome =
  | { kind: "unchanged" }
  | { kind: "pushed"; checks: string; subjects: string[] }
  | { kind: "reverted"; reason: string; subjects: string[]; evidence: string | undefined };

export interface LandRequest {
  harness: IntegrationHarness;
  repo: TargetRepo;
  stage: string;
  prompt: (workspace: IntegrationWorkspace) => string;
  collect?: (workspace: IntegrationWorkspace) => void;
  onLeftovers: (leftovers: readonly string[]) => void;
}

async function landInWorkspace(request: LandRequest, workspace: IntegrationWorkspace): Promise<LandOutcome> {
  const { harness, stage } = request;
  let agentFailure: string | undefined;
  try {
    await harness.runAgent(workspace, request.prompt(workspace));
  } catch (cause) {
    agentFailure = messageOf(cause);
  }
  const subjects = harness.commitsSince(workspace);
  request.collect?.(workspace);
  if (agentFailure) return { kind: "reverted", reason: `the ${stage} agent failed: ${agentFailure}`, subjects, evidence: undefined };
  if (subjects.length === 0) return { kind: "unchanged" };
  const leftovers = harness.discardUncommitted(workspace);
  if (leftovers.length > 0) request.onLeftovers(leftovers);
  try {
    await harness.runChecks(workspace);
  } catch (cause) {
    const evidence = cause instanceof CheckFailure ? cause.outputTail : undefined;
    return { kind: "reverted", reason: `\`${workspace.checks}\` went red after ${stage}: ${messageOf(cause)}`, subjects, evidence };
  }
  try {
    harness.push(workspace);
  } catch (cause) {
    return { kind: "reverted", reason: `the ${stage} commits could not be pushed: ${messageOf(cause)}`, subjects, evidence: undefined };
  }
  return { kind: "pushed", checks: workspace.checks, subjects };
}

export async function landAgentWork(request: LandRequest): Promise<LandOutcome> {
  let workspace: IntegrationWorkspace;
  try {
    workspace = request.harness.checkout(request.repo);
  } catch (cause) {
    return { kind: "reverted", reason: `the ${request.stage} worktree could not be prepared: ${messageOf(cause)}`, subjects: [], evidence: undefined };
  }
  try {
    return await landInWorkspace(request, workspace);
  } finally {
    request.harness.release(workspace);
  }
}
