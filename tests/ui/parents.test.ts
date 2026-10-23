import { describe, expect, it } from "vitest";
import { isParentReference, parseParentInputs } from "../../src/gh/parentInput.js";
import { UiController, type Session, type StartSessionRequest } from "../../src/ui/controller.js";
import { Engine } from "../../src/engine/engine.js";
import { RecordingAdapters } from "../../src/engine/fakes.js";

import type { RunSnapshot } from "../../src/gh/snapshot.js";
import { parent, snapshot } from "../fixtures.js";

const PARENTS = [{ number: 16, title: "demo: toy feature", subIssues: 3, completedSubIssues: 0 }];

interface Harness {
  controller: UiController;
  started: number[];
  settle: () => void;
}

function doneSnapshot(parentNumber: number): RunSnapshot {
  const base = snapshot({ parent: parent({ number: parentNumber }) });
  return { ...base, subIssues: base.subIssues.map((sub) => ({ ...sub, state: "CLOSED" as const })) };
}

interface HarnessOptions {
  loadSnapshot?: (parentNumber: number) => Promise<RunSnapshot>;
  runsForever?: boolean;
}

function harness(options: HarnessOptions = {}): Harness {
  const started: number[] = [];
  let settleRun = (): void => undefined;
  const controller = new UiController({
    mode: "real",
    hubRepo: "example-org/hub",
    startCap: 1,
    listParents: () => Promise.resolve(PARENTS),
    loadSnapshot:
      options.loadSnapshot ??
      ((parentNumber: number) =>
        Promise.resolve(
          options.runsForever ? snapshot({ parent: parent({ number: parentNumber }) }) : doneSnapshot(parentNumber),
        )),
    startSession: (request: StartSessionRequest): Session => {
      started.push(request.model.parentNumber);
      const engine = new Engine(request.model, new RecordingAdapters(), { workerCap: request.workerCap });
      engine.start();
      const finished = new Promise<void>((resolve) => {
        settleRun = resolve;
      });
      return { engine, finished, tick: () => undefined, stop: () => undefined };
    },
    now: () => new Date("2026-09-06T09:00:00.000Z"),
  });
  return { controller, started, settle: () => settleRun() };
}

describe("parsing what an operator pastes", () => {
  it("takes bare numbers, #numbers and issue urls, one per line", () => {
    const parsed = parseParentInputs("99\n#120\nhttps://github.com/example-org/hub/issues/121\n\n");

    expect(parsed.filter(isParentReference).map((entry) => entry.number)).toEqual([99, 120, 121]);
    expect(parsed.filter(isParentReference)[2]?.repo).toBe("example-org/hub");
  });

  it("names what it could not read instead of dropping the line", () => {
    const [parsed] = parseParentInputs("not-an-issue");

    expect(parsed).toEqual({ input: "not-an-issue", error: "not an issue number or a github issue url" });
  });
});

describe("adding a parent from the control plane", () => {
  it("fetches each one and reports it per line", async () => {
    const { controller } = harness();

    const checked = await controller.addParents("99\nnonsense");

    expect(checked[0]).toMatchObject({ ok: true, number: 99 });
    expect(checked[1]).toMatchObject({ ok: false, error: "not an issue number or a github issue url" });
    expect((await controller.parents()).map((entry) => entry.number)).toEqual([16, 99]);
  });

  it("rejects an issue from another repo rather than fetching it", async () => {
    const { controller } = harness({
      loadSnapshot: () => Promise.reject(new Error("gh should not have been called")),
    });

    const [checked] = await controller.addParents("https://github.com/other/repo/issues/4");

    expect(checked).toMatchObject({ ok: false });
    expect(checked?.error).toContain("runs example-org/hub");
  });

  it("reports a parent that does not satisfy the publish contract without adding it", async () => {
    const { controller } = harness({
      loadSnapshot: (parentNumber) =>
        Promise.resolve(snapshot({ parent: parent({ number: parentNumber, body: "no yaml fence here" }) })),
    });

    const [checked] = await controller.addParents("99");

    expect(checked?.ok).toBe(false);
    expect((await controller.parents()).map((entry) => entry.number)).toEqual([16]);
  });

  it("refuses an empty paste", async () => {
    await expect(harness().controller.addParents("   \n")).rejects.toThrow(/one issue number or issue url per line/);
  });
});

describe("queueing runs back to back", () => {
  it("starts the first immediately and the next once its items are done, before it has settled", async () => {
    const { controller, started } = harness();

    await controller.queueRuns([99, 120], 2);

    expect(started).toEqual([99]);
    expect(controller.state().queue).toEqual([120]);

    controller.tick();
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();

    expect(started).toEqual([99, 120]);
    expect(controller.state().queue).toEqual([]);
  });

  it("queues everything behind a run that is still in flight", async () => {
    const { controller, started } = harness({ runsForever: true });
    await controller.startRun({ parent: 99, cap: 1 });

    await controller.queueRuns([120, 121], 2);

    expect(started).toEqual([99]);
    expect(controller.state().queue).toEqual([120, 121]);
    expect(controller.state().queueCap).toBe(2);
  });

  it("allows a manual start once the previous run's items are done, even before it settles", async () => {
    const { controller, started } = harness();
    await controller.startRun({ parent: 99, cap: 1 });

    expect(controller.state().canStart).toBe(true);
    await controller.startRun({ parent: 120, cap: 1 });
    expect(started).toEqual([99, 120]);
  });

  it("lets an operator drop the queue", async () => {
    const { controller } = harness({ runsForever: true });
    await controller.startRun({ parent: 99, cap: 1 });
    await controller.queueRuns([120], 1);

    controller.clearQueue();

    expect(controller.state().queue).toEqual([]);
  });
});
