import { describe, expect, it } from "vitest";
import { STAGE_CHAIN, type StageName } from "../src/engine/adapters.js";
import { RATE_LIMIT_FALLBACK_MS, type Engine } from "../src/engine/engine.js";
import { resumePlacement } from "../src/engine/resume.js";
import { evidence, harness, resumedHarness, spawnOrder, testItem, testModel } from "./fixtures.js";

const WINDOW_OPENS = 1_757_000_000_000;

function waitOut(engine: Engine, itemNumber: number, stage: StageName, resumeAt?: number): void {
  engine.handleStageCompletion({
    itemNumber,
    stage,
    outcome: "waiting",
    waitReason: resumeAt === undefined ? "auth" : "rate-limit",
    ...(resumeAt === undefined ? {} : { resumeAt }),
    detail: "rate_limit_event",
  });
}

describe("a five-hour window closing mid-run", () => {
  it("holds the item at its stage instead of parking it — no label flip, no park comment", () => {
    const { adapters, engine } = harness(testModel([testItem(17, "api")]));
    engine.start();

    waitOut(engine, 17, "develop", WINDOW_OPENS);

    expect(engine.phases().get(17)).toBe("waiting");
    expect(adapters.comments).toEqual([]);
    expect(adapters.log).not.toContain("add-label #17 sc:needs-human");
    expect(adapters.log.filter((line) => line.startsWith("label #17"))).toEqual(["label #17 sc:queued", "label #17 sc:developing"]);
    expect(adapters.notes.some((note) => note.includes("five-hour usage limit"))).toBe(true);
  });

  it("stops spawning into a dead window, then resumes every held item when the clock passes resetsAt", () => {
    const { adapters, engine } = harness(testModel([testItem(17, "api"), testItem(18, "api")]), 2);
    engine.start();
    expect(spawnOrder(adapters.log)).toEqual(["spawn develop #17", "spawn develop #18"]);

    waitOut(engine, 17, "develop", WINDOW_OPENS);
    waitOut(engine, 18, "develop", WINDOW_OPENS);
    engine.tick(WINDOW_OPENS - 1);

    expect(spawnOrder(adapters.log)).toEqual(["spawn develop #17", "spawn develop #18"]);

    engine.tick(WINDOW_OPENS);

    expect(spawnOrder(adapters.log)).toEqual([
      "spawn develop #17",
      "spawn develop #18",
      "spawn develop #17",
      "spawn develop #18",
    ]);
    expect(adapters.comments).toEqual([]);
  });

  it("re-enters at the stage that was cut off, not at the top of the chain", () => {
    const { adapters, engine, complete } = harness(testModel([testItem(17, "api")]));
    engine.start();
    complete(17, "develop");
    complete(17, "simplify");

    waitOut(engine, 17, "review", WINDOW_OPENS);
    engine.tick(WINDOW_OPENS + 60_000);

    expect(spawnOrder(adapters.log)).toEqual(["spawn develop #17", "spawn simplify #17", "spawn review #17", "spawn review #17"]);
  });

  it("keeps a waiting item out of the stall summary — nothing needs a human", () => {
    const { engine } = harness(testModel([testItem(17, "api")]));
    engine.start();
    waitOut(engine, 17, "develop", WINDOW_OPENS);

    expect(engine.stalled()).toBeUndefined();
    expect(engine.complete()).toBe(false);
  });
});

describe("credentials rejected mid-run", () => {
  it("holds every new start until a probe says the credentials work again", () => {
    const { adapters, engine } = harness(testModel([testItem(17, "api"), testItem(18, "api")]), 2);
    engine.start();

    waitOut(engine, 17, "develop");
    engine.tick(WINDOW_OPENS);
    waitOut(engine, 18, "develop");

    expect(engine.authHeld()).toBe(true);
    expect(engine.phases().get(17)).toBe("waiting");
    expect(spawnOrder(adapters.log)).toEqual(["spawn develop #17", "spawn develop #18"]);

    engine.releaseAuthHold();

    expect(engine.authHeld()).toBe(false);
    expect(spawnOrder(adapters.log)).toEqual([
      "spawn develop #17",
      "spawn develop #18",
      "spawn develop #17",
      "spawn develop #18",
    ]);
    expect(adapters.comments).toEqual([]);
  });

  it("outranks a rate-limit hold, so the clock alone does not resume a run with dead credentials", () => {
    const { engine } = harness(testModel([testItem(17, "api"), testItem(18, "api")]), 2);
    engine.start();

    waitOut(engine, 17, "develop", WINDOW_OPENS);
    waitOut(engine, 18, "develop");
    engine.tick(WINDOW_OPENS + 60_000);

    expect(engine.authHeld()).toBe(true);
    expect(engine.phases().get(17)).toBe("waiting");
  });

  it("lets an operator who fixed the credentials by hand retry a waiting item", () => {
    const { adapters, engine } = harness(testModel([testItem(17, "api")]));
    engine.start();
    waitOut(engine, 17, "develop");

    engine.retryItem(17);

    expect(engine.phases().get(17)).toBe("running");
    expect(adapters.log).not.toContain("swap-labels #17 ready-for-human→ready-for-agent");
    expect(adapters.notes.some((note) => note.includes("released the auth hold for the whole run"))).toBe(true);
  });
});

describe("the run #99 timeline, replayed", () => {
  it("survives four usage windows and three credential expiries with zero human actions", () => {
    const items = [17, 18, 19, 20].map((number) => testItem(number, "api"));
    const { adapters, engine } = harness(testModel(items), 2);
    engine.start();

    let clock = WINDOW_OPENS;
    const outages: (number | undefined)[] = [clock, undefined, clock + 5 * 3_600_000, undefined, clock + 10 * 3_600_000, undefined, clock + 15 * 3_600_000];
    let outage = 0;

    while (!engine.complete()) {
      const pending = adapters.takeNextPending();
      const resumeAt = outages[outage];
      if (outage < outages.length && pending.stage === "review") {
        outage += 1;
        waitOut(engine, pending.itemNumber, pending.stage, resumeAt);
        if (resumeAt === undefined) engine.releaseAuthHold();
        else {
          clock = resumeAt + 60_000;
          engine.tick(clock);
        }
        continue;
      }
      engine.handleStageCompletion({ ...pending, outcome: "success" });
    }

    expect(outage).toBe(outages.length);
    expect(adapters.comments).toEqual([]);
    expect(adapters.log.filter((line) => line.includes("sc:needs-human"))).toEqual([]);
    expect([...engine.phases().values()]).toEqual(["done", "done", "done", "done"]);
  });
});

describe("a park at the verify gate", () => {
  it("labels the gate sc:verifying so a crash-resume comes back to the gate, not to develop", () => {
    const { adapters, engine, complete } = harness(testModel([testItem(17, "api")]));
    engine.start();
    complete(17, "develop");
    complete(17, "simplify");
    complete(17, "review");

    expect(adapters.log).toContain("label #17 sc:verifying");

    const placement = resumePlacement(
      evidence({ itemNumber: 17, stageLabels: ["sc:verifying", "sc:needs-human"], branchExists: true, pullRequestExists: true }),
      "held",
    );

    expect(placement).toEqual({ kind: "parked", stageIndex: STAGE_CHAIN.indexOf("verify"), parkReason: undefined });
  });

  it("resumes a flipped gate park straight back into verify", () => {
    const { adapters, engine } = resumedHarness(testModel([testItem(17, "api")]), [
      evidence({
        itemNumber: 17,
        stageLabels: ["sc:verifying", "sc:needs-human"],
        branchExists: true,
        pullRequestExists: true,
      }),
    ]);

    expect(spawnOrder(adapters.log)).toEqual([]);
    expect(adapters.log).toContain("git rebase [api] feat/17-slice-17 onto integration/toy-demo");
    expect(engine.view()[0]?.stage).toBe("verify");
  });
});

describe("a rate_limit_event with no resetsAt", () => {
  it("holds new starts for a bounded window instead of forever", () => {
    const { adapters, engine } = harness(testModel([testItem(17, "api")]));
    engine.start();
    engine.handleStageCompletion({ itemNumber: 17, stage: "develop", outcome: "waiting", waitReason: "rate-limit" });

    engine.tick(WINDOW_OPENS);
    expect(engine.phases().get(17)).toBe("waiting");

    engine.tick(WINDOW_OPENS + RATE_LIMIT_FALLBACK_MS);
    expect(spawnOrder(adapters.log)).toEqual(["spawn develop #17", "spawn develop #17"]);
  });

  it("keeps the later reset time when a second item reports a window that reopens further out", () => {
    const { engine } = harness(testModel([testItem(17, "api"), testItem(18, "api")]), 2);
    engine.start();

    waitOut(engine, 17, "develop", WINDOW_OPENS);
    waitOut(engine, 18, "develop", WINDOW_OPENS + 3_600_000);
    engine.tick(WINDOW_OPENS + 60_000);

    expect(engine.holdState()).toEqual({ reason: "rate-limit", until: WINDOW_OPENS + 3_600_000 });
    expect(engine.phases().get(17)).toBe("waiting");
  });
});
