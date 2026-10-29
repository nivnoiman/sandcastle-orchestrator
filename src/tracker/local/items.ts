import { isStageLabel, type StageLabel } from "../../engine/adapters.js";
import type { TrackerItemReader, TrackerWriter } from "../types.js";
import { plainLabels, stageOf } from "./snapshot.js";
import type { LocalIssueStore } from "./store.js";

export function localClosingComment(mergeRef: string): string {
  return [
    `Squash-merged into the integration branch: ${mergeRef}`,
    "",
    "sandcastle closed this issue from here. The parent issue stays open until the Operator merges the integration branch.",
  ].join("\n");
}

/** Item state in issue-file frontmatter: the engine writes `state`, `stage` and `labels` only, never the Operator's keys. */
export class LocalItems implements TrackerItemReader, TrackerWriter {
  constructor(private readonly store: LocalIssueStore) {}

  setStageLabel(itemNumber: number, label: StageLabel): void {
    const issue = this.store.find(itemNumber);
    const labels = plainLabels(issue);
    if (labels.some(isStageLabel)) this.store.update(issue.path, "labels", labels.filter((name) => !isStageLabel(name)));
    this.store.update(issue.path, "stage", label);
  }

  addLabel(itemNumber: number, label: string): void {
    const issue = this.store.find(itemNumber);
    const labels = plainLabels(issue);
    if (labels.includes(label)) return;
    this.store.update(issue.path, "labels", [...labels, label]);
  }

  removeLabel(itemNumber: number, label: string): void {
    const issue = this.store.find(itemNumber);
    const labels = plainLabels(issue);
    if (labels.includes(label)) this.store.update(issue.path, "labels", labels.filter((name) => name !== label));
    if (stageOf(issue.data) === label) this.store.update(issue.path, "stage", undefined);
  }

  swapLabels(itemNumber: number, removeLabel: string, addLabel: string): void {
    const issue = this.store.find(itemNumber);
    const labels = plainLabels(issue).filter((name) => name !== removeLabel);
    this.store.update(issue.path, "labels", labels.includes(addLabel) ? labels : [...labels, addLabel]);
  }

  comment(itemNumber: number, body: string): void {
    this.store.appendComment(itemNumber, body);
  }

  closeIssue(itemNumber: number, mergedPullRequestUrl: string): void {
    this.store.appendComment(itemNumber, localClosingComment(mergedPullRequestUrl));
    this.store.updateIssue(itemNumber, "state", "closed");
  }

  issueComments(itemNumber: number): string[] {
    return this.store.comments(itemNumber);
  }

  stageLabels(itemNumber: number): StageLabel[] {
    const issue = this.store.find(itemNumber);
    const stage = stageOf(issue.data);
    return [...new Set([...(stage ? [stage] : []), ...plainLabels(issue)])].filter(isStageLabel);
  }
}
