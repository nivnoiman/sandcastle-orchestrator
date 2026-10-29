import { STAGE_CHAIN, type HoldReason } from "../engine/adapters.js";
import { stageNames, type StageSpec } from "../engine/stageChain.js";
import type { ItemPhase, ItemView, StallSummary } from "../engine/engine.js";
import type { RunModel } from "../model/runModel.js";
import { hubIssueUrl } from "../real/ghClient.js";
import { idleFeatureVerify, type FeatureVerifyStatus } from "../real/featureVerify/runFeatureVerify.js";
import { idlePolish, type PolishStatus } from "../real/polish/runPolish.js";
import type { QuietInfo } from "./quiet.js";
import type { QueueSettings } from "./runQueue.js";

export type RunMode = "dry" | "real";

export const UI_STAGE_CHAIN = ["queued", ...STAGE_CHAIN, "merged"] as const;

/** The dashboard chain for a run: queued, every configured stage, merged. */
export function uiStageChain(chain: readonly StageSpec[]): string[] {
  return ["queued", ...stageNames(chain), "merged"];
}

export interface UiItem extends ItemView {
  issueUrl: string;
  /** Set while the item's agent is Quiet; Stall stays run-only. */
  quiet: QuietInfo | undefined;
}

export interface UiParent {
  number: number;
  title: string;
  feature: string;
  integrationBranch: string;
  url: string;
}

export type FeedKind = "warn" | "stall" | "note";

export interface UiFeedLine {
  at: string;
  kind: FeedKind;
  itemNumber: number | undefined;
  parentNumber?: number | undefined;
  message: string;
}

export interface UiAuthProbe {
  running: boolean;
  error: string | undefined;
}

export interface UiHold {
  reason: HoldReason;
  until: string | undefined;
  probe?: UiAuthProbe;
}

export interface UiRun {
  parent: UiParent;
  cap: number;
  paused: boolean;
  started: boolean;
  complete: boolean;
  settled: boolean;
  running: number;
  stalled: StallSummary | undefined;
  hold: UiHold | undefined;
  featureVerify: FeatureVerifyStatus;
  polish: PolishStatus;
  phaseCounts: Record<ItemPhase, number>;
  items: UiItem[];
}

export interface UiQueueSettings extends QueueSettings {
  paused: boolean;
}

export interface UiState {
  version: 2;
  /** Bumps whenever the state changes; orders states within one `boot`. */
  rev: number;
  /** Per-process id; a new boot restarts `rev`, so rev is never compared across boots. */
  boot: string;
  /** `queued`, the configured stage chain, `merged`. */
  stages: string[];
  mode: RunMode;
  hubRepo: string;
  startCap: number;
  preselectedParent: number | undefined;
  parent: UiParent | undefined;
  cap: number;
  paused: boolean;
  started: boolean;
  complete: boolean;
  running: number;
  stalled: StallSummary | undefined;
  hold: UiHold | undefined;
  canStart: boolean;
  featureVerify: FeatureVerifyStatus;
  polish: PolishStatus;
  canReset: boolean;
  resetting: boolean;
  phaseCounts: Record<ItemPhase, number>;
  queue: number[];
  queueCap: number;
  queueSettings: UiQueueSettings;
  runs: UiRun[];
  globalRunning: number;
  items: UiItem[];
  feed: UiFeedLine[];
}

export function issueUrl(hubRepo: string, itemNumber: number): string {
  return hubIssueUrl(hubRepo, itemNumber);
}

export function featureVerifyLabel(status: FeatureVerifyStatus): string {
  const counts = `${status.counts.pass} pass, ${status.counts.fail} fail, ${status.counts.requiresStg} requires-STG`;
  const round = status.rework ? ` (fix round ${status.rework.round}/${status.rework.limit})` : "";
  if (status.phase === "waiting") return `feature verify: waiting for another parent's verify${round}`;
  if (status.phase === "running") return `feature verify: running${round}`;
  if (status.phase === "fixing") return `feature verify: fixing${round} — ${status.reason ?? counts}`;
  if (status.phase === "green") return `feature verify: green (${counts})`;
  if (status.phase === "red") return `feature verify: red — ${status.reason ?? counts}`;
  if (status.phase === "skipped") return "feature verify: skipped";
  return "feature verify: idle";
}

export function polishLabel(status: PolishStatus): string {
  if (status.phase === "running") return "polish: running";
  if (status.phase === "green") return "polish: green";
  if (status.phase === "reverted") return `polish: reverted — ${status.reason ?? "no reason recorded"}`;
  if (status.phase === "skipped") return `polish: skipped — ${status.reason ?? "nothing to polish"}`;
  return "polish: idle";
}

export { idleFeatureVerify, idlePolish };
export type { FeatureVerifyStatus, PolishStatus };

export function uiParent(hubRepo: string, model: RunModel): UiParent {
  return {
    number: model.parentNumber,
    title: model.title,
    feature: model.feature,
    integrationBranch: model.integrationBranch,
    url: issueUrl(hubRepo, model.parentNumber),
  };
}

export function uiItems(
  hubRepo: string,
  views: readonly ItemView[],
  quietFor: (view: ItemView) => QuietInfo | undefined = () => undefined,
): UiItem[] {
  return views.map((view) => ({ ...view, issueUrl: issueUrl(hubRepo, view.number), quiet: quietFor(view) }));
}

function zeroPhaseCounts(): Record<ItemPhase, number> {
  return {
    held: 0,
    blocked: 0,
    queued: 0,
    running: 0,
    awaiting: 0,
    waiting: 0,
    parked: 0,
    done: 0,
  };
}

export const ITEM_PHASES = [
  "held",
  "blocked",
  "queued",
  "running",
  "awaiting",
  "waiting",
  "parked",
  "done",
] as const satisfies readonly ItemPhase[];

export function uiHold(engine: { holdState(): { reason: HoldReason; until: number | undefined } | undefined } | undefined): UiHold | undefined {
  const hold = engine?.holdState();
  if (!hold) return undefined;
  return { reason: hold.reason, until: hold.until === undefined ? undefined : new Date(hold.until).toISOString() };
}

export function phaseCounts(views: readonly ItemView[]): Record<ItemPhase, number> {
  const counts = zeroPhaseCounts();
  for (const view of views) counts[view.phase] += 1;
  return counts;
}
