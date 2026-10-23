import { describe, expect, it } from "vitest";
import type { ReworkRequest, StageName } from "../src/engine/adapters.js";
import { Engine } from "../src/engine/engine.js";
import { RecordingAdapters } from "../src/engine/fakes.js";
import { evidence, harness, resumedHarness, testItem, testModel } from "./fixtures.js";

const RED_CHECKS: ReworkRequest = { source: "verify", story: "npm test failed: toggle.test.ts expected on, got off" };
const REVIEW_FINDING: ReworkRequest = { source: "review", story: "the toggle never persists — reload loses it" };

function sendBack(engine: Engine, adapters: RecordingAdapters, stage: StageName, rework: ReworkRequest): void {
  adapters.dropPending(17);
  engine.handleStageCompletion({ itemNumber: 17, stage, outcome: "failure", detail: rework.story, rework });
}

function runToGate(complete: (itemNumber: number, stage: StageName) => void): void {
  complete(17, "develop");
  complete(17, "simplify");
  complete(17, "review");
}

describe("the rework loop", () => {
  it("sends a red verify gate back to develop with the story, and re-runs the whole chain", () => {
    const { adapters, engine, complete } = harness(testModel([testItem(17, "api")]));
    engine.start();
    runToGate(complete);

    sendBack(engine, adapters, "verify", RED_CHECKS);

    expect(engine.view()[0]).toMatchObject({ phase: "running", stage: "develop", reworkRound: 1, reworkLimit: 3 });
    expect(adapters.spawned.at(-1)).toMatchObject({
      stage: "develop",
      rework: { round: 1, limit: 3, briefs: [{ round: 1, ...RED_CHECKS }] },
    });
    expect(adapters.comments.at(-1)?.body).toContain("rework round 1 of 3, raised by the verify stage");
    expect(adapters.comments.at(-1)?.body).toContain(RED_CHECKS.story);
    expect(adapters.log).not.toContain("add-label #17 sc:needs-human");

    runToGate(complete);
    complete(17, "verify");
    expect(engine.view()[0]).toMatchObject({ phase: "done" });
  });

  it("hands every later stage of the round the full brief history", () => {
    const { adapters, engine, complete } = harness(testModel([testItem(17, "api")]));
    engine.start();
    complete(17, "develop");
    complete(17, "simplify");
    sendBack(engine, adapters, "review", REVIEW_FINDING);
    runToGate(complete);
    sendBack(engine, adapters, "verify", RED_CHECKS);

    complete(17, "develop");
    expect(adapters.spawned.at(-1)).toMatchObject({
      stage: "simplify",
      rework: {
        round: 2,
        briefs: [
          { round: 1, ...REVIEW_FINDING },
          { round: 2, ...RED_CHECKS },
        ],
      },
    });
  });

  it("parks with every round's story once the limit is spent", () => {
    const { adapters, engine, complete } = harness(testModel([testItem(17, "api")]));
    engine.start();
    for (let round = 0; round < 3; round += 1) {
      runToGate(complete);
      sendBack(engine, adapters, "verify", { ...RED_CHECKS, story: `red round ${round}` });
    }
    runToGate(complete);
    sendBack(engine, adapters, "verify", { ...RED_CHECKS, story: "red at the limit" });

    expect(engine.view()[0]).toMatchObject({ phase: "parked", reworkRound: 3 });
    expect(engine.view()[0]?.parkReason).toBe("rework limit reached — verify still fails after 3 rework round(s)");
    const park = adapters.comments.at(-1)?.body ?? "";
    for (const story of ["red round 0", "red round 1", "red round 2", "red at the limit"]) expect(park).toContain(story);
    expect(adapters.log).toContain("add-label #17 sc:needs-human");
  });

  it("gives a human retry of a limit park one more round", () => {
    const adapters = new RecordingAdapters();
    const engine = new Engine(testModel([testItem(17, "api")]), adapters, { workerCap: 1, reworkLimit: 1 });
    engine.start();
    const complete = (stage: StageName) => {
      adapters.dropPending(17);
      engine.handleStageCompletion({ itemNumber: 17, stage, outcome: "success" });
    };
    complete("develop");
    complete("simplify");
    complete("review");
    sendBack(engine, adapters, "verify", RED_CHECKS);
    complete("develop");
    complete("simplify");
    complete("review");
    sendBack(engine, adapters, "verify", RED_CHECKS);
    expect(engine.view()[0]).toMatchObject({ phase: "parked", reworkRound: 1, reworkLimit: 1 });

    engine.retryItem(17);
    sendBack(engine, adapters, "verify", RED_CHECKS);

    expect(engine.view()[0]).toMatchObject({ phase: "running", stage: "develop", reworkRound: 2, reworkLimit: 2 });
  });

  it("still parks a plain failure that asks for no rework", () => {
    const { engine, complete } = harness(testModel([testItem(17, "api")]));
    engine.start();
    runToGate(complete);
    complete(17, "verify", "failure", "docker refused");

    expect(engine.view()[0]).toMatchObject({ phase: "parked", reworkRound: 0, parkReason: "verify gate red" });
  });

  it("resumes the round and its briefs from the pull-request audit trail", () => {
    const briefs = [
      { round: 1, ...REVIEW_FINDING },
      { round: 2, ...RED_CHECKS },
    ];
    const { adapters, engine } = resumedHarness(testModel([testItem(17, "api")]), [
      evidence({ itemNumber: 17, stageLabels: ["sc:developing"], branchExists: true, pullRequestExists: true, reworkBriefs: briefs }),
    ]);

    expect(engine.view()[0]).toMatchObject({ phase: "running", stage: "develop", reworkRound: 2, reworkLimit: 3 });
    expect(adapters.spawned.at(-1)?.rework).toEqual({ round: 2, limit: 3, briefs });
  });
});
