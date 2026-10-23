import type { RunModel } from "../model/runModel.js";
import type { UiSink } from "./adapters.js";
import { Engine } from "./engine.js";
import { RecordingAdapters, type PendingStage } from "./fakes.js";

export const DRY_STAGE_DELAY_MIN_MS = 800;
export const DRY_STAGE_DELAY_MAX_MS = 2000;

export interface PacedDryRunOptions {
  workerCap: number;
  now: () => number;
  delayMs: () => number;
  ui?: UiSink;
  failStage?: (pending: PendingStage) => string | undefined;
}

export function randomStageDelay(random: () => number = Math.random): number {
  return DRY_STAGE_DELAY_MIN_MS + Math.floor(random() * (DRY_STAGE_DELAY_MAX_MS - DRY_STAGE_DELAY_MIN_MS));
}

function keyOf(pending: PendingStage): string {
  return `${pending.itemNumber}:${pending.stage}`;
}

export class PacedDryRun {
  readonly adapters: RecordingAdapters;
  readonly engine: Engine;
  private readonly dueAt = new Map<string, number>();

  constructor(model: RunModel, private readonly options: PacedDryRunOptions) {
    this.adapters = new RecordingAdapters(options.ui, (itemNumber) => this.forgetDueTimes(itemNumber));
    this.engine = new Engine(model, this.adapters, { workerCap: options.workerCap });
  }

  start(): void {
    this.engine.start();
    this.schedulePending();
  }

  tick(): void {
    this.schedulePending();
    const now = this.options.now();
    for (const pending of [...this.adapters.pending]) {
      const due = this.dueAt.get(keyOf(pending));
      if (due === undefined || due > now) continue;
      const index = this.adapters.pending.indexOf(pending);
      if (index === -1) continue;
      this.adapters.pending.splice(index, 1);
      this.dueAt.delete(keyOf(pending));
      this.engine.handleStageCompletion(this.completionFor(pending));
    }
    this.schedulePending();
  }

  private completionFor(pending: PendingStage) {
    const detail = this.options.failStage?.(pending);
    if (detail === undefined) return { itemNumber: pending.itemNumber, stage: pending.stage, outcome: "success" as const };
    return { itemNumber: pending.itemNumber, stage: pending.stage, outcome: "failure" as const, detail };
  }

  private forgetDueTimes(itemNumber: number): void {
    for (const key of [...this.dueAt.keys()]) {
      if (key.startsWith(`${itemNumber}:`)) this.dueAt.delete(key);
    }
  }

  private schedulePending(): void {
    const live = new Set(this.adapters.pending.map(keyOf));
    for (const key of [...this.dueAt.keys()]) {
      if (!live.has(key)) this.dueAt.delete(key);
    }
    for (const pending of this.adapters.pending) {
      const key = keyOf(pending);
      if (!this.dueAt.has(key)) this.dueAt.set(key, this.options.now() + this.options.delayMs());
    }
  }
}
