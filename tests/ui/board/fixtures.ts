import type { BoardProject, ParentOption } from "../../../src/ui/board/model.js";
import { idleFeatureVerify, idlePolish, type UiItem, type UiRun, type UiState } from "../../../src/ui/state.js";

export const NOW = Date.parse("2026-08-15T09:00:00.000Z");

export function minutesAgo(minutes: number): string {
  return new Date(NOW - minutes * 60_000).toISOString();
}

export function uiItem(number: number, phase: UiItem["phase"], extra: Partial<UiItem> = {}): UiItem {
  return {
    number,
    title: `item ${number}`,
    repo: "api",
    phase,
    phaseSince: minutesAgo(5),
    stage: undefined,
    stageIndex: 0,
    branch: `sc/${number}`,
    dependsOn: [],
    blockers: [],
    parkReason: undefined,
    waitReason: undefined,
    resumeAt: undefined,
    pullRequestUrl: undefined,
    reworkRound: 0,
    reworkLimit: 2,
    issueUrl: `https://github.com/acme/hub/issues/${number}`,
    agent: undefined,
    quiet: undefined,
    ...extra,
  };
}

export function uiRun(parent: number, items: UiItem[], extra: Partial<UiRun> = {}): UiRun {
  return {
    parent: { number: parent, title: `parent ${parent}`, feature: "f", integrationBranch: `integration/p${parent}`, url: `https://github.com/acme/hub/issues/${parent}` },
    cap: 2,
    paused: false,
    started: true,
    lifecycle: [],
    complete: false,
    settled: false,
    running: items.filter((item) => item.phase === "running").length,
    stalled: undefined,
    hold: undefined,
    featureVerify: idleFeatureVerify(),
    polish: idlePolish(),
    phaseCounts: { held: 0, blocked: 0, queued: 0, running: 0, awaiting: 0, waiting: 0, parked: 0, done: 0 },
    items,
    ...extra,
  };
}

export function uiState(runs: UiRun[], extra: Partial<UiState> = {}): UiState {
  return {
    version: 2,
    rev: 1,
    boot: "test-boot",
    stages: ["queued", "develop", "review", "verify", "merged"],
    mode: "real",
    tracker: "github",
    hubRepo: "acme/hub",
    startCap: 2,
    preselectedParent: undefined,
    parent: runs[0]?.parent,
    cap: 2,
    paused: false,
    started: runs.length > 0,
    complete: false,
    running: 0,
    stalled: undefined,
    hold: undefined,
    canStart: true,
    featureVerify: idleFeatureVerify(),
    polish: idlePolish(),
    canReset: true,
    resetting: false,
    phaseCounts: { held: 0, blocked: 0, queued: 0, running: 0, awaiting: 0, waiting: 0, parked: 0, done: 0 },
    queue: [],
    queueCap: 2,
    queueSettings: { mode: "sequential", maxParallel: 1, globalCap: 3, parentCap: 2, paused: false },
    runs,
    globalRunning: 0,
    items: runs[0]?.items ?? [],
    feed: [],
    ...extra,
  };
}

export function boardProject(id: string, state: UiState | undefined, extra: Partial<BoardProject> = {}): BoardProject {
  return {
    id,
    name: id,
    hub: `acme/${id}`,
    apiBase: "",
    legacyHref: "/legacy",
    status: "running",
    idle: false,
    mode: "real",
    state,
    parents: [],
    connected: true,
    ...extra,
  };
}

export const READY_PARENT: ParentOption = { number: 90, title: "ready parent", subIssues: 2, completedSubIssues: 2 };
