import { describe, expect, it } from "vitest";
import { Engine } from "../../src/engine/engine.js";
import { RecordingAdapters } from "../../src/engine/fakes.js";
import type { UiSink } from "../../src/engine/adapters.js";
import type { AttemptRecord } from "../../src/real/attemptLog.js";
import type { ResetPlan } from "../../src/real/reset.js";
import { UiController, type ResetOps, type Session, type StartSessionRequest } from "../../src/ui/controller.js";
import { RunQueue, type QueueFile } from "../../src/ui/runQueue.js";
import { item, parent, snapshot } from "../fixtures.js";

interface FakeRun {
  engine: Engine;
  sink: UiSink;
  stopped: boolean;
  itemsDone(): void;
  settle(): void;
}

interface HarnessOptions {
  restored?: QueueFile;
  globalCap?: { get(): number; set(value: number): void };
  reset?: ResetOps;
  unloadable?: number[];
  held?: number[];
}

function attemptRecord(id: string, itemNumber: number): AttemptRecord {
  return {
    id,
    itemNumber,
    stage: "develop",
    attempt: 1,
    startedAt: "2026-10-21T09:00:00.000Z",
    endedAt: undefined,
    outcome: undefined,
    bytes: 0,
    file: `${id}.jsonl`,
  };
}

function itemOf(parentNumber: number): number {
  return parentNumber + 1;
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

function harness(options: HarnessOptions = {}) {
  const runs = new Map<number, FakeRun>();
  const started: number[] = [];
  const persisted: QueueFile[] = [];
  const saves = { failing: false };
  const heldLoads = new Map<number, { resolve: () => void; reject: (cause: Error) => void }>();
  const loadedSnapshot = (parentNumber: number) =>
    snapshot({ parent: parent({ number: parentNumber }), subIssues: [item({ number: itemOf(parentNumber) })] });
  const queue = new RunQueue(options.restored, { globalCap: 4, parentCap: 1 }, (file) => {
    if (saves.failing) throw new Error("disk full");
    persisted.push(file);
  });
  const controller = new UiController({
    mode: "real",
    hubRepo: "example-org/hub",
    startCap: 1,
    listParents: () => Promise.resolve([]),
    loadSnapshot: (parentNumber) =>
      options.held?.includes(parentNumber)
        ? new Promise((resolve, reject) =>
            heldLoads.set(parentNumber, { resolve: () => resolve(loadedSnapshot(parentNumber)), reject }),
          )
        : options.unloadable?.includes(parentNumber)
        ? Promise.reject(new Error(`#${parentNumber} is gone`))
        : Promise.resolve(loadedSnapshot(parentNumber)),
    startSession: (request: StartSessionRequest): Session => {
      const parentNumber = request.model.parentNumber;
      started.push(parentNumber);
      const engine = new Engine(request.model, new RecordingAdapters(), { workerCap: request.workerCap });
      engine.start();
      let done = false;
      engine.complete = () => done;
      let resolveFinished = (): void => undefined;
      const finished = new Promise<void>((resolve) => {
        resolveFinished = resolve;
      });
      const run: FakeRun = {
        engine,
        sink: request.sink,
        stopped: false,
        itemsDone: () => {
          done = true;
        },
        settle: () => resolveFinished(),
      };
      runs.set(parentNumber, run);
      const ownId = `${itemOf(parentNumber)}-develop-1`;
      const polishId = `${parentNumber}-polish-1`;
      return {
        engine,
        finished,
        attempts: {
          list: (itemNumber) => {
            if (itemNumber === parentNumber) return [attemptRecord(polishId, parentNumber)];
            return itemNumber === undefined || itemNumber === itemOf(parentNumber) ? [attemptRecord(ownId, itemOf(parentNumber))] : [];
          },
          read: (id) => {
            if (id !== ownId && id !== polishId) throw new Error(`${id} is not in #${parentNumber}'s logs`);
            return { id, from: 0, next: 0, chunk: `log of ${id} from #${parentNumber}`, running: false };
          },
        },
        tick: () => undefined,
        stop: () => {
          run.stopped = true;
        },
      };
    },
    queue,
    globalCap: options.globalCap,
    reset: options.reset,
    now: () => new Date("2026-10-21T09:00:00.000Z"),
  });
  const run = (parentNumber: number): FakeRun => {
    const found = runs.get(parentNumber);
    if (!found) throw new Error(`#${parentNumber} never started`);
    return found;
  };
  const heldLoad = (parentNumber: number) => {
    const held = heldLoads.get(parentNumber);
    if (!held) throw new Error(`#${parentNumber} has no held load`);
    return held;
  };
  const failLoad = (parentNumber: number): void => heldLoad(parentNumber).reject(new Error(`#${parentNumber} is gone`));
  const releaseLoad = (parentNumber: number): void => heldLoad(parentNumber).resolve();
  return { controller, queue, started, persisted, saves, run, failLoad, releaseLoad };
}

const EMPTY_PLAN: ResetPlan = {
  lock: { path: "/w/sandcastle/.orchestrator.lock", reclaim: false, pid: undefined },
  labels: [],
  branches: [],
  orphans: { containers: [], networks: [], volumes: [], worktrees: [], failures: [] },
};

const RESET: ResetOps = {
  plan: () => Promise.resolve(EMPTY_PLAN),
  apply: () =>
    Promise.resolve({
      gc: { containers: [], networks: [], volumes: [], worktrees: [], failures: [] },
      lockReclaimed: false,
      labelled: [],
      deletedBranches: [],
      failures: [],
    }),
};

describe("sequential queue across parents", () => {
  it("starts the next parent once the previous one's items are done, without waiting for its verify to settle", async () => {
    const { controller, started, run } = harness();
    await controller.queueRuns([100, 200], 2);
    expect(started).toEqual([100]);

    controller.tick();
    await flush();
    expect(started).toEqual([100]);

    run(100).itemsDone();
    controller.tick();
    await flush();
    expect(started).toEqual([100, 200]);
    expect(controller.state().queue).toEqual([]);
    expect(controller.state().runs.map((entry) => [entry.parent.number, entry.settled])).toEqual([
      [100, false],
      [200, false],
    ]);
  });

  it("a stopped parent no longer holds the queue even before its run settles", async () => {
    const { controller, started } = harness();
    await controller.queueRuns([100, 200], 1);
    controller.stopRun(100);
    controller.tick();
    await flush();
    expect(started).toEqual([100, 200]);
  });

  it("a run that settles with items left undone no longer holds the queue", async () => {
    const { controller, started, run } = harness();
    await controller.queueRuns([100, 200], 1);
    run(100).settle();
    await flush();
    expect(started).toEqual([100, 200]);
  });

  it("refuses a manual start while another parent's items are in flight", async () => {
    const { controller, started } = harness();
    await controller.startRun({ parent: 100, cap: 1 });
    expect(controller.state().canStart).toBe(false);
    await expect(controller.startRun({ parent: 200, cap: 1 })).rejects.toThrow(/already in flight — queue it instead/);
    expect(started).toEqual([100]);
  });
});

describe("a queued parent whose start fails", () => {
  it("goes back to the front of the queue and pauses it", async () => {
    const { controller, started, run } = harness({ unloadable: [200] });
    await controller.queueRuns([100, 200, 300], 1);
    run(100).itemsDone();
    controller.tick();
    await flush();

    expect(started).toEqual([100]);
    expect(controller.state().queue).toEqual([200, 300]);
    expect(controller.state().queueSettings.paused).toBe(true);
    expect(controller.state().feed.at(-1)).toMatchObject({
      kind: "warn",
      message: "queued run #200 could not start: #200 is gone — the queue is paused; resume it or remove #200",
    });
  });

  it("keeps the queue order when several parallel starts fail", async () => {
    const { controller, started } = harness({ unloadable: [100, 200] });
    controller.setQueueMode("parallel", 2);
    await controller.queueRuns([100, 200, 300], 1);

    expect(started).toEqual([]);
    expect(controller.state().queue).toEqual([100, 200, 300]);
    expect(controller.state().queueSettings.paused).toBe(true);

    controller.resumeQueue();
    await flush();
    expect(controller.state().queue).toEqual([100, 200, 300]);
  });

  it("an explicit start that fails puts a queued parent back at the front and throws", async () => {
    const restored: QueueFile = { version: 1, mode: "sequential", maxParallel: 2, globalCap: 3, parentCap: 1, parents: [200, 300] };
    const { controller, started } = harness({ restored, unloadable: [300] });

    await expect(controller.startRun({ parent: 300, cap: 1 })).rejects.toThrow("#300 is gone");
    await flush();

    expect(started).toEqual([]);
    expect(controller.state().queue).toEqual([300, 200]);
    expect(controller.state().queueSettings.paused).toBe(true);
  });
});

describe("a queue that cannot be saved", () => {
  it("keeps the scheduler alive and pauses the queue with a warning", async () => {
    const { controller, saves, run } = harness();
    await controller.queueRuns([100, 200], 1);
    saves.failing = true;
    run(100).itemsDone();

    expect(() => controller.tick()).not.toThrow();
    await flush();

    expect(controller.state().queue).toEqual([200]);
    expect(controller.state().queueSettings.paused).toBe(true);
    expect(controller.state().feed.at(-1)).toMatchObject({
      kind: "warn",
      message: "could not save the queue: disk full — the queue is paused",
    });
  });

  it("an operator change that cannot be saved throws to the caller", async () => {
    const { controller, saves } = harness();
    await controller.queueRuns([100, 200], 1);
    saves.failing = true;
    expect(() => controller.removeQueued(200)).toThrow("disk full");
    expect(controller.state().queueSettings.paused).toBe(true);
  });

  it("keeps the live global cap when the new one cannot be saved", () => {
    let applied = 4;
    const { controller, saves } = harness({ globalCap: { get: () => applied, set: (value) => (applied = value) } });
    saves.failing = true;
    expect(() => controller.setCap(6)).toThrow("disk full");
    expect(applied).toBe(4);
  });

  it("a scheduled start that fails and cannot be re-queued says to re-queue it by hand", async () => {
    const { controller, saves, run, failLoad } = harness({ held: [200] });
    await controller.queueRuns([100, 200], 1);
    run(100).itemsDone();
    controller.tick();
    await flush();
    saves.failing = true;
    failLoad(200);
    await flush();

    expect(controller.state().queue).toEqual([]);
    expect(controller.state().feed.at(-1)).toMatchObject({
      kind: "warn",
      message:
        "queued run #200 could not start: #200 is gone — the queue is paused; re-queue #200 by hand once the queue file can be saved",
    });
  });

  it("a queued parent started by hand that fails keeps its start error when the requeue cannot be saved", async () => {
    const restored: QueueFile = { version: 1, mode: "sequential", maxParallel: 2, globalCap: 3, parentCap: 1, parents: [100, 200] };
    const { controller, saves, failLoad } = harness({ restored, held: [100] });
    const starting = controller.startRun({ parent: 100, cap: 1 });
    await flush();
    saves.failing = true;
    failLoad(100);

    await expect(starting).rejects.toThrow("#100 is gone");
    expect(controller.state().queue).toEqual([200]);
    expect(controller.state().queueSettings.paused).toBe(true);
    expect(controller.state().feed.at(-1)).toMatchObject({
      kind: "warn",
      message: "could not save the queue: disk full — the queue is paused",
    });
  });
});

describe("a parent removed while its queued start is in flight", () => {
  const couldNotStart = (message: string): boolean => message.startsWith("queued run #100 could not start: #100 is gone");

  it("stays out of the queue when the start then fails", async () => {
    const { controller, failLoad } = harness({ held: [100] });
    const queued = controller.queueRuns([100, 200], 1);
    await flush();
    controller.removeQueued(100);
    failLoad(100);
    await queued;
    await flush();

    expect(controller.state().queue).toEqual([200]);
    expect(controller.state().feed.some((line) => line.kind === "warn" && couldNotStart(line.message))).toBe(true);
  });

  it("says so when the start then succeeds, since the run keeps going", async () => {
    const { controller, started, releaseLoad } = harness({ held: [100] });
    const queued = controller.queueRuns([100, 200], 1);
    await flush();
    controller.removeQueued(100);
    releaseLoad(100);
    await queued;
    await flush();

    expect(started).toEqual([100]);
    expect(controller.state().feed.map((line) => line.message)).toContain(
      "#100 started before it left the queue — stop it from its tab if it should not run",
    );
  });

  it("stays out after the queue is cleared", async () => {
    const { controller, failLoad } = harness({ held: [100] });
    const queued = controller.queueRuns([100, 200], 1);
    await flush();
    controller.clearQueue();
    failLoad(100);
    await queued;
    await flush();

    expect(controller.state().queue).toEqual([]);
    expect(controller.state().feed.some((line) => line.kind === "warn" && couldNotStart(line.message))).toBe(true);
  });
});

describe("parallel queue across parents", () => {
  it("runs up to maxParallel parents at once and holds the third", async () => {
    const { controller, started, run } = harness();
    controller.setQueueMode("parallel", 2);
    await controller.queueRuns([100, 200, 300], 1);
    controller.tick();
    await flush();
    expect(started).toEqual([100, 200]);
    expect(controller.state().queue).toEqual([300]);
    await expect(controller.startRun({ parent: 400, cap: 1 })).rejects.toThrow(/parallel limit/);

    run(200).itemsDone();
    controller.tick();
    await flush();
    expect(started).toEqual([100, 200, 300]);
  });
});

describe("a queue restored from disk", () => {
  const restored: QueueFile = { version: 1, mode: "sequential", maxParallel: 2, globalCap: 3, parentCap: 2, parents: [100] };

  it("waits paused until the operator resumes it", async () => {
    const { controller, started } = harness({ restored });
    expect(controller.state().queueSettings).toMatchObject({ paused: true, globalCap: 3, parentCap: 2 });
    controller.tick();
    await flush();
    expect(started).toEqual([]);

    const publishedRuns: number[] = [];
    controller.subscribe((event) => {
      if (event.kind === "state") publishedRuns.push(event.state.runs.length);
    });
    controller.resumeQueue();
    await flush();
    expect(started).toEqual([100]);
    expect(publishedRuns.at(-1)).toBe(1);
    expect(controller.state().queueSettings.paused).toBe(false);
    expect(controller.state().runs[0]?.cap).toBe(2);
  });

  it("stays paused when more parents are queued or one is started by hand", async () => {
    const { controller, started } = harness({ restored });
    await controller.queueRuns([200], 1);
    await controller.startRun({ parent: 300, cap: 1 });
    await flush();
    expect(started).toEqual([300]);
    expect(controller.state().queue).toEqual([100, 200]);
    expect(controller.state().queueSettings.paused).toBe(true);
  });
});

describe("one parent, one run", () => {
  it("refuses to start or queue a parent that is already running", async () => {
    const { controller, started, run } = harness();
    controller.setQueueMode("parallel", 3);
    await controller.startRun({ parent: 100, cap: 1 });
    await expect(controller.startRun({ parent: 100, cap: 1 })).rejects.toThrow(/#100 is already running/);
    await expect(controller.queueRuns([100], 1)).rejects.toThrow(/#100 is already running/);

    run(100).itemsDone();
    await expect(controller.startRun({ parent: 100, cap: 1 })).rejects.toThrow(/#100 is already running/);
    run(100).settle();
    await flush();
    await controller.startRun({ parent: 100, cap: 1 });
    expect(started).toEqual([100, 100]);
    expect(controller.state().runs).toHaveLength(1);
  });
});

describe("per-run and item operations", () => {
  async function twoRuns() {
    const booted = harness();
    booted.controller.setQueueMode("parallel", 2);
    await booted.controller.startRun({ parent: 100, cap: 1 });
    await booted.controller.startRun({ parent: 200, cap: 1 });
    return booted;
  }

  it("routes item and attempt operations to the run that owns the item", async () => {
    const { controller } = await twoRuns();
    controller.cancelItem(201);
    const phases = controller.state().runs.map((entry) => [entry.parent.number, entry.items[0]?.phase]);
    expect(phases).toEqual([
      [100, "running"],
      [200, "parked"],
    ]);
    expect(controller.attempts(201).map((record) => record.id)).toEqual(["201-develop-1"]);
    expect(controller.attempts().map((record) => record.id).sort()).toEqual(["101-develop-1", "201-develop-1"]);
    expect(controller.attemptLog("201-develop-1").chunk).toBe("log of 201-develop-1 from #200");
    expect(controller.attemptLog("100-polish-1").chunk).toBe("log of 100-polish-1 from #100");
    expect(controller.attempts(100).map((record) => record.id)).toEqual(["100-polish-1"]);
    expect(() => controller.cancelItem(999)).toThrow(/#999 is not an item of any run/);
  });

  it("pauses, caps and stops one parent without touching the other", async () => {
    const { controller, run } = await twoRuns();
    controller.pauseRun(200);
    controller.setRunCap(200, 3);
    const byParent = (parentNumber: number) => controller.state().runs.find((entry) => entry.parent.number === parentNumber);
    expect(byParent(200)).toMatchObject({ paused: true, cap: 3 });
    expect(byParent(100)).toMatchObject({ paused: false, cap: 1 });
    controller.resumeRun(200);
    expect(byParent(200)?.paused).toBe(false);
    controller.stopRun(200);
    expect(run(200).stopped).toBe(true);
    expect(run(100).stopped).toBe(false);
    expect(() => controller.pauseRun(300)).toThrow(/#300 has no run/);
  });

  it("legacy pause and resume act on every live run", async () => {
    const { controller } = await twoRuns();
    controller.pause();
    expect(controller.state().runs.every((entry) => entry.paused)).toBe(true);
    controller.resume();
    expect(controller.state().runs.some((entry) => entry.paused)).toBe(false);
  });

  it("feed lines carry the parent of the run that wrote them", async () => {
    const { controller, run } = await twoRuns();
    run(200).sink.warn(201, "slow");
    run(100).sink.note(undefined, "hello");
    const lines = controller.state().feed;
    expect(lines.find((line) => line.message === "slow")?.parentNumber).toBe(200);
    expect(lines.find((line) => line.message === "hello")?.parentNumber).toBe(100);
    expect(lines.find((line) => line.message.includes("run started — #200"))?.parentNumber).toBe(200);
  });

  it("legacy top-level state mirrors the most recently started live run, and runs lists both", async () => {
    const { controller, run } = await twoRuns();
    expect(controller.state()).toMatchObject({ version: 2, parent: { number: 200 }, globalRunning: 2 });
    expect(controller.state().items.map((entry) => entry.number)).toEqual([201]);
    expect(controller.state().runs.map((entry) => entry.parent.number)).toEqual([100, 200]);

    run(200).itemsDone();
    run(200).settle();
    await flush();
    expect(controller.state().parent?.number).toBe(100);
  });
});

describe("global cap and reset", () => {
  it("legacy setCap sets the global cap through the injected dependency", () => {
    let applied = 4;
    const { controller, persisted } = harness({ globalCap: { get: () => applied, set: (value) => (applied = value) } });
    controller.setCap(6);
    expect(applied).toBe(6);
    expect(persisted.at(-1)?.globalCap).toBe(6);
    expect(controller.state().queueSettings.globalCap).toBe(6);
  });

  it("refuses reset while any run has not settled, even once its items are done", async () => {
    const { controller, run } = harness({ reset: RESET });
    await controller.startRun({ parent: 100, cap: 1 });
    run(100).itemsDone();
    expect(controller.state().canReset).toBe(false);
    await expect(controller.resetPlan(100)).rejects.toThrow(/stop it before resetting/);
    run(100).settle();
    await flush();
    expect(controller.state().canReset).toBe(true);
    await expect(controller.resetPlan(100)).resolves.toEqual(EMPTY_PLAN);
  });
});
