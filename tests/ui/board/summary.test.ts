import { describe, expect, it } from "vitest";
import { renderDrawer } from "../../../src/ui/board/view/drawer.js";
import type { DrawerState } from "../../../src/ui/board/view/ui.js";
import { emptySummary, renderSummary, type SummaryState, type SummaryView } from "../../../src/ui/board/view/summary.js";
import { boardProject, minutesAgo, NOW, uiItem, uiRun, uiState } from "./fixtures.js";

const item = uiItem(1, "parked", { stage: "review", parkReason: "review <b>failed</b>", reworkRound: 1, pullRequestUrl: "https://github.com/acme/api/pull/7", blockers: [4], agent: { provider: "claude", model: "opus" } });
const run = uiRun(10, [item]);
const stages = ["queued", "implement", "review", "merged"];

const attempts = [
  { id: "1-implement-1", stage: "implement", attempt: 1, outcome: "success", live: false, startedAt: minutesAgo(30), endedAt: minutesAgo(20) },
  { id: "1-review-1", stage: "review", attempt: 1, outcome: "failure", live: false, startedAt: minutesAgo(19), endedAt: minutesAgo(18) },
  { id: "1-review-2", stage: "review", attempt: 2, outcome: undefined, live: true, startedAt: minutesAgo(2), endedAt: undefined },
];

function view(extra: Partial<SummaryView> = {}): SummaryView {
  return { subject: { kind: "item", item, run }, attempts, attemptsLoaded: true, summary: emptySummary(), changes: undefined, stages, nowMs: NOW, ...extra };
}

function ready(data: Partial<NonNullable<SummaryState["data"]>>): SummaryState {
  return { ...emptySummary(), status: "ready", data: { task: undefined, taskClipped: false, attempts: [], generatedAt: "t", ...data } };
}

describe("renderSummary", () => {
  it("shows what, status with attempt counts, park reason and result", () => {
    const html = renderSummary(view({ summary: ready({ task: "Add the export" }) }));
    expect(html).toContain("Add the export");
    expect(html).toContain("sc/1");
    expect(html).toContain("2 attempts");
    expect(html).toContain("Rework 1/2");
    expect(html).toContain("opus");
    expect(html).toContain("Blocked by #4");
    expect(html).toContain("Load file counts");
    expect(html).toContain('href="https://github.com/acme/api/pull/7"');
  });

  it("escapes task text, agent messages and park reasons", () => {
    const html = renderSummary(view({ summary: ready({ task: "<script>alert(1)</script>", attempts: [{ id: "1-implement-1", message: '<img src=x onerror="1">', clipped: false }] }) }));
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("review &lt;b&gt;failed&lt;/b&gt;");
  });

  it("handles missing task, empty log and no attempts", () => {
    const html = renderSummary(view({ summary: ready({}) }));
    expect(html).toContain("No task text is available");
    expect(html).toContain("No agent message in this attempt");
    expect(html).toContain("Still running");
    expect(renderSummary(view({ attempts: [], summary: ready({}) }))).toContain("No agent attempt has been recorded yet.");
    expect(renderSummary(view({ attempts: [], attemptsLoaded: false }))).toContain("Loading…");
  });

  it("shows load errors and a missing subject", () => {
    expect(renderSummary(view({ summary: { ...emptySummary(), status: "error", error: "boom <x>" } }))).toContain("boom &lt;x&gt;");
    expect(renderSummary(view({ subject: undefined }))).toContain("no longer in the run");
  });

  it("reuses loaded changes for file counts", () => {
    const changes = { status: "ready", data: { base: "main", totals: { files: 3, additions: 12, deletions: 4 } } } as never;
    const html = renderSummary(view({ changes }));
    expect(html).toContain("3 files changed");
    expect(html).toContain("+12");
    expect(html).not.toContain("Load file counts");
  });

  it("renders a lighter feature lifecycle form", () => {
    const lifecycle = [{ id: "verify", label: "Verify", stage: "feature-verify", phase: "red", reason: "1 failing <i>", agent: undefined }] as never;
    const html = renderSummary(view({ subject: { kind: "feature", run: { ...run, lifecycle } }, attempts: [] }));
    expect(html).toContain("Verify");
    expect(html).toContain("integration/p10");
    expect(html).toContain("1 failing &lt;i&gt;");
  });
});

describe("drawer tabs", () => {
  const project = boardProject("alpha", uiState([run]));
  const board = { nowMs: NOW } as never;
  const base: Extract<DrawerState, { kind: "item" }> = { kind: "item", projectId: "alpha", itemNumber: 1, attempts: [], attemptId: undefined, raw: false, loaded: true };

  it("lists Summary first and swaps the body", () => {
    const parts = renderDrawer(board, project, { ...base, tab: "summary" }, "");
    expect(parts.attempts.indexOf("Summary")).toBeLessThan(parts.attempts.indexOf("Log"));
    expect(parts.attempts).toMatch(/data-tab="summary"[^>]*aria-selected="true"|aria-selected="true"[^>]*data-tab="summary"/);
    expect(parts.attempts).not.toContain("Attempts");
    expect(parts.body).toContain("sm-sec");
  });

  it("keeps the log when no tab is set", () => {
    expect(renderDrawer(board, project, base, "").attempts).toContain("Attempts");
  });
});
