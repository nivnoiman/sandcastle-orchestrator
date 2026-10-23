import { describe, expect, it } from "vitest";
import {
  DRY_STAGE_DELAY_MAX_MS,
  DRY_STAGE_DELAY_MIN_MS,
  PacedDryRun,
  randomStageDelay,
} from "../../src/engine/pacedDryRunner.js";
import type { PendingStage } from "../../src/engine/fakes.js";
import { testItem, testModel } from "../fixtures.js";

function paced(delayMs = 1000, workerCap = 1, failStage?: (pending: PendingStage) => string | undefined) {
  let clock = 0;
  const run = new PacedDryRun(testModel([testItem(17, "api"), testItem(18, "web", [17])]), {
    workerCap,
    now: () => clock,
    delayMs: () => delayMs,
    failStage,
  });
  return {
    run,
    advance: (ms: number) => {
      clock += ms;
      run.tick();
    },
  };
}

describe("paced dry run", () => {
  it("leaves the first stage running until its delay has elapsed", () => {
    const { run, advance } = paced();
    run.start();

    expect(run.engine.phases().get(17)).toBe("running");
    advance(999);
    expect(run.engine.view()[0]?.stage).toBe("develop");
  });

  it("completes one stage per elapsed delay and walks the chain", () => {
    const { run, advance } = paced();
    run.start();

    advance(1000);
    expect(run.engine.view()[0]).toMatchObject({ phase: "running", stage: "simplify" });

    advance(1000);
    expect(run.engine.view()[0]).toMatchObject({ phase: "running", stage: "review" });
  });

  it("reaches a complete run without any stage finishing early", () => {
    const { run, advance } = paced();
    run.start();

    for (let step = 0; step < 20 && !run.engine.complete(); step += 1) advance(1000);

    expect(run.engine.complete()).toBe(true);
    expect(run.adapters.log.filter((line) => line.startsWith("merge-pr"))).toEqual(["merge-pr #17", "merge-pr #18"]);
  });

  it("forgets a stage that was killed instead of completing it", () => {
    const { run, advance } = paced();
    run.start();

    run.engine.cancelItem(17);
    advance(5000);

    expect(run.engine.phases().get(17)).toBe("parked");
    expect(run.adapters.killed).toEqual([17]);
  });

  it("gives a retried stage its own delay instead of the cancelled attempt's due time", () => {
    const { run, advance } = paced();
    run.start();
    advance(999);

    run.engine.cancelItem(17);
    run.engine.retryItem(17);

    advance(1);
    expect(run.engine.view()[0]).toMatchObject({ phase: "running", stage: "develop" });

    advance(1000);
    expect(run.engine.view()[0]).toMatchObject({ phase: "running", stage: "simplify" });
  });

  it("parks the item on an injected stage failure so park and retry are demoable", () => {
    const { run, advance } = paced(1000, 1, (pending) =>
      pending.itemNumber === 17 && pending.stage === "simplify" ? "injected failure" : undefined,
    );
    run.start();

    advance(1000);
    advance(1000);

    expect(run.engine.phases().get(17)).toBe("parked");
    expect(run.engine.view()[0]?.parkReason).toBe("simplify stage failed");
    expect(run.adapters.comments.at(-1)?.body).toContain("injected failure");
  });

  it("keeps the random stage delay inside the demo window", () => {
    expect(randomStageDelay(() => 0)).toBe(DRY_STAGE_DELAY_MIN_MS);
    expect(randomStageDelay(() => 0.9999)).toBeLessThan(DRY_STAGE_DELAY_MAX_MS);
  });
});
