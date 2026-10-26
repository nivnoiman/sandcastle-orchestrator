import { describe, expect, it } from "vitest";
import { Engine } from "../src/engine/engine.js";
import { RecordingAdapters } from "../src/engine/fakes.js";
import { testItem, testModel } from "./fixtures.js";

function clocked() {
  let now = Date.parse("2026-10-21T09:00:00.000Z");
  const adapters = new RecordingAdapters();
  const engine = new Engine(testModel([testItem(1, "api")]), adapters, { workerCap: 1, now: () => now });
  const since = () => engine.view()[0]!.phaseSince;
  const advance = (ms: number) => (now += ms);
  return { engine, adapters, since, advance, iso: () => new Date(now).toISOString() };
}

describe("phase clock", () => {
  it("restarts on start, every stage change and park, and holds still otherwise", () => {
    const { engine, adapters, since, advance, iso } = clocked();
    const created = since();

    advance(5_000);
    engine.start();
    expect(since()).toBe(iso());
    expect(since()).not.toBe(created);

    const started = since();
    advance(5_000);
    expect(since()).toBe(started);

    const first = adapters.pending[0]!;
    adapters.dropPending(1);
    advance(5_000);
    engine.handleStageCompletion({ itemNumber: 1, stage: first.stage, outcome: "success" });
    expect(since()).toBe(iso());

    const afterStage = since();
    advance(5_000);
    const second = adapters.pending[0]!;
    adapters.dropPending(1);
    advance(5_000);
    engine.handleStageCompletion({ itemNumber: 1, stage: second.stage, outcome: "failure", detail: "red" });
    expect(engine.view()[0]!.phase).toBe("parked");
    expect(since()).toBe(iso());
    expect(since()).not.toBe(afterStage);
  });

  it("restarts when a parked item is retried", () => {
    const { engine, adapters, since, advance, iso } = clocked();
    engine.start();
    const stage = adapters.pending[0]!.stage;
    adapters.dropPending(1);
    engine.handleStageCompletion({ itemNumber: 1, stage, outcome: "failure", detail: "x" });
    advance(60_000);
    engine.retryItem(1);
    expect(since()).toBe(iso());
  });
});
