import type { MergedPullRequest, StageLabel } from "../../engine/adapters.js";
import type { TargetRepo } from "../../model/runModel.js";
import type { CreateDraftPrInput, PullRequestRef, TrackerClient } from "../types.js";
import { LocalItems } from "./items.js";
import { LocalPullRequests, type LocalPullRequestDeps } from "./pullRequests.js";

function noLabelWritePending(): void {
  return undefined;
}

/** The Local Tracker as the engine, stages and verify see it: issue-file writes plus git-backed pull requests. */
export class LocalTrackerClient implements TrackerClient {
  private readonly items: LocalItems;
  private readonly pullRequests: LocalPullRequests;

  constructor(deps: LocalPullRequestDeps) {
    this.items = new LocalItems(deps.store);
    this.pullRequests = new LocalPullRequests(deps);
  }

  setStageLabel(itemNumber: number, label: StageLabel): void {
    this.items.setStageLabel(itemNumber, label);
  }

  addLabel(itemNumber: number, label: string): void {
    this.items.addLabel(itemNumber, label);
  }

  removeLabel(itemNumber: number, label: string): void {
    this.items.removeLabel(itemNumber, label);
  }

  swapLabels(itemNumber: number, removeLabel: string, addLabel: string): void {
    this.items.swapLabels(itemNumber, removeLabel, addLabel);
  }

  comment(itemNumber: number, body: string): void {
    this.items.comment(itemNumber, body);
  }

  closeIssue(itemNumber: number, mergedPullRequestUrl: string): void {
    this.items.closeIssue(itemNumber, mergedPullRequestUrl);
  }

  issueComments(itemNumber: number): string[] {
    return this.items.issueComments(itemNumber);
  }

  stageLabels(itemNumber: number): StageLabel[] {
    return this.items.stageLabels(itemNumber);
  }

  flushPendingLabels(): void {
    return noLabelWritePending();
  }

  findPullRequest(repo: TargetRepo, branch: string, baseBranch?: string): PullRequestRef | undefined {
    return this.pullRequests.findPullRequest(repo, branch, baseBranch);
  }

  createDraftPullRequest(input: CreateDraftPrInput): PullRequestRef {
    return this.pullRequests.createDraftPullRequest(input);
  }

  createPullRequest(input: CreateDraftPrInput): PullRequestRef {
    return this.pullRequests.createPullRequest(input);
  }

  appendToPullRequestBody(repo: TargetRepo, pullRequest: PullRequestRef, addition: string): void {
    this.pullRequests.appendToPullRequestBody(repo, pullRequest, addition);
  }

  commentOnPullRequest(repo: TargetRepo, pullRequest: PullRequestRef, body: string): void {
    this.pullRequests.commentOnPullRequest(repo, pullRequest, body);
  }

  mergePullRequest(itemNumber: number): MergedPullRequest {
    return this.pullRequests.mergePullRequest(itemNumber);
  }
}
