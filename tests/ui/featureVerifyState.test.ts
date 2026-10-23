import { describe, expect, it } from "vitest";
import { Engine } from "../../src/engine/engine.js";
import { RecordingAdapters } from "../../src/engine/fakes.js";
import { idleFeatureVerify, type FeatureVerifyStatus } from "../../src/real/featureVerify/runFeatureVerify.js";
import { UiController, type Session } from "../../src/ui/controller.js";
import { featureVerifyLabel } from "../../src/ui/state.js";
import { snapshot, testItem, testModel } from "../fixtures.js";

function boot() {
  let status: FeatureVerifyStatus = idleFeatureVerify();
  const engine = new Engine(testModel([testItem(17, "api")]), new RecordingAdapters(), { workerCap: 1 });
  const session: Session = {
    engine,
    featureVerify: () => status,
    tick: () => undefined,
    stop: () => undefined,
  };
  const controller = new UiController({
    mode: "real",
    hubRepo: "example-org/hub",
    startCap: 1,
    listParents: () => Promise.resolve([]),
    loadSnapshot: () => Promise.resolve(snapshot()),
    startSession: () => session,
    now: () => new Date("2026-08-15T09:00:00.000Z"),
  });
  return { controller, set: (next: FeatureVerifyStatus) => (status = next) };
}

describe("feature verify in the ui state", () => {
  it("is idle before any run starts", () => {
    const { controller } = boot();
    expect(controller.state().featureVerify.phase).toBe("idle");
  });

  it("carries the phase, the counts and the pull requests the session reports", async () => {
    const { controller, set } = boot();
    await controller.startRun({ parent: 16, cap: 1 });
    set({
      phase: "green",
      counts: { pass: 4, fail: 0, requiresStg: 1 },
      reason: undefined,
      pullRequests: ["https://github.com/example-org/api/pull/1"],
    });
    controller.tick();

    const state = controller.state();
    expect(state.featureVerify.phase).toBe("green");
    expect(state.featureVerify.counts.pass).toBe(4);
    expect(state.featureVerify.pullRequests).toHaveLength(1);
  });

  it("notes each phase change in the feed exactly once, and a red one as a warning", async () => {
    const { controller, set } = boot();
    await controller.startRun({ parent: 16, cap: 1 });

    set(idleFeatureVerify("running"));
    controller.tick();
    controller.tick();
    set({ phase: "red", counts: { pass: 0, fail: 1, requiresStg: 0 }, reason: "1 scenario(s) FAILED", pullRequests: [] });
    controller.tick();

    const verifyLines = controller.state().feed.filter((line) => line.message.startsWith("feature verify"));
    expect(verifyLines).toHaveLength(2);
    expect(verifyLines[0]?.message).toBe("feature verify: running");
    expect(verifyLines[1]?.kind).toBe("warn");
    expect(verifyLines[1]?.message).toContain("1 scenario(s) FAILED");
  });
});

describe("featureVerifyLabel", () => {
  it("says what a human should do about each phase", () => {
    expect(featureVerifyLabel(idleFeatureVerify())).toContain("idle");
    expect(featureVerifyLabel(idleFeatureVerify("skipped"))).toContain("skipped");
    expect(
      featureVerifyLabel({ phase: "green", counts: { pass: 2, fail: 0, requiresStg: 1 }, reason: undefined, pullRequests: [] }),
    ).toContain("2 pass, 0 fail, 1 requires-STG");
  });

  it("names the fix round while the loop runs", () => {
    const fixing: FeatureVerifyStatus = {
      phase: "fixing",
      counts: { pass: 1, fail: 1, requiresStg: 0 },
      reason: "1 scenario(s) FAILED",
      pullRequests: [],
      rework: { round: 2, limit: 3 },
    };
    expect(featureVerifyLabel(fixing)).toBe("feature verify: fixing (fix round 2/3) — 1 scenario(s) FAILED");
    expect(featureVerifyLabel({ ...idleFeatureVerify("running"), rework: { round: 2, limit: 3 } })).toBe("feature verify: running (fix round 2/3)");
  });

  it("says when another parent's verify holds the compose ports", () => {
    expect(featureVerifyLabel(idleFeatureVerify("waiting"))).toBe("feature verify: waiting for another parent's verify");
    expect(featureVerifyLabel({ ...idleFeatureVerify("waiting"), rework: { round: 1, limit: 3 } })).toBe(
      "feature verify: waiting for another parent's verify (fix round 1/3)",
    );
  });
});
