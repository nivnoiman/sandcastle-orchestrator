import type { ItemPhase } from "../../engine/engine.js";
import type { RunMode, UiItem, UiRun, UiState } from "../state.js";

export interface ParentOption {
  number: number;
  title: string;
  subIssues: number;
  completedSubIssues: number;
}

export type ProjectStatus = "running" | "stopped" | "died";

/** One Project as the Board View sees it: identity plus the last state its Project Server sent. */
export interface BoardProject {
  id: string;
  name: string;
  hub: string;
  /** URL prefix of this Project Server's API; "" when the page is served by it. */
  apiBase: string;
  legacyHref: string;
  status: ProjectStatus;
  idle: boolean;
  mode: RunMode;
  state: UiState | undefined;
  parents: ParentOption[];
  connected: boolean;
}

export type PhaseBucket = "done" | "run" | "wait" | "park" | "idle";

export function phaseBucket(phase: ItemPhase): PhaseBucket {
  if (phase === "done") return "done";
  if (phase === "running" || phase === "awaiting") return "run";
  if (phase === "waiting" || phase === "blocked") return "wait";
  if (phase === "parked") return "park";
  return "idle";
}

export const BUCKETS: readonly PhaseBucket[] = ["done", "run", "wait", "park", "idle"];

export function bucketCounts(items: readonly Pick<UiItem, "phase">[]): Record<PhaseBucket, number> {
  const counts: Record<PhaseBucket, number> = { done: 0, run: 0, wait: 0, park: 0, idle: 0 };
  for (const item of items) counts[phaseBucket(item.phase)] += 1;
  return counts;
}

/** Board column of an Item: waiting phases sit in the first column, finished in the last, the rest at their Stage. */
export function columnOf(item: Pick<UiItem, "phase" | "stage">, stages: readonly string[]): string {
  const first = stages[0] ?? "queued";
  if (item.phase === "done") return stages[stages.length - 1] ?? "merged";
  if (item.phase === "queued" || item.phase === "blocked" || item.phase === "held") return first;
  if (item.stage !== undefined && stages.includes(item.stage)) return item.stage;
  return first;
}

export function groupByColumn<T extends Pick<UiItem, "phase" | "stage" | "number">>(
  items: readonly T[],
  stages: readonly string[],
): Map<string, T[]> {
  const columns = new Map<string, T[]>(stages.map((stage) => [stage, []]));
  for (const item of [...items].sort((a, b) => a.number - b.number)) {
    columns.get(columnOf(item, stages))?.push(item);
  }
  return columns;
}

export function runHint(run: UiRun): string {
  if (run.stalled) return "stalled";
  if (run.settled) return run.complete ? "complete" : "ended";
  if (run.complete) return "settling";
  return run.paused ? "paused" : "running";
}

export type StepState = "pending" | "active" | "done" | "failed" | "skipped" | "warn";

export interface LifecycleStep {
  id: "items" | "integration" | "verify" | "polish" | "prs";
  label: string;
  state: StepState;
  detail: string;
}

export function runPullRequests(run: Pick<UiRun, "featureVerify" | "polish">): string[] {
  return run.polish.pullRequests.length > 0 ? run.polish.pullRequests : run.featureVerify.pullRequests;
}

function verifyStepState(phase: UiRun["featureVerify"]["phase"]): StepState {
  if (phase === "green") return "done";
  if (phase === "red") return "failed";
  if (phase === "skipped") return "skipped";
  return phase === "idle" ? "pending" : "active";
}

function polishStepState(phase: UiRun["polish"]["phase"]): StepState {
  if (phase === "green") return "done";
  if (phase === "reverted") return "warn";
  if (phase === "skipped") return "skipped";
  return phase === "idle" ? "pending" : "active";
}

/** Run Lifecycle: Items → Integration → Feature Verify → Polish → PRs. */
export function lifecycleSteps(run: UiRun): LifecycleStep[] {
  const total = run.items.length;
  const done = run.items.filter((item) => item.phase === "done").length;
  const allDone = total > 0 && done === total;
  const { featureVerify: verify, polish } = run;
  const afterIntegration = verify.phase !== "idle" || polish.phase !== "idle";
  const verifyCleared = verify.phase === "green" || verify.phase === "skipped";
  const polishCleared = polish.phase === "green" || polish.phase === "skipped" || polish.phase === "reverted";
  const prsReady = verifyCleared && polishCleared;
  const prs = runPullRequests(run);

  return [
    { id: "items", label: "Items", state: allDone ? "done" : "active", detail: `${done}/${total} merged` },
    {
      id: "integration",
      label: "Integration",
      state: !allDone ? "pending" : afterIntegration ? "done" : "active",
      detail: allDone ? "all merged" : `${total - done} to go`,
    },
    { id: "verify", label: "Feature Verify", state: verifyStepState(verify.phase), detail: verify.phase },
    { id: "polish", label: "Polish", state: polishStepState(polish.phase), detail: polish.phase },
    {
      id: "prs",
      label: "PRs",
      state: prsReady ? "active" : "pending",
      detail: prsReady ? `${prs.length || "ready"} for your merge` : "after polish",
    },
  ];
}

export type ParentGroup = "ready-to-merge" | "working" | "todo";

export function parentGroup(parent: ParentOption): ParentGroup {
  if (parent.subIssues > 0 && parent.completedSubIssues === parent.subIssues) return "ready-to-merge";
  return parent.completedSubIssues === 0 ? "todo" : "working";
}

export const PARENT_GROUPS: readonly { group: ParentGroup; label: string }[] = [
  { group: "ready-to-merge", label: "Ready to merge" },
  { group: "working", label: "Working" },
  { group: "todo", label: "Todo" },
];

export function parentMatches(parent: ParentOption, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return needle === "" || `#${parent.number} ${parent.title}`.toLowerCase().includes(needle);
}

/** The remembered run if it is still live, else the primary run, else the first. */
export function chooseRun(state: UiState | undefined, remembered: number | undefined): UiRun | undefined {
  if (!state) return undefined;
  const kept = state.runs.find((run) => run.parent.number === remembered);
  if (kept) return kept;
  const primary = state.parent && state.runs.find((run) => run.parent.number === state.parent?.number);
  return primary ?? state.runs[0];
}

export function projectWorking(project: BoardProject): number {
  return project.state?.globalRunning ?? 0;
}

export function projectCap(project: BoardProject): number {
  return project.state?.queueSettings.globalCap ?? 0;
}

export function hubIssueUrl(hubRepo: string, number: number): string {
  return `https://github.com/${hubRepo}/issues/${number}`;
}
