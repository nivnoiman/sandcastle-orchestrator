import { describe, expect, it } from "vitest";
import type { ParentSummary } from "../../src/gh/parents.js";
import { openPage, pageItem, pageRun, pageState, type FakeElement } from "./pageHarness.js";

const PARENTS: ParentSummary[] = [
  { number: 41, title: "outreach polish", subIssues: 2, completedSubIssues: 0 },
  { number: 42, title: "db egress", subIssues: 2, completedSubIssues: 1 },
  { number: 43, title: "voice tags", subIssues: 2, completedSubIssues: 2 },
];

function cards(column: FakeElement): FakeElement[] {
  return column.elementChildren().filter((child) => child.className.startsWith("card"));
}

function emptyLine(column: FakeElement): FakeElement | undefined {
  return column.elementChildren().find((child) => child.className === "empty");
}

function heading(column: FakeElement): string {
  return column.elementChildren()[0]?.textContent ?? "";
}

function phaseLabels(column: FakeElement): string[] {
  return cards(column).map((card) => card.descendants().find((node) => node.className === "phase")?.textContent ?? "");
}

function offered(page: { el: (id: string) => FakeElement }): string[] {
  return page
    .el("parent")
    .options.filter((option) => !option.disabled)
    .map((option) => option.value);
}

const RESET_PLAN = {
  lock: { path: "/w/.orchestrator.lock", reclaim: true, pid: 4242 },
  labels: [{ itemNumber: 17, remove: ["sc:needs-human"], swapToAgent: true }],
  branches: [
    { repo: "api", branch: "feat/17-toy", localExists: true, remoteExists: false, commitsAhead: 0, removable: true, verdict: "empty beyond origin/integration/toy" },
    { repo: "api", branch: "feat/18-toy", localExists: true, remoteExists: true, commitsAhead: 3, removable: false, verdict: "3 commit(s) beyond origin/integration/toy — somebody's work, keeping it" },
  ],
  orphans: { containers: ["sc-demo-develop-17-a"], networks: [], volumes: [], worktrees: [], failures: [] },
};

const RESET_REPORT = {
  gc: { containers: ["sc-demo-develop-17-a"], networks: [], volumes: [], worktrees: [], failures: [] },
  lockReclaimed: true,
  labelled: [17],
  deletedBranches: ["[api] feat/17-toy"],
  failures: [],
};

describe("the reset button", () => {
  it("is disabled with a reason until a real run is stopped", async () => {
    const page = await openPage({ state: pageState({ mode: "dry" }) });
    expect(page.el("reset").disabled).toBe(true);
    expect(page.el("reset").title).toContain("only applies to a real run");

    await page.emitState(pageState({ mode: "real", started: true, canReset: false }));
    expect(page.el("reset").disabled).toBe(true);
    expect(page.el("reset").title).toContain("stop the run first");

    await page.emitState(pageState({ mode: "real", canReset: true }));
    expect(page.el("reset").disabled).toBe(false);
  });

  it("shows the plan without applying it, and only applies when the operator confirms", async () => {
    const page = await openPage({
      state: pageState({ mode: "real", canReset: true, parent: { number: 21, title: "t", feature: "f", integrationBranch: "integration/f", url: "u" } }),
      resetPlan: RESET_PLAN,
      resetReport: RESET_REPORT,
    });
    await page.emitState(pageState({ mode: "real", canReset: true, parent: { number: 21, title: "t", feature: "f", integrationBranch: "integration/f", url: "u" } }));

    await page.clickReset();
    expect(page.resetCalls()).toEqual([{ parent: 21, apply: false }]);
    expect(page.el("reset-panel").hidden).toBe(false);
    expect(page.el("reset-title").textContent).toContain("nothing changed yet");
    const shown = page.el("reset-plan").textContent;
    expect(shown).toContain("DELETE [api] feat/17-toy");
    expect(shown).toContain("keep   [api] feat/18-toy");
    expect(shown).toContain("#17 -sc:needs-human -ready-for-human +ready-for-agent");

    await page.clickResetApply();
    expect(page.resetCalls()).toEqual([
      { parent: 21, apply: false },
      { parent: 21, apply: true },
    ]);
    expect(page.el("reset-title").textContent).toContain("applied");
    expect(page.el("reset-plan").textContent).toContain("1 branch(es) deleted: [api] feat/17-toy");
    expect(page.el("reset-apply").hidden).toBe(true);
  });

  it("applies to the parent the plan on screen was read for, not whatever the picker holds now", async () => {
    const page = await openPage({
      parents: PARENTS,
      state: pageState({ mode: "real", canReset: true }),
      resetPlan: RESET_PLAN,
      resetReport: RESET_REPORT,
    });
    await page.pick("42");
    await page.clickReset();
    expect(page.resetCalls()).toEqual([{ parent: 42, apply: false }]);

    await page.pick("43");
    await page.clickResetApply();
    expect(page.resetCalls()).toEqual([
      { parent: 42, apply: false },
      { parent: 42, apply: true },
    ]);
  });

  it("refuses to apply once the panel has been closed, since there is no plan on screen", async () => {
    const page = await openPage({
      parents: PARENTS,
      state: pageState({ mode: "real", canReset: true }),
      resetPlan: RESET_PLAN,
      resetReport: RESET_REPORT,
    });
    await page.pick("42");
    await page.clickReset();
    await page.clickResetClose();
    await page.clickResetApply();
    expect(page.resetCalls()).toEqual([{ parent: 42, apply: false }]);
    expect(page.el("alert-text").textContent).toContain("read the plan first");
  });

  it("names the plan-time failures that make an inventory incomplete", async () => {
    const blind = {
      ...RESET_PLAN,
      orphans: { ...RESET_PLAN.orphans, failures: ["docker ps by name failed: cannot connect to the daemon"] },
    };
    const page = await openPage({
      parents: PARENTS,
      state: pageState({ mode: "real", canReset: true }),
      resetPlan: blind,
    });
    await page.pick("42");
    await page.clickReset();
    expect(page.el("reset-plan").textContent).toContain("cannot connect to the daemon");
    expect(page.el("reset-plan").textContent).toContain("this inventory is incomplete");
  });

  it("asks for a parent instead of posting a reset for nobody", async () => {
    const page = await openPage({ state: pageState({ mode: "real", canReset: true }), resetPlan: RESET_PLAN });
    await page.emitState(pageState({ mode: "real", canReset: true }));
    await page.clickReset();
    expect(page.resetCalls()).toEqual([]);
    expect(page.el("alert").hidden).toBe(false);
    expect(page.el("alert-text").textContent).toContain("pick a parent first");
  });
});

describe("the parent picker holds the operator's pick", () => {
  it("keeps the pick through a query that matches nothing and back", async () => {
    const page = await openPage({ parents: PARENTS });
    await page.pick("42");

    await page.filter("nothing matches this");
    expect(page.read("selectedParent")).toBe("42");

    await page.filter("");
    expect(page.read("selectedParent")).toBe("42");
    expect(page.el("parent").value).toBe("42");
  });

  it("keeps the pick — and starts it — when the query only matches another parent", async () => {
    const page = await openPage({ parents: PARENTS });
    await page.pick("42");
    await page.filter("voice");

    expect(page.read("selectedParent")).toBe("42");
    expect(page.el("parent").value).toBe("42");
    expect(offered(page)).toEqual(["43", "42"]);

    await page.clickStart();
    expect(page.runCalls()).toEqual([{ parent: 42, cap: 1 }]);
  });

  it("adopts a default pick only while the operator has none", async () => {
    const page = await openPage({ parents: PARENTS });

    expect(page.read("selectedParent")).toBe("43");
    expect(page.el("start").disabled).toBe(false);
  });

  it("takes the parent the cli preselected over the default", async () => {
    const page = await openPage({ parents: PARENTS, state: pageState({ preselectedParent: 41 }) });

    expect(page.read("selectedParent")).toBe("41");
  });

  it("still offers the pick, and counts what the query hid, when nothing matches", async () => {
    const page = await openPage({ parents: PARENTS });
    await page.pick("42");
    await page.filter("nothing matches this");

    expect(offered(page)).toEqual(["42"]);
    expect(page.el("start").disabled).toBe(false);
    expect(page.el("parent").textContent).toContain("2 hidden");
  });

  it("disables start when there is no parent to pick at all", async () => {
    const page = await openPage({ parents: [] });

    expect(page.el("start").disabled).toBe(true);
    expect(page.el("parent").textContent).toContain("no open sandcastle parents");
  });
});

describe("the parent picker refreshes itself", () => {
  it("re-fetches the parents when a run completes, keeping the pick and the query", async () => {
    const page = await openPage({ parents: PARENTS });
    await page.pick("42");
    await page.filter("a");
    expect(page.parentsCalls()).toBe(1);

    await page.emitState(pageState({ started: true, complete: false }));
    expect(page.parentsCalls()).toBe(1);

    await page.emitState(pageState({ started: true, complete: true }));
    expect(page.parentsCalls()).toBe(2);
    expect(page.read("selectedParent")).toBe("42");
    expect(page.read("parentQuery")).toBe("a");
  });

  it("polls for parents while the startbar is up and stays quiet while a run is in flight", async () => {
    const page = await openPage({ parents: PARENTS });

    await page.poll();
    expect(page.parentsCalls()).toBe(2);

    await page.emitState(pageState({ started: true, complete: false }));
    await page.poll();
    expect(page.parentsCalls()).toBe(2);
  });

  it("repaints the merge badge from the refreshed counts", async () => {
    const page = await openPage({ parents: PARENTS });
    expect(page.el("merge-badge").textContent).toBe("1 waiting for your merge");

    page.setParents(PARENTS.filter((parent) => parent.number !== 43));
    await page.poll();

    expect(page.el("merge-badge").hidden).toBe(true);
  });
});

describe("the board draws every item it is given", () => {
  it("draws a phase it does not recognise as an active card rather than dropping it", async () => {
    const page = await openPage({ parents: PARENTS });
    await page.emitState(pageState({ items: [pageItem(17, "api", "website")] }));

    const column = page.columns()[0]!;
    expect(heading(column)).toBe("api — 0/1 done");
    expect(cards(column)).toHaveLength(1);
    expect(phaseLabels(column)).toEqual(["website (unknown)"]);
    expect(emptyLine(column)).toBeUndefined();
  });

  it("draws the active phases and hides the done ones behind the chip", async () => {
    const page = await openPage({ parents: PARENTS });
    await page.emitState(
      pageState({
        items: [
          pageItem(17, "api", "running"),
          pageItem(18, "api", "parked"),
          pageItem(19, "api", "done"),
        ],
      }),
    );

    const column = page.columns()[0]!;
    expect(heading(column)).toBe("api — 1/3 done");
    expect(phaseLabels(column)).toEqual(["running", "parked"]);

    await page.clickDoneChip(column);
    expect(phaseLabels(page.columns()[0]!)).toEqual(["running", "parked", "done"]);
  });

  it("badges a card with its rework round only once it has been sent back", async () => {
    const page = await openPage({ parents: PARENTS });
    await page.emitState(
      pageState({ items: [{ ...pageItem(17, "api", "running"), reworkRound: 2 }, pageItem(18, "api", "running")] }),
    );

    const badges = cards(page.columns()[0]!).map(
      (card) => card.descendants().find((node) => node.className === "chip rework")?.textContent,
    );
    expect(badges).toEqual(["rework 2/3", undefined]);
  });

  it("drops the empty line once an all-done column is expanded", async () => {
    const page = await openPage({ parents: PARENTS });
    await page.emitState(
      pageState({ items: [17, 18, 19, 20].map((number) => pageItem(number, "web", "done")) }),
    );

    const collapsed = page.columns()[0]!;
    expect(emptyLine(collapsed)?.textContent).toBe("no active items — 4 done");
    expect(cards(collapsed)).toHaveLength(0);

    await page.clickDoneChip(collapsed);
    const expanded = page.columns()[0]!;
    expect(emptyLine(expanded)).toBeUndefined();
    expect(cards(expanded)).toHaveLength(4);
  });
});

describe("queueing while a run is in flight", () => {
  it("keeps the queue controls up and hides only start", async () => {
    const page = await openPage({ parents: PARENTS });

    await page.emitState(pageState({ started: true, complete: false, canStart: false }));
    expect(page.el("startbar").hidden).toBe(false);
    expect(page.el("start").hidden).toBe(true);
    expect(page.el("queue-add").textContent).toBe("queue next");
    expect(page.el("queue-clear").disabled).toBe(true);

    await page.emitState(pageState({ started: true, complete: false, canStart: false, queue: [42] }));
    expect(page.el("queue-clear").disabled).toBe(false);

    await page.emitState(pageState({ started: true, complete: true, canStart: true }));
    expect(page.el("start").hidden).toBe(false);
    expect(page.el("queue-add").textContent).toBe("queue after");
  });
});

describe("starting a run from the page", () => {
  it("keeps start disabled while the run request is in flight", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const page = await openPage({ parents: PARENTS, startRun: () => gate });

    await page.clickStart();
    expect(page.el("start").disabled).toBe(true);

    await page.filter("db eg");
    expect(page.el("start").disabled).toBe(true);
    expect(page.runCalls()).toHaveLength(1);

    release?.();
    await page.settle();
    expect(page.el("start").disabled).toBe(false);
  });
});

function twoRunState(feed = pageState().feed) {
  const first = pageRun(100, [pageItem(101, "api", "running")]);
  const second = pageRun(200, [pageItem(201, "web", "parked"), pageItem(202, "web", "running")], {
    complete: true,
    cap: 3,
  });
  return pageState({
    started: true,
    parent: second.parent,
    items: second.items,
    runs: [first, second],
    globalRunning: 2,
    queueSettings: { mode: "sequential", maxParallel: 2, globalCap: 5, parentCap: 2, paused: false },
    feed,
  });
}

function tabs(page: { el: (id: string) => FakeElement }): FakeElement[] {
  return page.el("run-tabs").elementChildren();
}

function feedMessages(page: { el: (id: string) => FakeElement }): string[] {
  return page.el("feed").texts().map((text) => text.slice(8));
}

describe("a tab per run", () => {
  it("draws one tab per run, opens on the primary run, and switching redraws the board and run controls", async () => {
    const page = await openPage({ state: twoRunState() });

    expect(tabs(page).map((tab) => tab.textContent)).toEqual(["#100 parent 100running", "#200 parent 200settling"]);
    expect(tabs(page)[1]?.className).toBe("active");
    expect(page.columns().map(heading)).toEqual(["web — 0/2 done"]);
    expect(page.el("run-cap").value).toBe("3");

    await page.click(tabs(page)[0]);
    expect(tabs(page)[0]?.className).toBe("active");
    expect(page.columns().map(heading)).toEqual(["api — 0/1 done"]);
    expect(page.el("feature").textContent).toContain("#100 parent 100");
    expect(page.el("run-cap").value).toBe("1");

    await page.click(page.el("toggle-pause"));
    await page.click(page.el("stop-run"));
    expect(page.requests().map((request) => request.path)).toEqual(["/api/runs/100/pause", "/api/runs/100/stop"]);
  });

  it("falls back to the primary run when the selected run disappears", async () => {
    const page = await openPage({ state: twoRunState() });
    await page.click(tabs(page)[0]);
    const remaining = pageRun(200, [pageItem(201, "web", "running")], { cap: 3 });
    await page.emitState(pageState({ started: true, parent: remaining.parent, items: remaining.items, runs: [remaining] }));

    expect(tabs(page).map((tab) => tab.className)).toEqual(["active"]);
    expect(page.columns().map(heading)).toEqual(["web — 0/1 done"]);
    await page.click(page.el("stop-run"));
    expect(page.requests().at(-1)?.path).toBe("/api/runs/200/stop");
  });

  it("resets an unsent run cap edit when switching to a run with the same cap", async () => {
    const first = pageRun(100, [pageItem(101, "api", "running")]);
    const second = pageRun(200, [pageItem(201, "web", "running")]);
    const page = await openPage({ state: pageState({ started: true, parent: first.parent, items: first.items, runs: [first, second] }) });
    await page.change("run-cap", "7");

    await page.click(tabs(page)[1]);
    expect(page.el("run-cap").value).toBe("1");
  });
});

describe("the feed follows the selected run", () => {
  const feed = [
    { at: "2026-10-22T09:00:00.000Z", kind: "note" as const, itemNumber: undefined, message: "control plane" },
    { at: "2026-10-22T09:00:01.000Z", kind: "note" as const, itemNumber: undefined, parentNumber: 100, message: "from 100" },
    { at: "2026-10-22T09:00:02.000Z", kind: "note" as const, itemNumber: undefined, parentNumber: 200, message: "from 200" },
  ];

  it("shows the selected parent's lines plus control-plane lines, and everything under all", async () => {
    const page = await openPage({ state: twoRunState(feed) });
    expect(feedMessages(page)).toEqual(["from 200", "control plane"]);

    await page.click(tabs(page)[0]);
    expect(feedMessages(page)).toEqual(["from 100", "control plane"]);

    await page.click(page.el("feed-all"));
    expect(feedMessages(page)).toEqual(["from 200", "from 100", "control plane"]);
  });
});

describe("the queue panel", () => {
  const queued = (overrides = {}) =>
    pageState({
      queue: [41, 42, 43],
      queueSettings: { mode: "sequential", maxParallel: 2, globalCap: 1, parentCap: 1, paused: false, ...overrides },
    });

  function rows(page: { el: (id: string) => FakeElement }): FakeElement[] {
    return page.el("queue-list").elementChildren();
  }

  function button(row: FakeElement | undefined, text: string): FakeElement | undefined {
    return row?.elementChildren().find((child) => child.textContent === text);
  }

  it("lists the queue in order and sends remove, reorder and clear", async () => {
    const page = await openPage({ parents: PARENTS, state: queued() });
    expect(rows(page).map((row) => row.elementChildren()[0]?.textContent)).toEqual([
      "1. #41 outreach polish",
      "2. #42 db egress",
      "3. #43 voice tags",
    ]);
    expect(button(rows(page)[0], "↑")?.disabled).toBe(true);

    await page.click(button(rows(page)[1], "×"));
    await page.click(button(rows(page)[0], "↓"));
    await page.click(button(rows(page)[2], "↑"));
    await page.click(page.el("queue-clear"));
    expect(page.requests()).toEqual([
      { method: "DELETE", path: "/api/queue/42", body: {} },
      { method: "POST", path: "/api/queue/reorder", body: { parents: [42, 41, 43] } },
      { method: "POST", path: "/api/queue/reorder", body: { parents: [41, 43, 42] } },
      { method: "POST", path: "/api/queue/clear", body: {} },
    ]);
  });

  it("toggles the mode with mode only, and sends maxParallel only in parallel mode", async () => {
    const page = await openPage({ state: queued() });
    expect(page.el("queue-max").hidden).toBe(true);
    await page.click(page.el("queue-mode"));

    await page.emitState(queued({ mode: "parallel", maxParallel: 3 }));
    expect(page.el("queue-max").hidden).toBe(false);
    expect(page.el("queue-max").value).toBe("3");
    await page.change("queue-max", "4");

    expect(page.requests()).toEqual([
      { method: "PUT", path: "/api/queue/mode", body: { mode: "parallel" } },
      { method: "PUT", path: "/api/queue/mode", body: { mode: "parallel", maxParallel: 4 } },
    ]);
  });

  it("offers resume only while the queue is paused", async () => {
    const page = await openPage({ state: queued() });
    expect(page.el("queue-resume").hidden).toBe(true);

    await page.emitState(queued({ paused: true }));
    expect(page.el("queue-resume").hidden).toBe(false);
    expect(page.el("queue-paused").hidden).toBe(false);
    await page.click(page.el("queue-resume"));
    expect(page.requests()).toEqual([{ method: "POST", path: "/api/queue/resume", body: {} }]);
  });
});

describe("the global cap", () => {
  it("reads the global cap and worker total, and new runs take the per-parent cap", async () => {
    const page = await openPage({ parents: PARENTS, state: twoRunState() });
    expect(page.el("cap").value).toBe("5");
    expect(page.el("global-slots").textContent).toBe("2/5 workers across parents");
    expect(page.el("start-cap").value).toBe("2");

    await page.click(page.el("set-cap"));
    expect(page.requests().at(-1)).toEqual({ method: "POST", path: "/api/cap", body: { value: 5 } });
  });
});
