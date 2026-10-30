import { describe, expect, it } from "vitest";
import { findItem, finishReport, launchPlan, parkedToRetry, queueReport, selectRun, statusReport, waitingItems } from "../../src/real/ops.js";
import { idleFeatureVerify, idlePolish, phaseCounts, type UiItem, type UiRun, type UiState } from "../../src/ui/state.js";

function item(overrides: Partial<UiItem> & { number: number }): UiItem {
  return {
    title: `slice ${overrides.number}`,
    repo: "api",
    phase: "running",
    stage: "develop",
    stageIndex: 0,
    branch: `feat/${overrides.number}-slice`,
    dependsOn: [],
    blockers: [],
    parkReason: undefined,
    waitReason: undefined,
    resumeAt: undefined,
    pullRequestUrl: undefined,
    reworkRound: 0,
    reworkLimit: 3,
    phaseSince: "2026-10-21T09:00:00.000Z",
    agent: undefined,
    quiet: undefined,
    issueUrl: `https://github.com/example-org/hub/issues/${overrides.number}`,
    ...overrides,
  };
}

function state(overrides: Partial<UiState> = {}): UiState {
  const items = overrides.items ?? [];
  return {
    version: 2,
    rev: 1,
    boot: "test-boot",
    stages: ["queued", "develop", "simplify", "review", "verify", "merged"],
    mode: "real",
    tracker: "github",
    hubRepo: "example-org/hub",
    startCap: 2,
    preselectedParent: 99,
    parent: { number: 99, title: "SMS numbers", feature: "sms-numbers", integrationBranch: "integration/sms-numbers", url: "" },
    cap: 2,
    paused: false,
    started: true,
    complete: false,
    running: 1,
    stalled: undefined,
    hold: undefined,
    canStart: true,
    featureVerify: idleFeatureVerify(),
    polish: idlePolish(),
    canReset: false,
    resetting: false,
    phaseCounts: phaseCounts(items),
    queue: [],
    queueCap: 1,
    queueSettings: { mode: "sequential", maxParallel: 2, globalCap: 2, parentCap: 1, paused: false },
    runs: [],
    globalRunning: 0,
    items,
    feed: [],
    ...overrides,
  };
}

function parentRun(number: number, overrides: Partial<UiRun> = {}): UiRun {
  const items = overrides.items ?? [];
  return {
    parent: { number, title: `parent ${number}`, feature: `f-${number}`, integrationBranch: `integration/f-${number}`, url: "" },
    cap: 1,
    paused: false,
    started: true,
    complete: false,
    settled: false,
    running: 0,
    stalled: undefined,
    hold: undefined,
    featureVerify: idleFeatureVerify(),
    polish: idlePolish(),
    phaseCounts: phaseCounts(items),
    items,
    ...overrides,
  };
}

const GREEN = { phase: "green" as const, counts: { pass: 1, fail: 0, requiresStg: 0 }, reason: undefined };

describe("choosing the run an ops command acts on", () => {
  const two = state({
    runs: [
      parentRun(100, { items: [item({ number: 101, phase: "parked", parkReason: "review stage failed" })] }),
      parentRun(200, { items: [item({ number: 201, phase: "waiting", waitReason: "auth" })] }),
    ],
  });

  it("takes the only live run when no parent is named", () => {
    const one = state({ runs: [parentRun(100, { settled: true }), parentRun(200)] });
    expect(selectRun(one).parent.number).toBe(200);
    expect(selectRun(state()).parent.number).toBe(99);
  });

  it("refuses to guess between several live parents", () => {
    expect(() => selectRun(two)).toThrow("several parents are live (#100, #200) — pass --parent=N");
    const settled = state({ runs: [parentRun(100, { settled: true }), parentRun(200, { settled: true })] });
    expect(() => selectRun(settled)).toThrow("several parents ran here (#100, #200) — pass --parent=N");
  });

  it("takes the named parent, and lists the runs when it is unknown", () => {
    expect(selectRun(two, 200).parent.number).toBe(200);
    expect(parkedToRetry(two, undefined, 100)).toEqual([101]);
    expect(waitingItems(two, 200)).toEqual([201]);
    expect(() => selectRun(two, 300)).toThrow("#300 is not a run on this control plane — runs: #100, #200");
  });

  it("finds an item in whichever run owns it, or in the named run", () => {
    expect(findItem(two, 201)).toMatchObject({ number: 201, phase: "waiting" });
    expect(findItem(two, 101, 100)).toMatchObject({ number: 101, phase: "parked" });
    expect(() => findItem(two, 999)).toThrow("#999 is not in any run on this control plane");
    expect(() => findItem(two, 201, 100)).toThrow("#201 is not in #100's run");
  });
});

describe("status across parents", () => {
  const two = state({
    globalRunning: 2,
    runs: [
      parentRun(100, { items: [item({ number: 101, phase: "parked", parkReason: "review stage failed" })] }),
      parentRun(200, { featureVerify: { ...GREEN, pullRequests: [] } }),
    ],
    feed: [
      { at: "t1", kind: "note", itemNumber: undefined, parentNumber: 100, message: "from 100" },
      { at: "t2", kind: "note", itemNumber: undefined, parentNumber: 200, message: "from 200" },
      { at: "t3", kind: "note", itemNumber: undefined, message: "queue resumed" },
    ],
  });

  it("summarises the control plane and one line per run when several parents are live", () => {
    const report = statusReport(two);
    expect(report["note"]).toBe("several parents are live (#100, #200) — pass --parent=N");
    expect(report["globalRunning"]).toBe(2);
    expect(report["queueSettings"]).toEqual(two.queueSettings);
    expect(report["runs"]).toMatchObject([
      { parent: 100, featureVerify: "idle", polish: "idle", settled: false, parked: [101] },
      { parent: 200, featureVerify: "green", settled: false },
    ]);
    expect((report["feed"] as unknown[]).length).toBe(3);
  });

  it("details one run with its own and the control plane's feed lines", () => {
    const report = statusReport(two, { parent: 200 });
    expect((report["parent"] as { number: number }).number).toBe(200);
    expect(report["globalRunning"]).toBe(2);
    expect((report["feed"] as { message: string }[]).map((line) => line.message)).toEqual(["from 200", "queue resumed"]);
  });

  it("surfaces Stall and Quiet items for the Orchestrator Agent", () => {
    const quiet = { silentSeconds: 700, timeoutSeconds: 1200 };
    const stalled = { parked: 1, held: 0, blocked: 0 } as unknown as UiRun["stalled"];
    const run = parentRun(100, { stalled, items: [item({ number: 5, quiet }), item({ number: 6 })] });
    const report = statusReport(state({ runs: [run] }));
    expect(report["stalled"]).toEqual(stalled);
    expect(report["quiet"]).toEqual([expect.objectContaining({ number: 5, quiet })]);
  });

  it("details the run without a parent whenever one run is unambiguous", () => {
    const oneLive = state({ runs: [parentRun(100, { settled: true }), parentRun(200)] });
    expect((statusReport(oneLive)["parent"] as { number: number }).number).toBe(200);
    const onlyRun = state({ runs: [parentRun(100, { settled: true })] });
    expect((statusReport(onlyRun)["parent"] as { number: number }).number).toBe(100);
    expect(statusReport(onlyRun)["queueSettings"]).toEqual(onlyRun.queueSettings);
  });

  it("keeps the summary reachable with one run, and refuses a parent alongside it", () => {
    const onlyRun = state({ runs: [parentRun(100)] });
    const report = statusReport(onlyRun, { summary: true });
    expect(report["parent"]).toBeUndefined();
    expect(report["note"]).toBeUndefined();
    expect(report["runs"]).toMatchObject([{ parent: 100 }]);
    expect(() => statusReport(onlyRun, { summary: true, parent: 100 })).toThrow("pass --parent=N or --summary, not both");
  });
});

describe("an idle control plane with no run", () => {
  const idle = state({ parent: undefined, runs: [] });
  const noRun = /^no run has started on this control plane/;

  it("prints the summary with the reason instead of a run", () => {
    const report = statusReport(idle);
    expect(report["runs"]).toEqual([]);
    expect(report["note"]).toMatch(noRun);
    expect(() => statusReport(idle, { parent: 100 })).toThrow(noRun);
    expect(queueReport(idle)).toMatchObject({ ok: true, runs: [] });
  });

  it("refuses run commands with a clear message", () => {
    expect(() => finishReport(idle)).toThrow(noRun);
    expect(() => parkedToRetry(idle, undefined)).toThrow(noRun);
    expect(() => waitingItems(idle)).toThrow(noRun);
    expect(() => findItem(idle, 101)).toThrow(noRun);
  });

  it("tolerates a control plane that predates the runs list", () => {
    const legacy = { ...state(), runs: undefined } as unknown as UiState;
    expect(selectRun(legacy).parent.number).toBe(99);
    expect(queueReport(legacy)).toMatchObject({ runs: [{ parent: 99 }] });
  });
});

describe("what the operator agent is told to do next", () => {
  const run = state({
    items: [
      item({ number: 100, phase: "done", stage: undefined, pullRequestUrl: "https://github.com/x/1" }),
      item({ number: 101, phase: "waiting", waitReason: "rate-limit", resumeAt: "2026-09-06T12:10:00.000Z" }),
      item({ number: 102, phase: "parked", parkReason: "verify gate red — merge conflict rebasing onto integration/x" }),
      item({ number: 103, phase: "parked", parkReason: "review stage failed" }),
    ],
  });

  it("separates the items waiting on a clock from the ones waiting on a human", () => {
    const report = statusReport(run);

    expect(report["waiting"]).toEqual([
      { number: 101, phase: "waiting", stage: "develop", repo: "api", waitReason: "rate-limit", resumeAt: "2026-09-06T12:10:00.000Z" },
    ]);
    expect((report["parked"] as { number: number }[]).map((entry) => entry.number)).toEqual([102, 103]);
    expect(report["items"]).toBeUndefined();
  });

  it("includes every item only when asked", () => {
    expect((statusReport(run, { items: true, parent: 99 })["items"] as unknown[]).length).toBe(4);
  });

  it("retries only the parks whose reason matches, and never a waiting item", () => {
    expect(parkedToRetry(run, undefined)).toEqual([102, 103]);
    expect(parkedToRetry(run, "all")).toEqual([102, 103]);
    expect(parkedToRetry(run, "merge conflict")).toEqual([102]);
    expect(waitingItems(run)).toEqual([101]);
  });
});

describe("finishing a run", () => {
  it("reports the named parent's own feature verify pull requests", () => {
    const two = state({
      runs: [
        parentRun(100, { complete: true, featureVerify: { ...GREEN, pullRequests: ["https://x/100"] } }),
        parentRun(200, { featureVerify: { ...GREEN, pullRequests: ["https://x/200"] } }),
      ],
    });
    expect(finishReport(two, 100)).toMatchObject({ ok: true, pullRequests: ["https://x/100"] });
    expect(finishReport(two, 200)).toMatchObject({ ok: false, error: "the run is not complete" });
    expect(() => finishReport(two)).toThrow(/several parents are live/);
  });

  it("refuses to call a run finished while anything is still waiting or parked", () => {
    const report = finishReport(state({ items: [item({ number: 101, phase: "waiting", waitReason: "auth" })] }));

    expect(report.ok).toBe(false);
    expect(report.error).toBe("the run is not complete");
    expect(report.waiting?.map((entry) => entry.number)).toEqual([101]);
  });

  it("prints the integration → dev pull requests when feature verify is green", () => {
    const report = finishReport(
      state({
        complete: true,
        items: [item({ number: 100, phase: "done", stage: undefined })],
        featureVerify: {
          phase: "green",
          counts: { pass: 12, fail: 0, requiresStg: 2 },
          reason: undefined,
          pullRequests: ["https://github.com/example-org/api/pull/560"],
        },
      }),
    );

    expect(report.ok).toBe(true);
    expect(report.pullRequests).toEqual(["https://github.com/example-org/api/pull/560"]);
    expect(report.merged).toEqual([100]);
  });

  it("fails when feature verify is red, and says why", () => {
    const report = finishReport(
      state({
        complete: true,
        featureVerify: {
          phase: "red",
          counts: { pass: 1, fail: 3, requiresStg: 0 },
          reason: "seed failed on a fresh mongo",
          pullRequests: [],
        },
      }),
    );

    expect(report.ok).toBe(false);
    expect(report.error).toBe("seed failed on a fresh mongo");
  });

  it("fails when feature verify never ran, so nobody mistakes it for a green run", () => {
    expect(finishReport(state({ complete: true })).error).toBe("feature verify never ran");
  });

  it("refuses to finish while Feature Verify is in a fix round", () => {
    const report = finishReport(state({ complete: true, featureVerify: idleFeatureVerify("fixing") }));
    expect(report.ok).toBe(false);
    expect(report.error).toBe("feature verify is in a fix round");
  });

  it("refuses to finish while Feature Verify waits for another parent's verify", () => {
    const report = finishReport(state({ complete: true, featureVerify: idleFeatureVerify("waiting") }));
    expect(report.ok).toBe(false);
    expect(report.error).toBe("feature verify is waiting for another parent's verify");
  });

  it("holds the finish while polish is still pushing onto the integration pull requests", () => {
    const green = { phase: "green" as const, counts: { pass: 1, fail: 0, requiresStg: 0 }, reason: undefined, pullRequests: ["https://x/1"] };
    const running = finishReport(state({ complete: true, featureVerify: green, polish: idlePolish("running") }));
    expect(running.ok).toBe(false);
    expect(running.error).toBe("polish is still running");

    const reverted = finishReport(
      state({ complete: true, featureVerify: green, polish: { phase: "reverted", pullRequests: ["https://x/1"], reason: "checks red" } }),
    );
    expect(reverted.ok).toBe(true);
    expect(reverted.polish.phase).toBe("reverted");
  });
});

describe("launchPlan", () => {
  it("starts the first fresh parent and queues the rest", () => {
    const plan = launchPlan(state({ runs: [], canStart: true }), [120, 121, 122]);
    expect(plan).toEqual({ start: 120, queue: [121, 122], alreadyRunning: [], alreadyQueued: [] });
  });

  it("queues everything when the control plane cannot start another run", () => {
    const plan = launchPlan(state({ runs: [parentRun(99)], canStart: false }), [120, 121]);
    expect(plan).toEqual({ start: undefined, queue: [120, 121], alreadyRunning: [], alreadyQueued: [] });
  });

  it("skips parents that are live or already queued", () => {
    const plan = launchPlan(state({ runs: [parentRun(120), parentRun(130, { settled: true })], queue: [121] }), [120, 121, 130]);
    expect(plan).toEqual({ start: 130, queue: [], alreadyRunning: [120], alreadyQueued: [121] });
  });

  it("takes a parent named twice once", () => {
    const plan = launchPlan(state({ runs: [], canStart: true }), [120, 120, 121, 121]);
    expect(plan).toEqual({ start: 120, queue: [121], alreadyRunning: [], alreadyQueued: [] });
  });
});
