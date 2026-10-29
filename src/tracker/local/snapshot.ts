import type { IssueSnapshot, ParentSummary, RunReader, RunSnapshot, WorkItemSnapshot } from "../types.js";
import type { FrontmatterData } from "./frontmatter.js";
import { PARENT_NUMBER_STRIDE, splitComments, type LocalFeature, type LocalIssue, type LocalIssueStore } from "./store.js";

const BLOCKED_BY_LINE = /^\*{0,2}Blocked by:?\*{0,2}:?\s*(.*)$/im;
const STATUS_LINE = /^\*{0,2}Status:?\*{0,2}:?\s*(\S+)/im;
const HEADING = /^#\s+(.+)$/m;
const TICKET_PREFIX = /^\d+\s*[:.\-–]\s*/;

function stringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value.trim().length > 0) return [value];
  return undefined;
}

export function stageOf(data: FrontmatterData): string | undefined {
  const stage = data["stage"];
  return typeof stage === "string" && stage.trim().length > 0 ? stage.trim() : undefined;
}

/** The labels an Operator or the engine put on an issue besides its stage: the `labels` key, else the `status` key, else the to-tickets Status line. */
export function plainLabels(issue: Pick<LocalIssue, "data" | "body">): string[] {
  const listed = stringList(issue.data["labels"]);
  if (listed) return listed;
  const status = stringList(issue.data["status"]);
  if (status) return status;
  const line = STATUS_LINE.exec(issue.body)?.[1];
  return line ? [line] : [];
}

export function labelsOf(issue: LocalIssue): string[] {
  const stage = stageOf(issue.data);
  const repo = typeof issue.data["repo"] === "string" ? [`repo:${issue.data["repo"].trim()}`] : [];
  return [...new Set([...(issue.kind === "parent" ? ["sandcastle"] : repo), ...plainLabels(issue), ...(stage ? [stage] : [])])];
}

function titleOf(issue: LocalIssue): string {
  const heading = HEADING.exec(issue.body)?.[1]?.trim();
  return heading ? heading.replace(TICKET_PREFIX, "") : issue.slug;
}

function blockedNumbers(tokens: string[], parentNumber: number): number[] {
  return tokens.flatMap((token) => {
    const digits = /^#?(\d+)/.exec(token.trim())?.[1];
    if (digits === undefined) return [];
    const value = Number(digits);
    return [value >= PARENT_NUMBER_STRIDE ? value : parentNumber + value];
  });
}

/** `blocked-by` frontmatter first, then the to-tickets "Blocked by" line; null when the issue says neither. */
export function blockedByOf(issue: LocalIssue): number[] | null {
  const declared = issue.data["blocked-by"];
  if (declared !== undefined) {
    const tokens = Array.isArray(declared) ? declared.map(String) : [String(declared)];
    return blockedNumbers(tokens, issue.parentNumber);
  }
  const line = BLOCKED_BY_LINE.exec(issue.body)?.[1];
  if (line === undefined) return null;
  return blockedNumbers(line.split(/[,;]|\band\b/i), issue.parentNumber);
}

function isClosed(issue: LocalIssue): boolean {
  return String(issue.data["state"] ?? "").toLowerCase() === "closed";
}

function toIssueSnapshot(issue: LocalIssue): IssueSnapshot {
  return {
    number: issue.number,
    title: titleOf(issue),
    state: isClosed(issue) ? "CLOSED" : "OPEN",
    labels: labelsOf(issue),
    body: splitComments(issue.body).text,
  };
}

export function toWorkItemSnapshot(issue: LocalIssue): WorkItemSnapshot {
  return { ...toIssueSnapshot(issue), blockedBy: blockedByOf(issue) };
}

export function toRunSnapshot(feature: LocalFeature, hubRepo: string): RunSnapshot {
  return { repo: hubRepo, parent: toIssueSnapshot(feature.parent), subIssues: feature.items.map(toWorkItemSnapshot) };
}

const FEATURE_LINE = /^feature:\s*["']?([a-z0-9]+(?:-[a-z0-9]+)*)["']?\s*$/m;

function integrationBranchOf(parent: LocalIssue): string | undefined {
  const feature = FEATURE_LINE.exec(parent.body)?.[1];
  return feature ? `integration/${feature}` : undefined;
}

export function toParentSummary(feature: LocalFeature): ParentSummary {
  const done = feature.items.filter(isClosed).length;
  const integrationBranch = integrationBranchOf(feature.parent);
  return {
    number: feature.parent.number,
    title: titleOf(feature.parent),
    subIssues: feature.items.length,
    completedSubIssues: done,
    ...(integrationBranch ? { integrationBranch } : {}),
  };
}

/** Reads Orchestration Issues from `.scratch/<slug>/issues/`, fresh from disk on every call. */
export function createLocalRunReader(store: LocalIssueStore, hubRepo: string): RunReader {
  return {
    fetchRunSnapshot: (parentNumber) => Promise.resolve().then(() => toRunSnapshot(store.feature(store.resolve(parentNumber)), hubRepo)),
    listParents: () =>
      Promise.resolve().then(() =>
        store
          .features()
          .filter((feature) => !isClosed(feature.parent))
          .map(toParentSummary),
      ),
  };
}
