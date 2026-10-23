import type { RunModel } from "../model/runModel.js";
import { Engine, type ItemPhase } from "./engine.js";
import { RecordingAdapters } from "./fakes.js";

export interface DryRunResult {
  lines: string[];
  phases: ReadonlyMap<number, ItemPhase>;
}

export function dryRun(model: RunModel, workerCap: number): DryRunResult {
  const adapters = new RecordingAdapters();
  const engine = new Engine(model, adapters, { workerCap });
  engine.start();
  while (adapters.pending.length > 0) {
    const next = adapters.takeNextPending();
    adapters.log.push(`── ${next.stage} #${next.itemNumber} completed`);
    engine.handleStageCompletion({ ...next, outcome: "success" });
  }
  return { lines: adapters.log, phases: engine.phases() };
}
