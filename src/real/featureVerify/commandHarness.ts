import { join } from "node:path";
import type { TargetRepo } from "../../model/runModel.js";
import { integrationBase } from "../../project/projectConfig.js";
import { runWithIdleTimeout, type CommandRunner } from "../commandRunner.js";
import { execRequest, removeContainer, SANDBOX_WORKDIR, stageContainerName, startContainer } from "../docker.js";
import { checkCommand, parseEnvFile, perRepoValue, resolveSandboxEnvFile, type OrchestratorConfig } from "../env.js";
import type { FileSystemPort } from "../fileSystem.js";
import type { VerifyWorktrees } from "../gitOps.js";
import { CONTAINER_HOME, type SandcastleLayout } from "../paths.js";
import { claudeCommand, claudeHomeMounts, hydrateHomeCommand, outputTail, withContainerEnvFile } from "../sandboxRunner.js";
import {
  claimVerifyWorktree,
  COMPOSE_OUTPUT_TAIL,
  ComposeFailure,
  CONTAINER_REPORT_PATH,
  REPORT_FILE,
  SOURCE_MOUNT_ROOT,
  tearDown,
  type ComposeFacts,
  type ComposeService,
  type Disposable,
  type VerifyCommandRun,
  type VerifyHarness,
} from "./composeHarness.js";

export const READONLY_SOURCE_ROOT = `${CONTAINER_HOME}/sources-ro`;
export const COMMAND_PROMPT_TAIL = 3000;

export interface CommandHarnessDeps {
  runner: CommandRunner;
  fs: FileSystemPort;
  layout: SandcastleLayout;
  config: OrchestratorConfig;
  git: VerifyWorktrees;
  parentNumber: number;
  integrationBranch: string;
  involvedRepos: readonly TargetRepo[];
  log: (message: string) => void;
  now?: () => number;
}

export function copySourceCommand(repo: TargetRepo): string {
  const from = `${READONLY_SOURCE_ROOT}/${repo}`;
  const to = `${SOURCE_MOUNT_ROOT}/${repo}`;
  return `set -o pipefail && mkdir -p ${to} && tar -C ${from} --exclude=./node_modules --exclude=./.git -cf - . | tar -C ${to} -xf -`;
}

export function syntheticReport(commands: readonly VerifyCommandRun[]): string {
  return [
    "## Test plan",
    ...commands.map((entry) => `- \`${entry.command}\` in ${entry.repo} — covers the assembled feature building and passing its own suite`),
    "",
    "## Results",
    ...commands.map((entry) => `- PASS — \`${entry.command}\` in ${entry.repo} — exited 0 on the integration branch`),
    "",
    "## Notes",
    "verify.agent is off for this project: only the commands above ran. No scenario was derived from the acceptance criteria.",
  ].join("\n");
}

/**
 * The `command` verify strategy: one throwaway container holds a fresh copy of every involved repo's
 * integration branch, runs the project's verify commands there, and (unless verify.agent is false)
 * hands the same container to a fresh agent that checks each acceptance criterion. Nothing is served.
 */
export class CommandVerifyHarness implements VerifyHarness {
  private readonly disposables: Disposable[] = [];
  private container: string | undefined;
  private scratchDir: string | undefined;
  private commands: VerifyCommandRun[] = [];
  private sequence = 0;

  constructor(private readonly deps: CommandHarnessDeps) {}

  async up(): Promise<ComposeFacts> {
    const strategy = this.deps.config.verify;
    if (strategy.strategy !== "command") throw new Error(`CommandVerifyHarness needs verify.strategy "command", got "${strategy.strategy}"`);

    const scratch = this.deps.fs.makeTempDirectory("sandcastle-verify-");
    this.scratchDir = scratch;
    this.disposables.push({ label: `scratch ${scratch}`, dispose: () => this.deps.fs.removeDirectory(scratch) });

    const services: ComposeService[] = this.deps.involvedRepos.map((repo) => ({
      repo,
      ref: this.ref(repo),
      baseUrl: undefined,
      sourcePath: `${SOURCE_MOUNT_ROOT}/${repo}`,
    }));
    const worktrees = services.map((service) => ({ repo: service.repo, path: this.claimWorktree(service.repo, service.ref) }));

    const container = stageContainerName("fvcheck", this.deps.parentNumber, this.stamp());
    const env: Record<string, string> = { SANDCASTLE_REPORT_PATH: CONTAINER_REPORT_PATH, JEST_MAX_WORKERS: this.deps.config.jestWorkers };
    for (const repo of this.deps.involvedRepos) Object.assign(env, this.sandboxEnv(repo));
    if (this.deps.config.anthropicApiKey) env["ANTHROPIC_API_KEY"] = this.deps.config.anthropicApiKey;
    this.claim(
      `container ${container}`,
      () =>
        withContainerEnvFile(this.deps.fs, env, (envFile) =>
          startContainer(this.deps.runner, {
            name: container,
            image: this.deps.config.imageTag,
            workdir: SANDBOX_WORKDIR,
            mounts: [
              { hostPath: scratch, containerPath: SANDBOX_WORKDIR },
              ...worktrees.map((entry) => ({ hostPath: entry.path, containerPath: `${READONLY_SOURCE_ROOT}/${entry.repo}`, readonly: true })),
              ...claudeHomeMounts(this.deps.layout),
            ],
            envFile,
          }),
        ),
      () => removeContainer(this.deps.runner, container),
    );
    this.container = container;

    for (const service of services) {
      const repo = service.repo;
      const command = strategy.commands[repo] ?? checkCommand(this.deps.config, repo);
      const bootstrap = perRepoValue(this.deps.config.bootstrapCommands, repo, "bootstrap command").trim();
      await this.exec(copySourceCommand(repo), `${repo} copy integration branch`);
      if (bootstrap) await this.exec(`cd ${service.sourcePath} && ${bootstrap}`, `${repo} bootstrap`);
      const tail = await this.exec(`cd ${service.sourcePath} && ${command}`, `${repo} verify command`);
      this.commands.push({ repo, command, outputTail: tail.slice(-COMMAND_PROMPT_TAIL) });
    }

    return {
      network: "",
      environment: `a throwaway container holding fresh copies of ${services.map((service) => `\`${service.repo}\` @ \`${service.ref}\``).join(", ")} — nothing served, no database`,
      mongoUri: undefined,
      reportPath: CONTAINER_REPORT_PATH,
      services,
      commands: this.commands,
      externalProviders: [],
    };
  }

  async runAgent(prompt: string): Promise<void> {
    const container = this.container;
    if (!container) throw new Error("runAgent was called before up() — there is no feature verify container");
    const strategy = this.deps.config.verify;
    if (strategy.strategy === "command" && !strategy.agent) {
      this.deps.fs.writeText(join(this.scratchDir!, REPORT_FILE), syntheticReport(this.commands));
      this.deps.log("[feature-verify] verify.agent is off — the green commands are the report");
      return;
    }
    await this.exec(hydrateHomeCommand(), "agent home hydration");
    const idle = this.deps.config.idleTimeoutSeconds;
    this.deps.log(`[feature-verify] agent starting (idle budget ${idle}s, model ${this.deps.config.reviewModel})`);
    await runWithIdleTimeout(
      this.deps.runner,
      execRequest(container, claudeCommand(this.deps.config.reviewModel), { input: prompt, onOutput: () => undefined }),
      idle,
    );
  }

  readReport(): string | undefined {
    if (!this.scratchDir) return undefined;
    return this.deps.fs.readText(join(this.scratchDir, REPORT_FILE));
  }

  down(): void {
    tearDown(this.disposables, this.deps.log);
  }

  private ref(repo: TargetRepo): string {
    if (this.deps.git.remoteRefExists(repo, this.deps.integrationBranch)) return `origin/${this.deps.integrationBranch}`;
    throw new Error(
      `${repo} has work items in this run but no ${this.deps.integrationBranch} on origin — feature verify refuses to ` +
        `check origin/${integrationBase()} and call the result the feature.`,
    );
  }

  private claimWorktree(repo: TargetRepo, ref: string): string {
    return claimVerifyWorktree(this.deps.git, this.disposables, this.deps.integrationBranch, repo, ref);
  }

  private sandboxEnv(repo: TargetRepo): Record<string, string> {
    const path = resolveSandboxEnvFile(this.deps.fs, this.deps.layout, repo);
    return parseEnvFile(this.deps.fs.readText(path) ?? "");
  }

  private async exec(command: string, step: string): Promise<string> {
    this.deps.log(`[feature-verify] ${step}`);
    const tail = outputTail(COMPOSE_OUTPUT_TAIL);
    try {
      await runWithIdleTimeout(
        this.deps.runner,
        execRequest(this.container!, command, { onOutput: tail.append }),
        this.deps.config.idleTimeoutSeconds,
      );
    } catch (cause) {
      throw new ComposeFailure(step, tail.text(), cause);
    }
    return tail.text();
  }

  private claim(label: string, create: () => void, dispose: () => void): void {
    this.disposables.push({ label, dispose });
    create();
  }

  private stamp(): string {
    this.sequence += 1;
    return `${(this.deps.now ?? Date.now)().toString(36)}${this.sequence.toString(36)}`;
  }
}

/** The `none` verify strategy: each item's own gate is the only check, so the report says exactly that. */
export class NoVerifyHarness implements VerifyHarness {
  constructor(private readonly deps: { integrationBranch: string; involvedRepos: readonly TargetRepo[]; log: (message: string) => void }) {}

  async up(): Promise<ComposeFacts> {
    this.deps.log('[feature-verify] verify.strategy is "none" — no environment, no agent');
    return {
      network: "",
      environment: 'nothing — verify.strategy is "none", so each item\'s own checks were the only verification',
      mongoUri: undefined,
      reportPath: CONTAINER_REPORT_PATH,
      services: this.deps.involvedRepos.map((repo) => ({
        repo,
        ref: `origin/${this.deps.integrationBranch}`,
        baseUrl: undefined,
        sourcePath: "",
      })),
    };
  }

  async runAgent(): Promise<void> {}

  readReport(): string {
    return [
      "## Results",
      `- PASS — every Work Item merged into \`${this.deps.integrationBranch}\` through its own develop → simplify → review → verify gate`,
      "",
      "## Notes",
      'verify.strategy is "none": the assembled feature was not exercised as a whole. Check it by hand before merging.',
    ].join("\n");
  }

  down(): void {}
}
