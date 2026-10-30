import { uiLifecycle, type UiFeedLine, type UiItem, type UiRun, type UiState } from "../ui/state.js";

export interface OpsItem {
  number: number;
  phase: string;
  stage: string | undefined;
  repo: string;
  parkReason?: string;
  waitReason?: string;
  resumeAt?: string;
  pullRequest?: string;
  quiet?: NonNullable<UiItem["quiet"]>;
}

export function opsItem(item: UiItem): OpsItem {
  return {
    number: item.number,
    phase: item.phase,
    stage: item.stage,
    repo: item.repo,
    ...(item.parkReason ? { parkReason: item.parkReason } : {}),
    ...(item.waitReason ? { waitReason: item.waitReason } : {}),
    ...(item.resumeAt ? { resumeAt: item.resumeAt } : {}),
    ...(item.pullRequestUrl ? { pullRequest: item.pullRequestUrl } : {}),
    ...(item.quiet ? { quiet: item.quiet } : {}),
  };
}

const FEED_TAIL = 12;

function parentList(runs: readonly UiRun[]): string {
  return runs.map((run) => `#${run.parent.number}`).join(", ");
}

function legacyRun(state: UiState): UiRun | undefined {
  if (!state.parent) return undefined;
  return {
    parent: state.parent,
    cap: state.cap,
    paused: state.paused,
    started: state.started,
    complete: state.complete,
    settled: false,
    running: state.running,
    stalled: state.stalled,
    hold: state.hold,
    featureVerify: state.featureVerify,
    polish: state.polish,
    lifecycle: uiLifecycle(state.featureVerify, state.polish),
    phaseCounts: state.phaseCounts,
    items: state.items,
  };
}

const NO_RUN = "no run has started on this control plane — start one with: sandcastle launch <parent> --cap=N";

function knownRuns(state: UiState): UiRun[] {
  const runs = state.runs ?? [];
  if (runs.length > 0) return runs;
  const legacy = legacyRun(state);
  return legacy ? [legacy] : [];
}

function unambiguousRun(runs: readonly UiRun[]): UiRun | undefined {
  const live = runs.filter((run) => !run.settled);
  if (live.length === 1) return live[0];
  if (runs.length === 1) return runs[0];
  return undefined;
}

function ambiguity(runs: readonly UiRun[]): string {
  if (runs.length === 0) return NO_RUN;
  const live = runs.filter((run) => !run.settled);
  if (live.length > 1) return `several parents are live (${parentList(live)}) — pass --parent=N`;
  return `several parents ran here (${parentList(runs)}) — pass --parent=N`;
}

export function selectRun(state: UiState, parent?: number): UiRun {
  const runs = knownRuns(state);
  if (runs.length === 0) throw new Error(NO_RUN);
  if (parent === undefined) {
    const only = unambiguousRun(runs);
    if (only) return only;
    throw new Error(ambiguity(runs));
  }
  const found = runs.find((run) => run.parent.number === parent);
  if (found) return found;
  throw new Error(`#${parent} is not a run on this control plane — runs: ${parentList(runs)}`);
}

export function findItem(state: UiState, itemNumber: number, parent?: number): UiItem {
  const runs = parent === undefined ? knownRuns(state) : [selectRun(state, parent)];
  if (runs.length === 0) throw new Error(NO_RUN);
  const found = runs.flatMap((run) => run.items).find((item) => item.number === itemNumber);
  if (found) return found;
  throw new Error(
    parent === undefined
      ? `#${itemNumber} is not in any run on this control plane`
      : `#${itemNumber} is not in #${parent}'s run`,
  );
}

function inPhase(run: UiRun, phase: string): UiItem[] {
  return run.items.filter((item) => item.phase === phase);
}

function itemsInPhase(run: UiRun, phase: string): OpsItem[] {
  return inPhase(run, phase).map(opsItem);
}

function numbersInPhase(run: UiRun, phase: string): number[] {
  return inPhase(run, phase).map((item) => item.number);
}

function feedOf(state: UiState, parent: number): UiFeedLine[] {
  return state.feed.filter((line) => line.parentNumber === undefined || line.parentNumber === parent);
}

function controlPlane(state: UiState): Record<string, unknown> {
  return {
    queueSettings: state.queueSettings,
    queue: state.queue,
    globalRunning: state.globalRunning,
  };
}

function runLine(run: UiRun): Record<string, unknown> {
  return {
    parent: run.parent.number,
    phases: run.phaseCounts,
    featureVerify: run.featureVerify.phase,
    polish: run.polish.phase,
    settled: run.settled,
    waiting: numbersInPhase(run, "waiting"),
    parked: numbersInPhase(run, "parked"),
  };
}

export interface StatusOptions {
  items?: boolean;
  parent?: number;
  summary?: boolean;
}

function summaryReport(state: UiState, note: string | undefined): Record<string, unknown> {
  return {
    ok: true,
    ...controlPlane(state),
    runs: knownRuns(state).map(runLine),
    ...(note ? { note } : {}),
    feed: state.feed.slice(-FEED_TAIL),
  };
}

export function statusReport(state: UiState, options: StatusOptions = {}): Record<string, unknown> {
  const { items: includeItems = false, parent, summary = false } = options;
  if (summary && parent !== undefined) throw new Error("pass --parent=N or --summary, not both");
  if (summary) return summaryReport(state, undefined);
  const runs = knownRuns(state);
  const run = parent === undefined ? unambiguousRun(runs) : selectRun(state, parent);
  if (!run) return summaryReport(state, ambiguity(runs));
  return {
    ok: true,
    ...controlPlane(state),
    parent: run.parent,
    started: run.started,
    complete: run.complete,
    settled: run.settled,
    running: run.running,
    cap: run.cap,
    paused: run.paused,
    hold: run.hold,
    stalled: run.stalled,
    phases: run.phaseCounts,
    featureVerify: run.featureVerify,
    polish: run.polish,
    waiting: itemsInPhase(run, "waiting"),
    parked: itemsInPhase(run, "parked"),
    quiet: run.items.filter((item) => item.quiet).map(opsItem),
    ...(includeItems ? { items: run.items.map(opsItem) } : {}),
    feed: feedOf(state, run.parent.number).slice(-FEED_TAIL),
  };
}

export function parkedToRetry(state: UiState, only: string | undefined, parent?: number): number[] {
  const wanted = only === undefined || only === "all" ? "" : only;
  return inPhase(selectRun(state, parent), "parked")
    .filter((item) => (item.parkReason ?? "").includes(wanted))
    .map((item) => item.number);
}

export function waitingItems(state: UiState, parent?: number): number[] {
  return numbersInPhase(selectRun(state, parent), "waiting");
}

export function queueReport(state: UiState): Record<string, unknown> {
  return {
    ok: true,
    settings: state.queueSettings,
    queued: state.queue,
    globalRunning: state.globalRunning,
    runs: knownRuns(state).map((run) => ({ parent: run.parent.number, complete: run.complete, settled: run.settled })),
  };
}

export interface LaunchPlan {
  start: number | undefined;
  queue: number[];
  alreadyRunning: number[];
  alreadyQueued: number[];
}

export function launchPlan(state: UiState, requested: readonly number[]): LaunchPlan {
  const parents = [...new Set(requested)];
  const live = new Set(knownRuns(state).filter((run) => !run.settled).map((run) => run.parent.number));
  const queued = new Set(state.queue);
  const alreadyRunning = parents.filter((parent) => live.has(parent));
  const alreadyQueued = parents.filter((parent) => !live.has(parent) && queued.has(parent));
  const fresh = parents.filter((parent) => !live.has(parent) && !queued.has(parent));
  const start = state.canStart ? fresh[0] : undefined;
  return { start, queue: start === undefined ? fresh : fresh.slice(1), alreadyRunning, alreadyQueued };
}

export interface FinishReport {
  ok: boolean;
  error?: string;
  parent: UiRun["parent"];
  featureVerify: UiRun["featureVerify"];
  polish: UiRun["polish"];
  pullRequests: readonly string[];
  merged: number[];
  waiting?: OpsItem[];
  parked?: OpsItem[];
  phases?: UiRun["phaseCounts"];
}

export function finishReport(state: UiState, parent?: number): FinishReport {
  const run = selectRun(state, parent);
  const merged = numbersInPhase(run, "done");
  const report: FinishReport = {
    ok: false,
    parent: run.parent,
    featureVerify: run.featureVerify,
    polish: run.polish,
    pullRequests: run.featureVerify.pullRequests,
    merged,
  };
  if (!run.complete) {
    return {
      ...report,
      error: "the run is not complete",
      phases: run.phaseCounts,
      waiting: itemsInPhase(run, "waiting"),
      parked: itemsInPhase(run, "parked"),
    };
  }
  const phase = run.featureVerify.phase;
  if (phase === "red") return { ...report, error: run.featureVerify.reason ?? "feature verify is red" };
  if (phase === "waiting") return { ...report, error: "feature verify is waiting for another parent's verify" };
  if (phase === "running") return { ...report, error: "feature verify is still running" };
  if (phase === "fixing") return { ...report, error: "feature verify is in a fix round" };
  if (phase === "idle") return { ...report, error: "feature verify never ran" };
  if (phase !== "green" && phase !== "skipped") return { ...report, error: `feature verify is ${String(phase)}` };
  if (run.polish.phase === "running") return { ...report, error: "polish is still running" };
  return { ...report, ok: true };
}
