import type { TargetRepo } from "../model/runModel.js";
import { BUILTIN_AGENT_STAGES, type BuiltinAgentStage } from "../project/stagesConfig.js";

/** The built-in agent stages; a project's chain may add custom ones (`stages` in config.json). */
export const AGENT_STAGES = BUILTIN_AGENT_STAGES;
export type AgentStage = BuiltinAgentStage;

/** The default chain, used when config.json declares no `stages`. */
export const STAGE_CHAIN = ["develop", "simplify", "review", "verify"] as const;
/** A stage of the project's chain: a built-in or a custom stage name. */
export type StageName = string;

export type StageOutcome = "success" | "failure" | "waiting";

export type HoldReason = "rate-limit" | "auth";
export type WaitReason = HoldReason | "transient";

/** The stage that sent an item back to develop: `verify`, `review` or a custom stage. */
export type ReworkSource = StageName;

export interface ReworkBrief {
  round: number;
  source: ReworkSource;
  story: string;
}

export interface ReworkRequest {
  source: ReworkSource;
  story: string;
}

export interface ReworkContext {
  round: number;
  limit: number;
  briefs: readonly ReworkBrief[];
}

export interface StageCompletion {
  itemNumber: number;
  stage: StageName;
  outcome: StageOutcome;
  detail?: string;
  rework?: ReworkRequest;
  pullRequestUrl?: string;
  waitReason?: WaitReason;
  resumeAt?: number;
  resolved?: boolean;
}

export const STAGE_LABELS = [
  "sc:queued",
  "sc:blocked",
  "sc:developing",
  "sc:simplifying",
  "sc:in-review",
  "sc:verifying",
  "sc:done",
  "sc:needs-human",
] as const;
/** A fixed label above, or `sc:<name>` for a custom stage. */
export type StageLabel = (typeof STAGE_LABELS)[number] | `sc:${string}`;

export const RUNNING_STAGE_LABELS: Record<AgentStage, StageLabel> = {
  develop: "sc:developing",
  simplify: "sc:simplifying",
  review: "sc:in-review",
};

export const VERIFY_STAGE_LABEL: StageLabel = "sc:verifying";

/** Every `sc:*` label is the orchestrator's, including `sc:<name>` of custom stages a past config declared. */
export function isStageLabel(value: string): value is StageLabel {
  return value.startsWith("sc:");
}

export function isFixedStageLabel(value: string): boolean {
  return (STAGE_LABELS as readonly string[]).includes(value);
}

export interface SpawnRequest {
  itemNumber: number;
  stage: StageName;
  repo: TargetRepo;
  branch: string;
  integrationBranch: string;
  rebaseConflicts?: readonly string[];
  rework?: ReworkContext;
}

export interface CommandStageRequest {
  itemNumber: number;
  stage: StageName;
  repo: TargetRepo;
  branch: string;
  integrationBranch: string;
  command: string;
  rework?: ReworkContext;
}

export interface ResolveRequest {
  itemNumber: number;
  repo: TargetRepo;
  branch: string;
  integrationBranch: string;
  files: readonly string[];
}

export interface VerifyRequest {
  itemNumber: number;
  repo: TargetRepo;
  branch: string;
  integrationBranch: string;
}

export interface MergedPullRequest {
  url: string;
}

export interface GhClient {
  setStageLabel(itemNumber: number, label: StageLabel): void;
  addLabel(itemNumber: number, label: string): void;
  removeLabel(itemNumber: number, label: string): void;
  swapLabels(itemNumber: number, removeLabel: string, addLabel: string): void;
  comment(itemNumber: number, body: string): void;
  mergePullRequest(itemNumber: number): MergedPullRequest;
  closeIssue(itemNumber: number, mergedPullRequestUrl: string): void;
}

export interface UiSink {
  warn(itemNumber: number, message: string): void;
  note(itemNumber: number | undefined, message: string): void;
}

export interface SandboxRunner {
  spawnStage(request: SpawnRequest): void;
  spawnCommandStage(request: CommandStageRequest): void;
  spawnResolve(request: ResolveRequest): void;
  kill(itemNumber: number): void;
}

export class RebaseConflictError extends Error {
  readonly rebaseConflict = true;

  constructor(
    readonly repo: TargetRepo,
    readonly branch: string,
    readonly integrationBranch: string,
    readonly files: readonly string[],
    readonly gitOutput: string,
  ) {
    super(
      `[${repo}] ${branch} does not rebase cleanly onto ${integrationBranch}: merge conflict` +
        (files.length > 0 ? ` in ${files.join(", ")}` : " (git named no unmerged paths)"),
    );
    this.name = "RebaseConflictError";
  }
}

export function isRebaseConflict(cause: unknown): cause is RebaseConflictError {
  return cause instanceof RebaseConflictError;
}

export interface GitOps {
  createIntegrationBranch(repo: TargetRepo, branch: string): void;
  createItemBranch(repo: TargetRepo, branch: string, baseBranch: string): void;
  syncWithIntegration(repo: TargetRepo, branch: string, integrationBranch: string): string[];
  rebaseOntoIntegration(repo: TargetRepo, branch: string, integrationBranch: string): void;
  runChecks(request: VerifyRequest): void;
}

export interface Adapters {
  gh: GhClient;
  sandbox: SandboxRunner;
  git: GitOps;
  ui: UiSink;
}
