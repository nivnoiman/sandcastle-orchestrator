import type { MergedPullRequest, StageLabel } from "../engine/adapters.js";
import type { TargetRepo } from "../model/runModel.js";

export interface IssueSnapshot {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  labels: string[];
  body: string;
}

export interface WorkItemSnapshot extends IssueSnapshot {
  blockedBy: number[] | null;
}

export interface RunSnapshot {
  repo: string;
  parent: IssueSnapshot;
  subIssues: WorkItemSnapshot[];
}

export function isRunSnapshot(value: unknown): value is RunSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate["parent"] === "object" && Array.isArray(candidate["subIssues"]);
}

export interface ParentSummary {
  number: number;
  title: string;
  subIssues: number;
  completedSubIssues: number;
  /** Where the Run's integration branch lives; set by the local Tracker so the Board View can name it before any Run exists. */
  integrationBranch?: string;
}

/** Remote reads of a Project's Orchestration Issues, bound to one hub. */
export interface RunReader {
  fetchRunSnapshot(parentNumber: number): Promise<RunSnapshot>;
  listParents(): Promise<ParentSummary[]>;
}

/** Reads of one item's recorded state. */
export interface TrackerItemReader {
  issueComments(itemNumber: number): string[];
  stageLabels(itemNumber: number): StageLabel[];
}

/** Writes of engine state onto an item. */
export interface TrackerWriter {
  setStageLabel(itemNumber: number, label: StageLabel): void;
  addLabel(itemNumber: number, label: string): void;
  removeLabel(itemNumber: number, label: string): void;
  swapLabels(itemNumber: number, removeLabel: string, addLabel: string): void;
  comment(itemNumber: number, body: string): void;
  closeIssue(itemNumber: number, mergedPullRequestUrl: string): void;
}

export interface PullRequestRef {
  number: number;
  url: string;
  state: string;
  isDraft: boolean;
  body: string;
  title: string;
}

export interface CreateDraftPrInput {
  repo: TargetRepo;
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
}

export interface PullRequestOps {
  findPullRequest(repo: TargetRepo, branch: string, baseBranch?: string): PullRequestRef | undefined;
  createDraftPullRequest(input: CreateDraftPrInput): PullRequestRef;
  appendToPullRequestBody(repo: TargetRepo, pullRequest: PullRequestRef, addition: string): void;
}

export interface FeatureVerifyPullRequests {
  findPullRequest(repo: TargetRepo, branch: string, baseBranch?: string): PullRequestRef | undefined;
  createPullRequest(input: CreateDraftPrInput): PullRequestRef;
}

/** Pull-request operations: a separate seam, since a local Tracker replaces them with git merges. */
export interface PullRequestSeam extends PullRequestOps, FeatureVerifyPullRequests {
  mergePullRequest(itemNumber: number): MergedPullRequest;
  commentOnPullRequest(repo: TargetRepo, pullRequest: PullRequestRef, body: string): void;
}

/** Everything a Tracker provides. Pull requests are a distinct member so adapters can replace them alone. */
export interface Tracker {
  runs: RunReader;
  items: TrackerItemReader & TrackerWriter;
  pullRequests: PullRequestSeam;
}

/** What the real adapters hand the engine, stages and verify: writes, item reads, pull requests and the label-retry hook. */
export interface TrackerClient extends TrackerWriter, TrackerItemReader, PullRequestSeam {
  /** Retries label writes that failed earlier; a no-op where writes cannot fail remotely. */
  flushPendingLabels(): void;
}
