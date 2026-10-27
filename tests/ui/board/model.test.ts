import { describe, expect, it } from "vitest";
import { feedTime, formatClock, formatCountdown, formatDuration, formatQuiet } from "../../../src/ui/board/format.js";
import { bucketCounts, chooseRun, columnOf, groupByColumn, lifecycleSteps, parentGroup, shouldAdopt } from "../../../src/ui/board/model.js";
import { idlePolish } from "../../../src/ui/state.js";
import { minutesAgo, NOW, uiItem, uiRun, uiState } from "./fixtures.js";

const STAGES = ["queued", "develop", "review", "verify", "merged"];

describe("phase grouping", () => {
  it("puts waiting phases in the first column, done in the last and working phases at their stage", () => {
    expect(columnOf(uiItem(1, "blocked"), STAGES)).toBe("queued");
    expect(columnOf(uiItem(2, "held"), STAGES)).toBe("queued");
    expect(columnOf(uiItem(3, "queued"), STAGES)).toBe("queued");
    expect(columnOf(uiItem(4, "done", { stage: "verify" }), STAGES)).toBe("merged");
    expect(columnOf(uiItem(5, "running", { stage: "review" }), STAGES)).toBe("review");
    expect(columnOf(uiItem(6, "parked", { stage: "verify" }), STAGES)).toBe("verify");
    expect(columnOf(uiItem(7, "waiting", { stage: "unknown-stage" }), STAGES)).toBe("queued");
  });

  it("follows the project's configured stages and sorts items by number", () => {
    const custom = ["queued", "develop", "security", "merged"];
    const grouped = groupByColumn([uiItem(9, "running", { stage: "security" }), uiItem(4, "running", { stage: "security" }), uiItem(1, "done")], custom);
    expect([...grouped.keys()]).toEqual(custom);
    expect(grouped.get("security")?.map((item) => item.number)).toEqual([4, 9]);
    expect(grouped.get("merged")?.map((item) => item.number)).toEqual([1]);
  });

  it("buckets phases for the progress bar", () => {
    const counts = bucketCounts([uiItem(1, "done"), uiItem(2, "running"), uiItem(3, "awaiting"), uiItem(4, "waiting"), uiItem(5, "blocked"), uiItem(6, "parked"), uiItem(7, "held"), uiItem(8, "queued")]);
    expect(counts).toEqual({ done: 1, run: 2, wait: 2, park: 1, idle: 2 });
  });

  it("groups parents for the picker", () => {
    expect(parentGroup({ number: 1, title: "t", subIssues: 3, completedSubIssues: 3 })).toBe("ready-to-merge");
    expect(parentGroup({ number: 1, title: "t", subIssues: 3, completedSubIssues: 1 })).toBe("working");
    expect(parentGroup({ number: 1, title: "t", subIssues: 3, completedSubIssues: 0 })).toBe("todo");
  });

  it("keeps the remembered run when it is still live, else the primary", () => {
    const state = uiState([uiRun(10, []), uiRun(20, [])]);
    expect(chooseRun(state, 20)?.parent.number).toBe(20);
    expect(chooseRun(state, 99)?.parent.number).toBe(10);
    expect(chooseRun(undefined, 10)).toBeUndefined();
  });
});

describe("Run Lifecycle", () => {
  it("walks Items, Integration, Feature Verify, Polish, PRs", () => {
    const working = lifecycleSteps(uiRun(1, [uiItem(1, "done"), uiItem(2, "running")]));
    expect(working.map((step) => `${step.id}:${step.state}`)).toEqual(["items:active", "integration:pending", "verify:pending", "polish:pending", "prs:pending"]);

    const integrating = lifecycleSteps(uiRun(1, [uiItem(1, "done")]));
    expect(integrating.map((step) => step.state)).toEqual(["done", "active", "pending", "pending", "pending"]);

    const red = lifecycleSteps(
      uiRun(1, [uiItem(1, "done")], { featureVerify: { phase: "red", counts: { pass: 0, fail: 1, requiresStg: 0 }, reason: undefined, pullRequests: [] } }),
    );
    expect(red.map((step) => step.state)).toEqual(["done", "done", "failed", "pending", "pending"]);

    const finished = lifecycleSteps(
      uiRun(1, [uiItem(1, "done")], {
        featureVerify: { phase: "green", counts: { pass: 2, fail: 0, requiresStg: 0 }, reason: undefined, pullRequests: ["u1"] },
        polish: { ...idlePolish(), phase: "green", pullRequests: ["u1", "u2"] },
      }),
    );
    expect(finished.map((step) => step.state)).toEqual(["done", "done", "done", "done", "active"]);
    expect(finished[4]?.detail).toBe("2 for your merge");
  });

  it("finishes the strip on a settled run whose gates never ran", () => {
    const steps = lifecycleSteps(uiRun(1, [uiItem(1, "done")], { complete: true, settled: true }), "dry");
    expect(steps.map((step) => `${step.id}:${step.state}`)).toEqual(["items:done", "integration:done", "verify:skipped", "polish:skipped", "prs:skipped"]);
    expect(steps[2]?.detail).toBe("skipped — dry run — nothing to verify");
    expect(steps[3]?.detail).toBe("skipped — dry run — nothing to polish");

    const redVerify = lifecycleSteps(
      uiRun(1, [uiItem(1, "done")], {
        complete: true,
        settled: true,
        featureVerify: { phase: "red", counts: { pass: 0, fail: 1, requiresStg: 0 }, reason: undefined, pullRequests: [] },
      }),
    );
    expect(redVerify.map((step) => step.state)).toEqual(["done", "done", "failed", "skipped", "skipped"]);
    expect(redVerify[3]?.detail).toBe("skipped — feature verify is red");
  });

  it("marks every step done on a settled run with green gates", () => {
    const steps = lifecycleSteps(
      uiRun(1, [uiItem(1, "done")], {
        complete: true,
        settled: true,
        featureVerify: { phase: "green", counts: { pass: 2, fail: 0, requiresStg: 0 }, reason: undefined, pullRequests: ["u1"] },
        polish: { ...idlePolish(), phase: "green", pullRequests: ["u1"] },
      }),
    );
    expect(steps.map((step) => step.state)).toEqual(["done", "done", "done", "done", "done"]);
  });
});

describe("clock formatting", () => {
  it("formats the Phase Clock as seconds, mm:ss, hours and days", () => {
    expect(formatClock(minutesAgo(0), NOW)).toBe("0s");
    expect(formatClock(new Date(NOW - 42_000).toISOString(), NOW)).toBe("42s");
    expect(formatClock(new Date(NOW - 12 * 60_000 - 41_000).toISOString(), NOW)).toBe("12:41");
    expect(formatClock(new Date(NOW - 125 * 60_000).toISOString(), NOW)).toBe("2h 05m");
    expect(formatClock(new Date(NOW - 28 * 3_600_000).toISOString(), NOW)).toBe("1d 4h");
    expect(formatClock("not a date", NOW)).toBe("");
    expect(formatClock(new Date(NOW + 5000).toISOString(), NOW)).toBe("0s");
  });

  it("shows Quiet as silence over the idle timeout", () => {
    expect(formatQuiet({ silentSeconds: 600, timeoutSeconds: 1200 })).toBe("quiet 10m / 20m");
    expect(formatQuiet({ silentSeconds: 45, timeoutSeconds: 90 })).toBe("quiet 45s / 1m");
    expect(formatDuration(3900)).toBe("1h 05m");
  });

  it("counts down to a resume time", () => {
    expect(formatCountdown(new Date(NOW + 3 * 60_000).toISOString(), NOW)).toBe("in 3m");
    expect(formatCountdown(new Date(NOW + 10_000).toISOString(), NOW)).toBe("now");
    expect(formatCountdown(new Date(NOW - 10_000).toISOString(), NOW)).toBe("now");
    expect(formatCountdown(new Date(NOW + 65 * 60_000).toISOString(), NOW)).toBe("in 1h 05m");
  });

  it("trims feed timestamps to the clock time", () => {
    expect(feedTime("2026-08-15T09:12:34.000Z")).toBe("09:12:34");
  });
});

describe("shouldAdopt", () => {
  const at = (rev: number, boot = "a") => uiState([], { rev, boot });

  it("adopts the first state and newer revs", () => {
    expect(shouldAdopt(undefined, at(1))).toBe(true);
    expect(shouldAdopt(at(3), at(4))).toBe(true);
  });

  it("ignores older and equal revs of the same boot", () => {
    expect(shouldAdopt(at(5), at(4))).toBe(false);
    expect(shouldAdopt(at(5), at(5))).toBe(false);
  });

  it("adopts a different boot even with a lower rev", () => {
    expect(shouldAdopt(at(50, "a"), at(1, "b"))).toBe(true);
  });
});
