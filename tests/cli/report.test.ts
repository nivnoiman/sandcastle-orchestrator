import { describe, expect, it } from "vitest";
import { epilogueLines, featureVerifyLines, polishLines, stallLine } from "../../src/cli/report.js";
import { idleFeatureVerify } from "../../src/real/featureVerify/runFeatureVerify.js";
import { idlePolish } from "../../src/real/polish/runPolish.js";
import type { ItemPhase } from "../../src/engine/engine.js";

function phases(entries: [number, ItemPhase][]): ReadonlyMap<number, ItemPhase> {
  return new Map(entries);
}

describe("stallLine", () => {
  it("names every kind of waiting item and how to get out", () => {
    expect(stallLine({ parked: 2, held: 1, blocked: 3 })).toBe(
      "2 parked, 1 held, 3 blocked — waiting for label flips (Ctrl+C to exit)",
    );
  });

  it("drops the kinds that are empty", () => {
    expect(stallLine({ parked: 1, held: 0, blocked: 0 })).toBe(
      "1 parked — waiting for label flips (Ctrl+C to exit)",
    );
  });

  it("refuses a summary with nothing waiting", () => {
    expect(() => stallLine({ parked: 0, held: 0, blocked: 0 })).toThrow("nothing waiting");
  });
});

describe("epilogueLines", () => {
  it("prints every item in issue order and confirms a clean sweep", () => {
    expect(epilogueLines(phases([[18, "done"], [17, "done"]]))).toEqual([
      "#17 DONE",
      "#18 DONE",
      "all 2 item(s) merged into the integration branch",
    ]);
  });

  it("names the items that never reached done", () => {
    expect(epilogueLines(phases([[17, "done"], [18, "parked"], [19, "blocked"]]))).toEqual([
      "#17 DONE",
      "#18 PARKED",
      "#19 BLOCKED",
      "2 item(s) never reached done: #18, #19",
    ]);
  });

  it("says so when the run model emptied out", () => {
    expect(epilogueLines(phases([]))).toEqual(["the run ended with no items left in the run model"]);
  });
});

describe("featureVerifyLines", () => {
  const counts = { pass: 3, fail: 0, requiresStg: 2 };

  it("names the pull requests a human still has to merge on a green verify", () => {
    expect(
      featureVerifyLines({
        phase: "green",
        counts,
        reason: undefined,
        pullRequests: ["https://github.com/example-org/api/pull/1"],
      }),
    ).toEqual([
      "feature verify GREEN — 3 PASS · 0 FAIL · 2 requires-STG",
      "  integration → dev, waiting for a human to merge: https://github.com/example-org/api/pull/1",
    ]);
  });

  it("says why a red verify opened nothing", () => {
    const lines = featureVerifyLines({
      phase: "red",
      counts: { pass: 1, fail: 2, requiresStg: 0 },
      reason: "2 scenario(s) FAILED",
      pullRequests: [],
    });
    expect(lines[0]).toContain("RED — 2 scenario(s) FAILED");
    expect(lines[1]).toContain("ready-for-human");
  });

  it("says how many fix rounds a red verify used", () => {
    const lines = featureVerifyLines({ phase: "red", counts: { pass: 1, fail: 1, requiresStg: 0 }, reason: "1 scenario(s) FAILED", pullRequests: [], rework: { round: 4, limit: 3 } });
    expect(lines[0]).toContain("after 3 fix round(s)");
  });

  it("says a run that ended mid fix round never finished it", () => {
    const lines = featureVerifyLines({ ...idleFeatureVerify("fixing"), rework: { round: 1, limit: 3 } });
    expect(lines[0]).toContain("fix round 1/3");
  });

  it("says a run that ended waiting for another parent's verify never verified", () => {
    expect(featureVerifyLines(idleFeatureVerify("waiting"))[0]).toContain("waiting for another parent's verify");
  });

  it("is loud about the skip escape hatch", () => {
    expect(featureVerifyLines(idleFeatureVerify("skipped"))[0]).toContain("SKIPPED (--skip-verify)");
  });

  it("says nothing was verified when the run ended with items open", () => {
    expect(featureVerifyLines(idleFeatureVerify())[0]).toContain("did not run");
  });
});

describe("polishLines", () => {
  const url = "https://github.com/example-org/api/pull/1";

  it("stays quiet when polish never got its turn", () => {
    expect(polishLines(idlePolish())).toEqual([]);
  });

  it("names the polished pull requests", () => {
    expect(polishLines({ phase: "green", pullRequests: [url], reason: undefined })).toEqual([`polish GREEN — ${url}`]);
  });

  it("says a reverted polish left the pull requests as Feature Verify tested them", () => {
    const lines = polishLines({ phase: "reverted", pullRequests: [url], reason: "api: checks red" });
    expect(lines[0]).toContain("REVERTED — api: checks red");
    expect(lines[1]).toContain("Feature Verify tested");
  });

  it("says why polish was skipped", () => {
    expect(polishLines(idlePolish("skipped", "already polished"))[0]).toBe("polish skipped — already polished");
  });
});
