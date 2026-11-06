import { describe, expect, it } from "vitest";
import { Engine } from "../../src/engine/engine.js";
import { RecordingAdapters } from "../../src/engine/fakes.js";
import { ParentRunSlot, type Session } from "../../src/ui/parentRunSlot.js";
import { issueUrlOf } from "../../src/ui/state.js";
import { loadRunModel } from "../../src/model/runModel.js";
import { parent, snapshot } from "../fixtures.js";

function slotWith(agentFor: Session["agentFor"]): ParentRunSlot {
  const loaded = loadRunModel(snapshot({ parent: parent({ number: 16 }) }));
  if (!loaded.ok) throw new Error("fixture run model did not load");
  const model = loaded.model;
  const engine = new Engine(model, new RecordingAdapters(), { workerCap: 1 });
  engine.start();
  return new ParentRunSlot(model, { engine, agentFor, tick: () => undefined, stop: () => undefined });
}

describe("item agent in UiState", () => {
  it("maps each item's stage to its resolved agent", () => {
    const asked: string[] = [];
    const slot = slotWith((stage) => {
      asked.push(stage);
      return { provider: "codex", model: "gpt-5.5" };
    });

    const items = slot.view(issueUrlOf("example-org/hub")).items;

    const staged = items.filter((item) => item.stage !== undefined);
    expect(staged.length).toBeGreaterThan(0);
    for (const item of staged) expect(item.agent).toEqual({ provider: "codex", model: "gpt-5.5" });
    expect(asked.every((stage) => typeof stage === "string")).toBe(true);
  });

  it("leaves agent unset without a stage or without a resolver", () => {
    const withResolver = slotWith(() => ({ provider: "claude", model: "opus" }));
    for (const item of withResolver.view(issueUrlOf("example-org/hub")).items) {
      if (item.stage === undefined) expect(item.agent).toBeUndefined();
    }
    for (const item of slotWith(undefined).view(issueUrlOf("example-org/hub")).items) expect(item.agent).toBeUndefined();
  });
});

describe("item context usage in UiState", () => {
  it("resolves usage of each item's stage against its agent model", () => {
    const loaded = loadRunModel(snapshot({ parent: parent({ number: 16 }) }));
    if (!loaded.ok) throw new Error("fixture run model did not load");
    const engine = new Engine(loaded.model, new RecordingAdapters(), { workerCap: 1 });
    engine.start();
    const asked: [number, string | undefined][] = [];
    const attempts = {
      list: () => [],
      read: () => { throw new Error("unused"); },
      contextOf: (item: number, stage?: string) => {
        asked.push([item, stage]);
        return { tokens: 150_000, model: undefined, reportedWindow: undefined };
      },
    };
    const slot = new ParentRunSlot(loaded.model, { engine, attempts, agentFor: () => ({ provider: "claude", model: "claude-opus-4-5" }), tick: () => undefined, stop: () => undefined });
    const staged = slot.view(issueUrlOf("example-org/hub")).items.filter((item) => item.stage !== undefined);
    expect(staged.length).toBeGreaterThan(0);
    for (const item of staged) expect(item.usage).toEqual({ tokens: 150_000, window: 200_000, percent: 75 });
    expect(asked.some(([, stage]) => stage !== undefined)).toBe(true);
  });
});
