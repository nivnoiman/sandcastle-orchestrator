import { describe, expect, it } from "vitest";
import { fakePullRequestUrl } from "../src/engine/fakes.js";
import { harness, spawnOrder, testItem, testModel } from "./fixtures.js";

describe("cancelItem", () => {
  it("kills the stage, parks the item with the operator reason, and hands the slot on", () => {
    const { adapters, engine } = harness(testModel([testItem(17, "api"), testItem(18, "api")]));
    engine.start();

    engine.cancelItem(17);

    expect(adapters.killed).toEqual([17]);
    expect(engine.phases().get(17)).toBe("parked");
    expect(adapters.log).toContain("add-label #17 sc:needs-human");
    expect(adapters.log).toContain("swap-labels #17 ready-for-agent→ready-for-human");
    expect(adapters.comments.at(-1)?.body).toContain("cancelled by operator");
    expect(spawnOrder(adapters.log)).toEqual(["spawn develop #17", "spawn develop #18"]);
  });

  it("drops the killed stage so no completion can arrive for it", () => {
    const { adapters, engine } = harness(testModel([testItem(17, "api")]));
    engine.start();

    engine.cancelItem(17);

    expect(adapters.pending).toEqual([]);
  });

  it("records the park reason on the item view", () => {
    const { engine } = harness(testModel([testItem(17, "api")]));
    engine.start();

    engine.cancelItem(17);

    expect(engine.view()[0]?.parkReason).toBe("cancelled by operator");
  });

  it("refuses to cancel an item that is not running", () => {
    const { engine } = harness(testModel([testItem(17, "api"), testItem(18, "api")]));
    engine.start();

    expect(() => engine.cancelItem(18)).toThrow("#18 is queued, not running");
  });

  it("refuses to cancel an item that is not in the run", () => {
    const { engine } = harness(testModel([testItem(17, "api")]));
    engine.start();

    expect(() => engine.cancelItem(99)).toThrow("#99 is not in the run");
  });
});

describe("retryItem", () => {
  it("flips the labels back and re-enters at the stage the item died at", () => {
    const { adapters, engine, complete } = harness(testModel([testItem(17, "api")]));
    engine.start();
    complete(17, "develop");
    complete(17, "simplify", "failure");

    engine.retryItem(17);

    expect(adapters.log).toContain("swap-labels #17 ready-for-human→ready-for-agent");
    expect(adapters.log).toContain("remove-label #17 sc:needs-human");
    expect(spawnOrder(adapters.log)).toEqual(["spawn develop #17", "spawn simplify #17", "spawn simplify #17"]);
    expect(engine.phases().get(17)).toBe("running");
    expect(engine.view()[0]?.parkReason).toBeUndefined();
  });

  it("leaves the retried item awaiting its turn while every slot is busy", () => {
    const { engine, complete } = harness(testModel([testItem(17, "api"), testItem(18, "api")]));
    engine.start();
    complete(17, "develop", "failure");

    engine.retryItem(17);

    expect(engine.phases().get(17)).toBe("awaiting");
    expect(engine.phases().get(18)).toBe("running");
  });

  it("refuses to retry an item that is not parked", () => {
    const { engine } = harness(testModel([testItem(17, "api")]));
    engine.start();

    expect(() => engine.retryItem(17)).toThrow("#17 is running, not parked");
  });
});

describe("pausing new starts", () => {
  const model = testModel([testItem(21, "api"), testItem(22, "api"), testItem(23, "api")]);

  it("keeps in-flight items advancing through their chain but starts nothing new", () => {
    const { adapters, engine, complete } = harness(model, 2);
    engine.start();

    engine.pauseNewStarts();
    complete(21, "develop");
    complete(21, "simplify");

    expect(engine.newStartsArePaused()).toBe(true);
    expect(spawnOrder(adapters.log)).toEqual([
      "spawn develop #21",
      "spawn develop #22",
      "spawn simplify #21",
      "spawn review #21",
    ]);
  });

  it("fills the free slots the moment new starts resume", () => {
    const { adapters, engine, complete } = harness(model, 2);
    engine.start();
    engine.pauseNewStarts();
    complete(21, "develop");
    complete(21, "simplify");
    complete(21, "review");
    complete(21, "verify");

    expect(engine.phases().get(23)).toBe("queued");

    engine.resumeNewStarts();

    expect(engine.newStartsArePaused()).toBe(false);
    expect(spawnOrder(adapters.log).at(-1)).toBe("spawn develop #23");
  });
});

describe("setWorkerCap", () => {
  const model = testModel([testItem(21, "api"), testItem(22, "api"), testItem(23, "api")]);

  it("fills the new slots immediately when the cap is raised", () => {
    const { adapters, engine } = harness(model);
    engine.start();

    engine.setWorkerCap(3);

    expect(engine.cap()).toBe(3);
    expect(engine.running()).toBe(3);
    expect(spawnOrder(adapters.log)).toEqual(["spawn develop #21", "spawn develop #22", "spawn develop #23"]);
  });

  it("takes a lowered cap into account only as slots free", () => {
    const { adapters, engine, complete } = harness(model, 3);
    engine.start();

    engine.setWorkerCap(1);
    expect(engine.running()).toBe(3);

    complete(21, "develop");
    complete(22, "develop");
    expect(spawnOrder(adapters.log)).toEqual(["spawn develop #21", "spawn develop #22", "spawn develop #23"]);

    complete(23, "develop");
    expect(spawnOrder(adapters.log).at(-1)).toBe("spawn simplify #21");
    expect(engine.running()).toBe(1);
  });

  it("refuses a cap that is not a positive integer", () => {
    const { engine } = harness(model);
    engine.start();

    expect(() => engine.setWorkerCap(0)).toThrow("workerCap must be a positive integer, got 0");
    expect(() => engine.setWorkerCap(1.5)).toThrow("workerCap must be a positive integer, got 1.5");
  });
});

describe("view", () => {
  it("carries the stage cursor, the branch, and the blockers each item is waiting on", () => {
    const { engine } = harness(testModel([testItem(17, "api"), testItem(18, "web", [17])]));
    engine.start();

    expect(engine.view()).toEqual([
      {
        number: 17,
        title: "slice 17",
        repo: "api",
        phase: "running",
        stage: "develop",
        stageIndex: 0,
        branch: "feat/17-slice-17",
        dependsOn: [],
        blockers: [],
        parkReason: undefined,
        pullRequestUrl: undefined,
        reworkRound: 0,
        reworkLimit: 3,
      },
      {
        number: 18,
        title: "slice 18",
        repo: "web",
        phase: "blocked",
        stage: "develop",
        stageIndex: 0,
        branch: "feat/18-slice-18",
        dependsOn: [17],
        blockers: [17],
        parkReason: undefined,
        pullRequestUrl: undefined,
        reworkRound: 0,
        reworkLimit: 3,
      },
    ]);
  });

  it("links the pull request a stage reported, and keeps the link when a later stage parks the item", () => {
    const { adapters, engine, complete } = harness(testModel([testItem(17, "api")]));
    const draft = "https://github.com/example-org/api/pull/42";
    engine.start();
    adapters.dropPending(17);
    engine.handleStageCompletion({ itemNumber: 17, stage: "develop", outcome: "success", pullRequestUrl: draft });

    expect(engine.view()[0]?.pullRequestUrl).toBe(draft);

    complete(17, "simplify", "failure");

    expect(engine.view()[0]).toMatchObject({ phase: "parked", pullRequestUrl: draft });
  });

  it("names the merged pull request and empties the stage cursor once an item is done", () => {
    const { engine, drainAll } = harness(testModel([testItem(17, "api")]));
    engine.start();
    drainAll();

    expect(engine.view()[0]).toMatchObject({
      phase: "done",
      stage: undefined,
      stageIndex: 4,
      pullRequestUrl: fakePullRequestUrl(17),
    });
  });
});
