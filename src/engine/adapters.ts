import type { TargetRepo } from "../model/runModel.js";

export const AGENT_STAGES = ["develop", "simplify", "review"] as const;
export type AgentStage = (typeof AGENT_STAGES)[number];

export const STAGE_CHAIN = ["develop", "simplify", "review", "verify"] as const;
export type StageName = (typeof STAGE_CHAIN)[number];

export type StageOutcome = "success" | "failure" | "waiting";

export type HoldReason = "rate-limit" | "auth";
export type WaitReason = HoldReason | "transient";

export const REWORK_SOURCES = ["verify", "review"] as const;
export type ReworkSource = (typeof REWORK_SOURCES)[number];

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
export type StageLabel = (typeof STAGE_LABELS)[number];

export const RUNNING_STAGE_LABELS: Record<AgentStage, StageLabel> = {
  develop: "sc:developing",
  simplify: "sc:simplifying",
  review: "sc:in-review",
};

export const VERIFY_STAGE_LABEL: StageLabel = "sc:verifying";

export function agentStageForLabel(label: StageLabel): AgentStage | undefined {
  return AGENT_STAGES.find((stage) => RUNNING_STAGE_LABELS[stage] === label);
}

export interface SpawnRequest {
  itemNumber: number;
  stage: AgentStage;
  repo: TargetRepo;
  branch: string;
  integrationBranch: string;
  rebaseConflicts?: readonly string[];
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
