import { describe, expect, it } from "vitest";
import { UiController, type UiEvent } from "../../src/ui/controller.js";
import { snapshot } from "../fixtures.js";

function controller() {
  return new UiController({
    mode: "dry",
    hubRepo: "example-org/hub",
    startCap: 1,
    listParents: () => Promise.resolve([]),
    loadSnapshot: () => Promise.resolve(snapshot()),
    startSession: () => {
      throw new Error("unused");
    },
    now: () => new Date("2026-08-15T09:00:00.000Z"),
  });
}

describe("state revision", () => {
  it("bumps rev only when the state changes and keeps boot constant", () => {
    const ui = controller();
    const first = ui.state();
    expect(ui.state().rev).toBe(first.rev);
    ui.noteError("something changed");
    const second = ui.state();
    expect(second.rev).toBe(first.rev + 1);
    expect(second.boot).toBe(first.boot);
    expect(ui.state().rev).toBe(second.rev);
  });

  it("emits state events carrying increasing revs, skipping unchanged publishes", () => {
    const ui = controller();
    const revs: number[] = [];
    ui.subscribe((event: UiEvent) => {
      if (event.kind === "state") revs.push(event.state.rev);
    });
    ui.tick();
    ui.tick();
    ui.setCap(2);
    expect(revs).toEqual([...revs].sort((a, b) => a - b));
    expect(new Set(revs).size).toBe(revs.length);
    expect(revs.length).toBeGreaterThan(0);
  });

  it("still emits a change that a plain state() read already bumped", () => {
    const ui = controller();
    ui.tick();
    const revs: number[] = [];
    ui.subscribe((event: UiEvent) => {
      if (event.kind === "state") revs.push(event.state.rev);
    });
    ui.noteError("changed outside publish");
    const read = ui.state();
    ui.tick();
    expect(revs).toEqual([read.rev]);
  });

  it("gives each controller its own boot id", () => {
    expect(controller().state().boot).not.toBe(controller().state().boot);
  });
});
