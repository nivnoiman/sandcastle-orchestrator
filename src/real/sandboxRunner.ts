import { join } from "node:path";
import { assertGitControlUnchanged, releaseGitControl, snapshotGitControl, type GitControlSnapshot } from "./gitGuard.js";
import type {
  CommandStageRequest,
  SandboxRunner,
  ResolveRequest,
  ReworkContext,
  ReworkRequest,
  SpawnRequest,
  StageCompletion,
  StageName,
  StageOutcome,
  VerifyRequest,
} from "../engine/adapters.js";
import { reworkRoundOf } from "../engine/rework.js";
import { boundedTail, fencedBlock } from "../markdown.js";
import type { TargetRepo } from "../model/runModel.js";
import { agentWaitFrom, commandFailureDetail, isAgentWait, transientWaitFrom } from "./agentFailure.js";
import type { AttemptLogStore, AttemptWriter } from "./attemptLog.js";
import {
  isAgentIdleTimeout,
  runWithIdleTimeout,
  type CommandRunner,
} from "./commandRunner.js";
import {
  claudeProvider,
  defaultAgent,
  describeAgent,
  resolveAgent,
  resolveStageAgent,
  snapshotCredential,
  syncBackCredential,
  type AgentProvider,
  type ResolvedAgent,
} from "./agents/index.js";
import { ensureFreshLogin } from "./authProbe.js";
import {
  assertDockerReady,
  execAsRoot,
  execRequest,
  removeContainer,
  stageContainerName,
  startContainer,
  SANDBOX_WORKDIR,
  withContainerEnvFile,
  type ContainerSpec,
} from "./docker.js";
import { bootstrapScript, checkCommand, salvageIdleTimeout, type OrchestratorConfig } from "./env.js";
import type { FileSystemPort } from "./fileSystem.js";
import { commitSubjectsAhead, countCommitsAhead, isRebasedOnto, resolveGitDir } from "./gitOps.js";
import type { PullRequestOps } from "./ghClient.js";
import { CONTAINER_HOME, repoRoot, toDockerPath, worktreePath, type SandcastleLayout } from "./paths.js";
import {
  buildResolvePrompt,
  buildSalvagePrompt,
  buildStagePrompt,
  pullRequestTitle,
  renderStageInstructions,
  type StagePromptContext,
} from "./promptBuilder.js";
import type { RunContext } from "./runContext.js";
import {
  hasPrSection,
  hasTestFirstCommit,
  isFreshEyesStage,
  needsReworkStory,
  orphanedStageSection,
  prSectionHeading,
  reworkBriefSection,
  reworkBriefSentinel,
  prSectionMarker,
  stageCommitTag,
  taggedCommitSubjects,
  unfixableReason,
  type FreshEyesStage,
} from "./stageAudit.js";
import { messageOf } from "../messageOf.js";

export {
  claudeCommand,
  claudeHomeMounts,
  CONTAINER_AUTOCRLF,
  HOST_CLAUDE_DIR,
  HOST_CLAUDE_JSON,
  HYDRATE_COPIED_ENTRIES,
  hydrateHomeCommand,
} from "./agents/claude.js";
export { withContainerEnvFile };

export const CONTAINER_GITDIR = "/home/agent/gitdir";
export const CHECK_OUTPUT_TAIL = 4000;
const VERIFY_STORY_OUTPUT_LIMIT = 3000;
export const SOURCE_DIR = `${CONTAINER_HOME}/source`;
export const CONTAINER_LOCAL_ENTRIES = ["node_modules", ".jest-cache"] as const;

export type WorkspaceMode = "bind" | "copy";

const GIT_DIR_MARKER = "/.git/";
const AGENT_IDENTITY = { name: "sandcastle agent", email: "noreply@anthropic.com" };

export interface SandboxRunnerDeps {
  runner: CommandRunner;
  fs: FileSystemPort;
  layout: SandcastleLayout;
  config: OrchestratorConfig;
  gh: PullRequestOps;
  context: RunContext;
  log: (message: string) => void;
  warn: (itemNumber: number, message: string) => void;
  onComplete: (completion: StageCompletion) => void;
  logs?: AttemptLogStore | undefined;
  now?: () => number;
}

interface SalvageDecision {
  kind: "run" | "skip" | "abandon";
  reason: string;
}

interface StageResult {
  outcome: StageOutcome;
  pullRequestUrl?: string;
  resolved?: boolean;
  detail?: string;
  rework?: ReworkRequest;
}

export class StageCancelledError extends Error {
  constructor(readonly attempt: string) {
    super(`stage attempt ${attempt} was cancelled by the operator`);
    this.name = "StageCancelledError";
  }
}

export class CheckFailure extends Error {
  constructor(
    readonly checks: string,
    readonly outputTail: string,
    cause: unknown,
  ) {
    super(`checks failed (${checks}): ${messageOf(cause)}`);
    this.name = "CheckFailure";
  }
}

export function verifyReworkStory(request: VerifyRequest, failure: CheckFailure, subjects: readonly string[]): string {
  const commits = subjects.length > 0 ? subjects.map((subject) => `- \`${subject}\``) : ["- _none found_"];
  const output = failure.outputTail.trim() || failure.message;
  return [
    "### What happened",
    `The verify gate rebased \`${request.branch}\` onto \`origin/${request.integrationBranch}\`, copied it into a clean container, and ran the merge checks: \`${failure.checks}\`. They failed, so the item cannot merge.`,
    "",
    "### Why it matters",
    `Nothing merges into \`${request.integrationBranch}\` red: every sibling item builds on top of it, and Feature Verify tests the assembled result. A check that fails only after the rebase means the branch no longer fits what siblings already merged.`,
    "",
    "### What the branch contains (newest first)",
    ...commits,
    "",
    "### Evidence — the last output of the checks",
    fencedBlock(boundedTail(output, VERIFY_STORY_OUTPUT_LIMIT)),
    "",
    "### What a fix must achieve",
    `\`${failure.checks}\` passes on top of \`origin/${request.integrationBranch}\`, without skipping, deleting or weakening a test, a lint rule or a type.`,
  ].join("\n");
}

export function commandReworkStory(request: CommandStageRequest, failure: CheckFailure, subjects: readonly string[]): string {
  const commits = subjects.length > 0 ? subjects.map((subject) => `- \`${subject}\``) : ["- _none found_"];
  const output = failure.outputTail.trim() || failure.message;
  return [
    "### What happened",
    `The \`${request.stage}\` stage copied \`${request.branch}\` into a clean container and ran \`${failure.checks}\`. It failed, so the item cannot move on to the verify gate.`,
    "",
    "### Why it matters",
    `This project gates every item on \`${request.stage}\`. Red here means the change breaks what that check protects.`,
    "",
    "### What the branch contains (newest first)",
    ...commits,
    "",
    "### Evidence — the last output of the command",
    fencedBlock(boundedTail(output, VERIFY_STORY_OUTPUT_LIMIT)),
    "",
    "### What a fix must achieve",
    `\`${failure.checks}\` passes on \`${request.branch}\`, without skipping, deleting or weakening a test, a lint rule or a type.`,
  ].join("\n");
}

export function commandTrailSection(request: CommandStageRequest, round: number): string {
  return ["", prSectionMarker(request.stage, round), "", `\`${request.command}\` passed in a clean container.`, ""].join("\n");
}

export function containerGitDir(absoluteGitDir: string): string {
  const normalized = toDockerPath(absoluteGitDir);
  const marker = normalized.lastIndexOf(GIT_DIR_MARKER);
  if (marker < 0) {
    throw new Error(
      `git dir "${absoluteGitDir}" is not inside the repo's .git directory — sandcastle only mounts <repo>/.git into the container`,
    );
  }
  return `${CONTAINER_GITDIR}/${normalized.slice(marker + GIT_DIR_MARKER.length)}`;
}

export function containerEnv(
  config: OrchestratorConfig,
  gitDir: string,
  provider: AgentProvider = defaultAgent(config).provider,
): Record<string, string> {
  const env: Record<string, string> = {
    ...(config.ghToken ? { GH_TOKEN: config.ghToken } : {}),
    GIT_DIR: gitDir,
    GIT_WORK_TREE: SANDBOX_WORKDIR,
    GIT_AUTHOR_NAME: AGENT_IDENTITY.name,
    GIT_AUTHOR_EMAIL: AGENT_IDENTITY.email,
    GIT_COMMITTER_NAME: AGENT_IDENTITY.name,
    GIT_COMMITTER_EMAIL: AGENT_IDENTITY.email,
    JEST_MAX_WORKERS: config.jestWorkers,
  };
  Object.assign(env, provider.authEnv(config));
  return env;
}

export function containerSpec(options: {
  name: string;
  image: string;
  worktree: string;
  repoGitDir: string;
  layout: SandcastleLayout;
  envFile: string;
  workspace: WorkspaceMode;
  provider?: AgentProvider;
}): ContainerSpec {
  const copied = options.workspace === "copy";
  const provider = options.provider ?? claudeProvider;
  return {
    name: options.name,
    image: options.image,
    workdir: SANDBOX_WORKDIR,
    mounts: [
      copied
        ? { hostPath: options.worktree, containerPath: SOURCE_DIR, readonly: true }
        : { hostPath: options.worktree, containerPath: SANDBOX_WORKDIR },
      { hostPath: options.repoGitDir, containerPath: CONTAINER_GITDIR },
      ...provider.homeMounts(options.layout),
    ],
    anonymousVolumes: copied ? [] : containerLocalPaths(),
    envFile: options.envFile,
  };
}

export function containerLocalPaths(): string[] {
  return CONTAINER_LOCAL_ENTRIES.map((entry) => `${SANDBOX_WORKDIR}/${entry}`);
}

export function claimWorkspaceCommand(workspace: WorkspaceMode): string {
  const owned = workspace === "copy" ? [SANDBOX_WORKDIR] : containerLocalPaths();
  return `mkdir -p ${owned.join(" ")} && chown agent:agent ${owned.join(" ")}`;
}

export function copyWorkspaceCommand(): string {
  const excludes = CONTAINER_LOCAL_ENTRIES.map((entry) => `--exclude=./${entry}`).join(" ");
  return `set -o pipefail && tar -C ${SOURCE_DIR} ${excludes} -cf - . | tar -C ${SANDBOX_WORKDIR} -xf -`;
}

/** Starts a stage container over a worktree; returns the repo's git-control snapshot to assert unchanged on teardown. */
export function startWorktreeContainer(
  deps: { runner: CommandRunner; fs: FileSystemPort; layout: SandcastleLayout; config: OrchestratorConfig },
  container: { name: string; repo: TargetRepo; worktree: string; workspace: WorkspaceMode; provider: AgentProvider; branch: string | undefined },
): GitControlSnapshot {
  const repoGitDir = join(repoRoot(deps.layout, container.repo), ".git");
  const gitControl = snapshotGitControl(deps.fs, repoGitDir, container.branch);
  const env = containerEnv(deps.config, containerGitDir(resolveGitDir(deps.runner, container.worktree)), container.provider);
  try {
    withContainerEnvFile(deps.fs, env, (envFile) => {
      startContainer(
        deps.runner,
        containerSpec({
          name: container.name,
          image: deps.config.imageTag,
          worktree: container.worktree,
          repoGitDir,
          layout: deps.layout,
          envFile,
          workspace: container.workspace,
          provider: container.provider,
        }),
      );
    });
  } catch (cause) {
    releaseGitControl(gitControl);
    throw cause;
  }
  return gitControl;
}

export function outputTail(limit: number): { append: (chunk: string) => void; text: () => string } {
  let collected = "";
  return {
    append: (chunk) => {
      collected = (collected + chunk).slice(-limit);
    },
    text: () => collected,
  };
}

export class DockerSandboxRunner implements SandboxRunner {
  private dockerChecked = false;
  private containerSequence = 0;
  private attemptSequence = 0;
  private readonly currentAttempt = new Map<number, string>();
  private readonly cancelledAttempts = new Set<string>();
  private readonly attemptContainers = new Map<string, string>();
  private readonly attemptLogs = new Map<string, AttemptWriter>();

  constructor(private readonly deps: SandboxRunnerDeps) {}

  spawnStage(request: SpawnRequest): void {
    this.deps.context.rememberBranch(request.itemNumber, request.branch);
    this.launch(request.itemNumber, request.stage, (attempt) => this.runAgentStage(request, attempt));
  }

  spawnCommandStage(request: CommandStageRequest): void {
    this.deps.context.rememberBranch(request.itemNumber, request.branch);
    this.launch(request.itemNumber, request.stage, (attempt) => this.runCommandStage(request, attempt));
  }

  spawnResolve(request: ResolveRequest): void {
    this.deps.context.rememberBranch(request.itemNumber, request.branch);
    this.launch(request.itemNumber, "verify", (attempt) => this.runResolve(request, attempt), "resolve");
  }

  kill(itemNumber: number): void {
    const attempt = this.currentAttempt.get(itemNumber);
    if (!attempt) {
      this.deps.log(`#${itemNumber} cancelled but no stage attempt of its own is in flight`);
      return;
    }
    this.cancelledAttempts.add(attempt);
    const container = this.attemptContainers.get(attempt);
    if (!container) {
      this.deps.log(`#${itemNumber} cancelled between containers — the next one is torn down as it starts`);
      return;
    }
    this.attemptContainers.delete(attempt);
    this.deps.log(`#${itemNumber} cancelled — removing ${container}`);
    try {
      removeContainer(this.deps.runner, container);
    } catch (cause) {
      this.attemptContainers.set(attempt, container);
      this.deps.log(`[warn] could not remove ${container} on cancel — the stage teardown retries it: ${messageOf(cause)}`);
    }
  }

  runChecks(request: VerifyRequest): void {
    this.deps.context.rememberBranch(request.itemNumber, request.branch);
    this.launch(request.itemNumber, "verify", (attempt) => this.runVerify(request, attempt));
  }

  private launch(
    itemNumber: number,
    stage: StageName,
    work: (attempt: string) => Promise<StageResult>,
    logStage: string = stage,
  ): void {
    const attempt = this.beginAttempt(itemNumber, logStage);
    void work(attempt).then(
      (result) => {
        this.finishLog(attempt, result.outcome);
        this.report(attempt, { itemNumber, stage, ...result });
      },
      (cause: unknown) => {
        if (this.cancelledAttempts.has(attempt)) {
          this.finishLog(attempt, "cancelled");
          this.report(attempt, { itemNumber, stage, outcome: "failure" });
          return;
        }
        if (isAgentWait(cause)) {
          this.finishLog(attempt, `waiting:${cause.reason}`);
          this.deps.log(`#${itemNumber} ${stage} hit ${cause.reason}: ${cause.message}`);
          this.report(attempt, {
            itemNumber,
            stage,
            outcome: "waiting",
            waitReason: cause.reason,
            ...(cause.resumeAt === undefined ? {} : { resumeAt: cause.resumeAt }),
            detail: cause.detail,
          });
          return;
        }
        const detail = this.describe(cause);
        this.finishLog(attempt, "failure");
        this.deps.warn(itemNumber, `${stage} stage failed: ${detail}`);
        this.report(attempt, { itemNumber, stage, outcome: "failure", detail });
      },
    );
  }

  private beginAttempt(itemNumber: number, logStage: string): string {
    this.attemptSequence += 1;
    const attempt = `${itemNumber}#${this.attemptSequence}`;
    this.currentAttempt.set(itemNumber, attempt);
    const writer = this.deps.logs?.begin(itemNumber, logStage);
    if (writer) this.attemptLogs.set(attempt, writer);
    return attempt;
  }

  private finishLog(attempt: string, outcome: string): void {
    const writer = this.attemptLogs.get(attempt);
    if (!writer) return;
    this.attemptLogs.delete(attempt);
    writer.finish(outcome);
  }

  private tee(attempt: string, prefix: string): (chunk: string) => void {
    const writer = this.attemptLogs.get(attempt);
    if (!writer) return () => undefined;
    writer.write(prefix);
    return (chunk) => writer.write(chunk);
  }

  private assertLive(attempt: string): void {
    if (this.cancelledAttempts.has(attempt)) throw new StageCancelledError(attempt);
  }

  private describe(cause: unknown): string {
    const reason = messageOf(cause).slice(0, 400);
    if (cause instanceof CheckFailure) {
      return cause.outputTail.length === 0 ? reason : `${reason}\n--- last output ---\n${cause.outputTail}`;
    }
    const detail = commandFailureDetail(cause);
    return detail ? `${reason}\n--- last output ---\n${detail}` : reason;
  }

  private report(attempt: string, completion: StageCompletion): void {
    if (this.currentAttempt.get(completion.itemNumber) === attempt) this.currentAttempt.delete(completion.itemNumber);
    this.attemptContainers.delete(attempt);
    if (this.cancelledAttempts.delete(attempt)) {
      this.deps.log(`#${completion.itemNumber} ${completion.stage} completion dropped — that attempt was cancelled`);
      return;
    }
    try {
      this.deps.onComplete(completion);
    } catch (cause) {
      const reason = messageOf(cause);
      this.deps.log(`[error] engine rejected completion of ${completion.stage} #${completion.itemNumber}: ${reason}`);
    }
  }

  private async runAgentStage(request: SpawnRequest, attempt: string): Promise<StageResult> {
    const prompt = buildStagePrompt(this.stagePromptContext(request));
    const worktree = this.requireWorktree(request.repo, request.branch);
    const baseline = this.prepareRework(request, worktree);

    const agent = resolveStageAgent(this.deps.config, request.stage);
    try {
      await this.inContainer(request.stage, attempt, request, worktree, agent, async (container) => {
        await this.bootstrap(container, request.repo, request.itemNumber, attempt);
        await this.runAgent(container, prompt, agent, this.deps.config.idleTimeoutSeconds, request.itemNumber, attempt);
      });
    } catch (cause) {
      if (!isAgentIdleTimeout(cause)) throw cause;
      await this.salvage(request, attempt, worktree, cause, baseline);
    }

    this.assertLive(attempt);
    this.pushLocalBranch(worktree, request.branch);
    return this.settleOutcome(request, worktree, baseline);
  }

  /** The local Tracker's origin is a path on this host the container cannot reach, so the host pushes what the agent committed. */
  private pushLocalBranch(worktree: string, branch: string): void {
    if (this.deps.config.tracker !== "local") return;
    this.deps.runner.run({ command: "git", args: ["push", "--force-with-lease", "origin", branch], cwd: worktree });
  }

  private stagePromptContext(request: SpawnRequest): StagePromptContext {
    const context = this.deps.context.promptContext(request);
    const spec = this.deps.config.stages.find((stage) => stage.name === request.stage);
    if (spec?.kind !== "agent") return context;
    const text = this.readPromptFileUncached(spec.name, spec.promptPath);
    const stageInstructions = renderStageInstructions(text, context, `stage ${spec.name} prompt (${spec.promptPath})`);
    return { ...context, stageInstructions };
  }

  private readPromptFileUncached(stageName: string, promptPath: string): string {
    const text = this.deps.fs.readText(promptPath);
    if (text === undefined) throw new Error(`the ${stageName} stage prompt ${promptPath} is missing`);
    return text;
  }

  private async salvage(request: SpawnRequest, attempt: string, worktree: string, cause: unknown, baseline: number | undefined): Promise<void> {
    const decision = this.salvageDecision(request, worktree, baseline);
    if (decision.kind !== "run") {
      this.deps.warn(request.itemNumber, decision.reason);
      if (decision.kind === "abandon") throw cause;
      return;
    }
    const budget = salvageIdleTimeout(this.deps.config.idleTimeoutSeconds);
    this.deps.warn(
      request.itemNumber,
      `${decision.reason} — running a constrained salvage pass in a fresh container (${budget}s idle budget)`,
    );
    const prompt = buildSalvagePrompt(this.stagePromptContext(request));
    const agent = resolveStageAgent(this.deps.config, request.stage);
    try {
      await this.inContainer("salvage", attempt, request, worktree, agent, async (container) => {
        await this.bootstrap(container, request.repo, request.itemNumber, attempt);
        await this.runAgent(container, prompt, agent, budget, request.itemNumber, attempt);
      });
    } catch (salvageCause) {
      if (isAgentWait(salvageCause)) throw salvageCause;
      const reason = messageOf(salvageCause);
      throw new Error(`${request.stage} idle-timed out; salvage pass also failed: ${reason.slice(0, 300)}`);
    }
  }

  private salvageDecision(request: SpawnRequest, worktree: string, baseline: number | undefined): SalvageDecision {
    const stage = request.stage;
    if (isFreshEyesStage(stage)) return this.freshEyesSalvageDecision(request, stage);
    if (baseline !== undefined) return this.reworkSalvageDecision(request, worktree, baseline);
    const commits = countCommitsAhead(this.deps.runner, worktree, request.integrationBranch);
    if (commits === 0) return { kind: "abandon", reason: "agent idle-timed out with 0 commits — nothing to salvage" };
    if (this.deps.gh.findPullRequest(request.repo, request.branch)) {
      return { kind: "skip", reason: "agent idle-timed out after opening its pull request — treating the stage as done" };
    }
    return { kind: "run", reason: `agent idle-timed out with ${commits} commit(s) on ${request.branch}` };
  }

  private reworkSalvageDecision(request: SpawnRequest, worktree: string, baseline: number): SalvageDecision {
    const round = reworkRoundOf(request);
    const pullRequest = this.deps.gh.findPullRequest(request.repo, request.branch);
    if (pullRequest && hasPrSection(pullRequest.body, "develop", round)) {
      return { kind: "skip", reason: `agent idle-timed out after recording rework round ${round} — treating the stage as done` };
    }
    const landed = countCommitsAhead(this.deps.runner, worktree, request.integrationBranch) - baseline;
    if (landed <= 0) {
      return { kind: "abandon", reason: `agent idle-timed out with no rework round ${round} commits — nothing to salvage` };
    }
    return { kind: "run", reason: `agent idle-timed out with ${landed} rework round ${round} commit(s) on ${request.branch}` };
  }

  private freshEyesSalvageDecision(request: SpawnRequest, stage: FreshEyesStage): SalvageDecision {
    const round = reworkRoundOf(request);
    const section = prSectionHeading(stage, round);
    const pullRequest = this.deps.gh.findPullRequest(request.repo, request.branch);
    if (!pullRequest) {
      return {
        kind: "abandon",
        reason: `agent idle-timed out and ${request.branch} has no pull request to finish — nothing to salvage`,
      };
    }
    if (hasPrSection(pullRequest.body, stage, round)) {
      return {
        kind: "skip",
        reason: `agent idle-timed out after appending its "${section}" section — treating the stage as done`,
      };
    }
    return { kind: "run", reason: `agent idle-timed out before "${section}" reached ${pullRequest.url}` };
  }

  private settleOutcome(request: SpawnRequest, worktree: string, baseline: number | undefined): StageResult {
    const stage = request.stage;
    if (isFreshEyesStage(stage)) return this.settleFreshEyesOutcome(request, stage, worktree, baseline);
    if (baseline !== undefined) return this.settleReworkOutcome(request, worktree, baseline);
    return this.settleDevelopOutcome(request, worktree);
  }

  private settleFreshEyesOutcome(
    request: SpawnRequest,
    stage: FreshEyesStage,
    worktree: string,
    baseline: number | undefined,
  ): StageResult {
    const round = reworkRoundOf(request);
    const section = prSectionHeading(stage, round);
    const pullRequest = this.deps.gh.findPullRequest(request.repo, request.branch);
    if (!pullRequest) {
      this.deps.warn(
        request.itemNumber,
        `no pull request on ${request.branch} — the ${stage} stage has nothing to record "${section}" on`,
      );
      return { outcome: "failure" };
    }
    const unfixable = unfixableReason(pullRequest.body, stage, round);
    if (unfixable) {
      throw new Error(`${stage} declared the work unfixable in place on ${pullRequest.url}: ${unfixable}`);
    }
    const story = stage === "simplify" ? undefined : needsReworkStory(pullRequest.body, round, stage);
    if (story) {
      this.deps.log(`#${request.itemNumber} ${stage} asked for rework on ${pullRequest.url}`);
      return {
        outcome: "failure",
        detail: `${stage} asked for rework on ${pullRequest.url}`,
        rework: { source: stage, story },
      };
    }
    if (hasPrSection(pullRequest.body, stage, round)) {
      this.deps.log(`#${request.itemNumber} ${stage} done: ${pullRequest.url}`);
      return { outcome: "success" };
    }
    const tag = stageCommitTag(stage);
    const subjects = taggedCommitSubjects(this.subjectsSince(request, worktree, baseline), stage);
    if (subjects.length === 0) {
      this.deps.warn(
        request.itemNumber,
        `no \`${tag}\` commits and no "${section}" section on ${pullRequest.url} — the ${stage} stage left no evidence it ran`,
      );
      return { outcome: "failure" };
    }
    this.deps.gh.appendToPullRequestBody(request.repo, pullRequest, orphanedStageSection(stage, subjects, round));
    this.deps.warn(
      request.itemNumber,
      `${subjects.length} \`${tag}\` commit(s) landed but the ${stage} agent wrote no "${section}" section — the orchestrator appended one to ${pullRequest.url}`,
    );
    this.deps.log(`#${request.itemNumber} ${stage} done (orchestrator-recorded): ${pullRequest.url}`);
    return { outcome: "success" };
  }

  private subjectsSince(request: SpawnRequest, worktree: string, baseline: number | undefined): string[] {
    const subjects = commitSubjectsAhead(this.deps.runner, worktree, request.integrationBranch);
    if (baseline === undefined) return subjects;
    return subjects.slice(0, Math.max(0, subjects.length - baseline));
  }

  private prepareRework(request: SpawnRequest, worktree: string): number | undefined {
    const rework = request.rework;
    if (!rework) return undefined;
    const baseline = countCommitsAhead(this.deps.runner, worktree, request.integrationBranch);
    if (request.stage === "develop") this.recordReworkBrief(request, rework);
    return baseline;
  }

  private recordReworkBrief(request: SpawnRequest, rework: ReworkContext): void {
    const brief = rework.briefs.find((candidate) => candidate.round === rework.round);
    if (!brief) throw new Error(`rework round ${rework.round} of #${request.itemNumber} carries no brief for itself`);
    const pullRequest = this.deps.gh.findPullRequest(request.repo, request.branch);
    if (!pullRequest) {
      throw new Error(`rework round ${rework.round} needs the open pull request on ${request.branch}, and there is none`);
    }
    if (pullRequest.body.includes(reworkBriefSentinel(rework.round))) return;
    this.deps.gh.appendToPullRequestBody(request.repo, pullRequest, reworkBriefSection(brief, rework.limit));
  }

  private settleReworkOutcome(request: SpawnRequest, worktree: string, baseline: number): StageResult {
    const round = reworkRoundOf(request);
    const pullRequest = this.deps.gh.findPullRequest(request.repo, request.branch);
    if (!pullRequest) {
      this.deps.warn(request.itemNumber, `rework round ${round} left no pull request on ${request.branch}`);
      return { outcome: "failure" };
    }
    if (hasPrSection(pullRequest.body, "develop", round)) {
      this.deps.log(`#${request.itemNumber} rework round ${round} done: ${pullRequest.url}`);
      return { outcome: "success", pullRequestUrl: pullRequest.url };
    }
    const subjects = this.subjectsSince(request, worktree, baseline);
    if (subjects.length === 0) {
      this.deps.warn(
        request.itemNumber,
        `rework round ${round} landed no commits and no "${prSectionHeading("develop", round)}" section — nothing was fixed`,
      );
      return { outcome: "failure" };
    }
    this.deps.gh.appendToPullRequestBody(request.repo, pullRequest, orphanedStageSection("develop", subjects, round));
    this.deps.warn(
      request.itemNumber,
      `rework round ${round} landed ${subjects.length} commit(s) without its section — the orchestrator appended one to ${pullRequest.url}`,
    );
    return { outcome: "success", pullRequestUrl: pullRequest.url };
  }

  private settleDevelopOutcome(request: SpawnRequest, worktree: string): StageResult {
    const commits = countCommitsAhead(this.deps.runner, worktree, request.integrationBranch);
    if (commits === 0) {
      this.deps.warn(request.itemNumber, `no commits landed on ${request.branch} — nothing to open a pull request for`);
      return { outcome: "failure" };
    }
    this.warnWithoutTestFirstCommit(request, worktree);
    const existing = this.deps.gh.findPullRequest(request.repo, request.branch);
    if (existing) {
      this.deps.log(`#${request.itemNumber} develop done: ${existing.url}`);
      return { outcome: "success", pullRequestUrl: existing.url };
    }
    const local = this.deps.config.tracker === "local";
    this.deps.warn(
      request.itemNumber,
      local
        ? `agent left commits but no pull-request record — recording it for ${request.branch}`
        : "agent left commits but no pull request — opening the draft pull request for it",
    );
    this.deps.runner.run({ command: "git", args: ["push", "-u", "origin", request.branch], cwd: worktree });
    const item = this.deps.context.item(request.itemNumber);
    const created = this.deps.gh.createDraftPullRequest({
      repo: request.repo,
      branch: request.branch,
      baseBranch: request.integrationBranch,
      title: pullRequestTitle(item),
      body: [
        "## What changed",
        `${commits} commit(s) from the sandcastle develop stage.`,
        "",
        "## How tested",
        "_the develop agent stopped before writing this — check the commits before merging_",
        ...(local ? [] : ["", `Closes ${this.deps.config.hubRepo}#${request.itemNumber}`]),
      ].join("\n"),
    });
    this.deps.log(`#${request.itemNumber} develop done (orchestrator-opened): ${created.url}`);
    return { outcome: "success", pullRequestUrl: created.url };
  }

  private warnWithoutTestFirstCommit(request: SpawnRequest, worktree: string): void {
    const subjects = commitSubjectsAhead(this.deps.runner, worktree, request.integrationBranch);
    if (hasTestFirstCommit(subjects)) return;
    this.deps.warn(
      request.itemNumber,
      `no \`test:\` commit on ${request.branch} — the develop agent did not commit failing tests first; check "How tested" for a \`no test:\` reason`,
    );
  }

  private async runResolve(request: ResolveRequest, attempt: string): Promise<StageResult> {
    const worktree = this.requireWorktree(request.repo, request.branch);
    const budget = salvageIdleTimeout(this.deps.config.idleTimeoutSeconds);
    const prompt = buildResolvePrompt(this.deps.context.resolveContext(request), request.files);
    this.deps.log(
      `#${request.itemNumber} resolve: ${request.files.length} conflicting file(s) against ${request.integrationBranch}` +
        ` (${budget}s idle budget)`,
    );
    const agent = resolveAgent(this.deps.config, "resolve");
    await this.inContainer("resolve", attempt, request, worktree, agent, async (container) => {
      await this.bootstrap(container, request.repo, request.itemNumber, attempt);
      await this.runAgent(container, prompt, agent, budget, request.itemNumber, attempt);
    });
    this.assertLive(attempt);
    if (!isRebasedOnto(this.deps.runner, worktree, request.integrationBranch)) {
      throw new Error(
        `the resolve pass left ${request.branch} off the tip of origin/${request.integrationBranch} —` +
          " the conflict is still there",
      );
    }
    this.pushLocalBranch(worktree, request.branch);
    this.deps.log(`#${request.itemNumber} resolve done — ${request.branch} sits on ${request.integrationBranch} again`);
    return { outcome: "success", resolved: true };
  }

  private async runVerify(request: VerifyRequest, attempt: string): Promise<StageResult> {
    try {
      return await this.runVerifyChecks(request, attempt);
    } catch (cause) {
      return this.reworkOnRed(request, attempt, cause, "verify gate", (failure, subjects) => ({
        source: "verify",
        story: verifyReworkStory(request, failure, subjects),
      }));
    }
  }

  private async runCommandStage(request: CommandStageRequest, attempt: string): Promise<StageResult> {
    try {
      await this.runInCleanCopy(request.stage, attempt, request, request.command);
    } catch (cause) {
      return this.reworkOnRed(request, attempt, cause, request.stage, (failure, subjects) => ({
        source: request.stage,
        story: commandReworkStory(request, failure, subjects),
      }));
    }
    this.recordGreenSectionForResume(request);
    this.deps.log(`#${request.itemNumber} ${request.stage} green: ${request.command}`);
    return { outcome: "success" };
  }

  private reworkOnRed(
    request: VerifyRequest,
    attempt: string,
    cause: unknown,
    what: string,
    rework: (failure: CheckFailure, subjects: readonly string[]) => ReworkRequest,
  ): StageResult {
    if (!this.isReworkableRed(cause, attempt)) throw cause;
    const worktree = this.requireWorktree(request.repo, request.branch);
    const subjects = commitSubjectsAhead(this.deps.runner, worktree, request.integrationBranch);
    this.deps.warn(request.itemNumber, `${what} red — sending it back to develop: ${cause.message.slice(0, 300)}`);
    return { outcome: "failure", detail: this.describe(cause), rework: rework(cause, subjects) };
  }

  private isReworkableRed(cause: unknown, attempt: string): cause is CheckFailure {
    return cause instanceof CheckFailure && !this.cancelledAttempts.has(attempt);
  }

  private recordGreenSectionForResume(request: CommandStageRequest): void {
    const round = reworkRoundOf(request);
    const pullRequest = this.deps.gh.findPullRequest(request.repo, request.branch);
    if (!pullRequest) {
      this.deps.warn(request.itemNumber, `${request.stage} is green but ${request.branch} has no pull request to record it on`);
      return;
    }
    if (hasPrSection(pullRequest.body, request.stage, round)) return;
    try {
      this.deps.gh.appendToPullRequestBody(request.repo, pullRequest, commandTrailSection(request, round));
    } catch (cause) {
      this.deps.warn(request.itemNumber, `${request.stage} is green but recording it on ${pullRequest.url} failed: ${messageOf(cause)}`);
    }
  }

  private async runVerifyChecks(request: VerifyRequest, attempt: string): Promise<StageResult> {
    await this.runInCleanCopy("verify", attempt, request, checkCommand(this.deps.config, request.repo));
    return { outcome: "success" };
  }

  private async runInCleanCopy(
    stage: string,
    attempt: string,
    request: { itemNumber: number; repo: TargetRepo; branch: string },
    checks: string,
  ): Promise<void> {
    const worktree = this.requireWorktree(request.repo, request.branch);
    await this.inContainer(stage, attempt, request, worktree, undefined, async (container) => {
      await this.bootstrap(container, request.repo, request.itemNumber, attempt);
      this.deps.log(`#${request.itemNumber} ${stage}: ${checks}`);
      const tail = outputTail(CHECK_OUTPUT_TAIL);
      const teeChecks = this.tee(attempt, `\n--- checks: ${checks} ---\n`);
      try {
        await runWithIdleTimeout(
          this.deps.runner,
          execRequest(container, checks, {
            onOutput: (chunk) => {
              tail.append(chunk);
              teeChecks(chunk);
            },
          }),
          this.deps.config.idleTimeoutSeconds,
        );
      } catch (cause) {
        throw new CheckFailure(checks, tail.text(), cause);
      }
    }, "copy");
    this.assertLive(attempt);
  }

  private async inContainer(
    stage: string,
    attempt: string,
    request: { itemNumber: number; repo: TargetRepo; branch: string },
    worktree: string,
    agent: ResolvedAgent | undefined,
    work: (container: string) => Promise<void>,
    workspace: WorkspaceMode = "bind",
  ): Promise<void> {
    this.ensureDocker();
    const refresh = agent ? ensureFreshLogin(this.deps, agent) : undefined;
    if (refresh) await refresh;
    this.assertLive(attempt);
    const provider = (agent ?? defaultAgent(this.deps.config)).provider;
    const container = this.containerName(stage, request.itemNumber);
    const login = agent ? snapshotCredential(this.deps.fs, this.deps.layout, provider) : undefined;
    const gitControl = startWorktreeContainer(this.deps, {
      name: container,
      repo: request.repo,
      worktree,
      workspace,
      provider,
      branch: request.branch,
    });

    this.attemptContainers.set(attempt, container);
    let removed = false;
    const remove = (): void => {
      if (removed) return;
      removed = true;
      if (this.attemptContainers.get(attempt) !== container) return;
      this.attemptContainers.delete(attempt);
      removeContainer(this.deps.runner, container);
    };

    if (this.cancelledAttempts.has(attempt)) {
      remove();
      releaseGitControl(gitControl);
      throw new StageCancelledError(attempt);
    }

    try {
      await this.hydrateHome(container, provider);
      await this.prepareWorkspace(container, workspace);
      await work(container);
    } finally {
      if (this.attemptContainers.get(attempt) === container) syncBackCredential(this.deps, container, login);
      try {
        remove();
      } catch (cause) {
        this.deps.log(`[warn] could not remove container ${container}: ${messageOf(cause)}`);
      }
      assertGitControlUnchanged(this.deps.fs, gitControl);
    }
  }

  private async prepareWorkspace(container: string, workspace: WorkspaceMode): Promise<void> {
    execAsRoot(this.deps.runner, container, claimWorkspaceCommand(workspace));
    if (workspace !== "copy") return;
    await runWithIdleTimeout(
      this.deps.runner,
      execRequest(container, copyWorkspaceCommand(), { onOutput: () => undefined }),
      this.deps.config.idleTimeoutSeconds,
    );
  }

  private async hydrateHome(container: string, provider: AgentProvider): Promise<void> {
    await runWithIdleTimeout(
      this.deps.runner,
      execRequest(container, provider.hydrateCommand(), { onOutput: () => undefined }),
      this.deps.config.idleTimeoutSeconds,
    );
  }

  private async bootstrap(container: string, repo: TargetRepo, itemNumber: number, attempt: string): Promise<void> {
    const command = bootstrapScript(this.deps.config, repo);
    this.deps.log(`#${itemNumber} bootstrap: ${command}`);
    try {
      await runWithIdleTimeout(
        this.deps.runner,
        execRequest(container, command, { onOutput: this.tee(attempt, `\n--- bootstrap: ${command} ---\n`) }),
        this.deps.config.idleTimeoutSeconds,
      );
    } catch (cause) {
      throw transientWaitFrom(cause) ?? cause;
    }
  }

  private async runAgent(
    container: string,
    prompt: string,
    agent: ResolvedAgent,
    idleSeconds: number,
    itemNumber: number,
    attempt: string,
  ): Promise<void> {
    const described = describeAgent(agent);
    this.deps.log(`#${itemNumber} agent starting (idle budget ${idleSeconds}s, model ${described})`);
    try {
      await runWithIdleTimeout(
        this.deps.runner,
        execRequest(container, agent.provider.command(agent.model), {
          input: prompt,
          onOutput: this.tee(attempt, `\n--- agent (${described}) ---\n`),
        }),
        idleSeconds,
      );
    } catch (cause) {
      throw agentWaitFrom(cause, agent.provider.classify) ?? transientWaitFrom(cause) ?? cause;
    }
  }

  private requireWorktree(repo: TargetRepo, branch: string): string {
    const worktree = worktreePath(this.deps.layout, repo, branch);
    if (!this.deps.fs.exists(worktree)) {
      throw new Error(`worktree ${worktree} is missing — the item branch was never created for ${branch}`);
    }
    return worktree;
  }

  private ensureDocker(): void {
    if (this.dockerChecked) return;
    assertDockerReady(this.deps.runner, this.deps.config.imageTag);
    this.dockerChecked = true;
  }

  private containerName(stage: string, itemNumber: number): string {
    this.containerSequence += 1;
    const stamp = `${(this.deps.now ?? Date.now)().toString(36)}${this.containerSequence.toString(36)}`;
    return stageContainerName(stage, itemNumber, stamp);
  }
}
