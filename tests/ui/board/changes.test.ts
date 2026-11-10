import { describe, expect, it } from "vitest";
import type { ChangesResult } from "../../../src/ui/changesRoutes.js";
import { parseDiff } from "../../../src/ui/changes/diff.js";
import { SAMPLE_DIFF } from "../../../src/ui/changes/sample.js";
import { markdownToHtml } from "../../../src/ui/board/mdPreview.js";
import { emptyChanges, fileId, matchesFilter, renderChanges, splitPairs, type ChangesState } from "../../../src/ui/board/view/changes.js";
import { renderDrawer } from "../../../src/ui/board/view/drawer.js";
import type { BoardUi, DrawerState } from "../../../src/ui/board/view/ui.js";
import { boardProject, uiItem, uiRun, uiState } from "./fixtures.js";

function ready(overrides: Partial<ChangesState> = {}, diff = SAMPLE_DIFF): ChangesState {
  const parsed = parseDiff(diff);
  const data: ChangesResult = { source: "branch", branch: "feat/x", base: "main", files: parsed.files, totals: parsed.totals, truncated: parsed.truncated, clipped: false, generated: false, generatedAt: "2026-01-01T00:00:00Z" };
  return { ...emptyChanges(), status: "ready", data, ...overrides };
}

describe("renderChanges", () => {
  it("lists every file with status, counts and a jump target, then a section per file", () => {
    const html = renderChanges(ready());
    expect(html).toContain("<b>7</b> files changed");
    expect(html).toContain('aria-label="Added"');
    expect(html).toContain('aria-label="Removed"');
    expect(html).toContain('aria-label="Renamed"');
    expect(html).toContain("src/billing/old-name.ts → src/billing/rows.ts");
    expect(html).toContain('data-act="changes-jump" data-path="src/billing/csv.ts"');
    expect(html).toContain(`id="${fileId("src/billing/csv.ts")}"`);
    expect(html).toContain('<span class="df-note">binary</span>');
    expect(html).toContain("Binary file not shown.");
    expect(html).toContain("Lockfile or generated file hidden");
  });

  it("renders hunk headers, line numbers and add/remove rows, escaping source text", () => {
    const html = renderChanges(ready({}, "diff --git a/x.html b/x.html\n--- a/x.html\n+++ b/x.html\n@@ -3,1 +3,1 @@\n-<b>old</b>\n+<script>alert(1)</script>\n"));
    expect(html).toContain("@@ -3,1 +3,1 @@");
    expect(html).toContain('<tr class="l del"><td class="n">3</td><td class="n"></td>');
    expect(html).toContain('<tr class="l add"><td class="n"></td><td class="n">3</td>');
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain('tabindex="0" role="region"');
  });

  it("filters files and folds sections", () => {
    const filtered = renderChanges(ready({ filter: "billing.md" }));
    expect(filtered).toContain('data-path="docs/billing.md"');
    expect(filtered).not.toContain('data-path="src/billing/csv.ts"');
    expect(matchesFilter(ready().data!.files[0]!, "EXPORT")).toBe(true);
    const folded = renderChanges(ready({ collapsed: ["src/billing/csv.ts"] }));
    expect(folded).toMatch(/aria-expanded="false"[^>]*data-path="src\/billing\/csv.ts"|data-path="src\/billing\/csv.ts"[^>]*aria-expanded="false"/);
    expect(folded).toContain(`id="${fileId("src/billing/csv.ts")}-body" hidden`);
  });

  it("switches to side-by-side with paired rows", () => {
    const split = renderChanges(ready({ layout: "split" }));
    expect(split).toContain('class="df split"');
    expect(split).toMatch(/aria-pressed="true"[^>]*data-layout="split"|data-layout="split"[^>]*aria-pressed="true"/);
    const pairs = splitPairs(parseDiff(SAMPLE_DIFF).files[0]!.hunks[0]!.lines);
    expect(pairs.some((pair) => pair.left?.kind === "del" && pair.right?.kind === "add")).toBe(true);
    expect(pairs.some((pair) => pair.left === undefined && pair.right?.kind === "add")).toBe(true);
  });

  it("offers Preview for markdown only and shows the rendered file when chosen", () => {
    const html = renderChanges(ready());
    expect(html.match(/data-act="changes-preview"/g)).toHaveLength(1);
    expect(html).toContain('data-act="changes-preview" data-path="docs/billing.md"');
    const previewing = renderChanges(ready({ previewing: ["docs/billing.md"], previews: { "docs/billing.md": { status: "ready", text: "# Hi\n\n- a\n- b", note: "" } } }));
    expect(previewing).toContain("<h1>Hi</h1>");
    expect(previewing).toContain("Show diff");
    expect(renderChanges(ready({ previewing: ["docs/billing.md"] }))).toContain("Loading preview");
  });

  it("shows loading, error and empty states and the truncation warning", () => {
    expect(renderChanges(emptyChanges())).toContain("Loading changes");
    expect(renderChanges({ ...emptyChanges(), status: "error", error: "no local branch" })).toContain('role="alert">no local branch');
    expect(renderChanges(ready({}, ""))).toContain("No changes against main yet.");
    const state = ready();
    state.data = { ...state.data!, truncated: true, totals: { ...state.data!.totals, files: 12 } };
    expect(renderChanges(state)).toContain("Showing a capped diff (5 more files not listed)");
    expect(renderChanges({ ...ready(), status: "loading" })).toContain("Refreshing…");
  });
});

describe("markdownToHtml", () => {
  it("renders headings, lists, code, quotes, tables and links", () => {
    const html = markdownToHtml("# T\n\nsome **bold** and `code` [x](https://a.b)\n\n1. one\n2. two\n\n```\n<raw>\n```\n\n> q\n\n| a | b |\n|---|---|\n| 1 | 2 |\n");
    expect(html).toContain("<h1>T</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain('<a href="https://a.b"');
    expect(html).toContain("<ol>");
    expect(html).toContain("&lt;raw&gt;");
    expect(html).toContain("<blockquote>q</blockquote>");
    expect(html).toContain("<th>a</th>");
  });

  it("escapes html and drops javascript: links", () => {
    const html = markdownToHtml("<img src=x onerror=alert(1)> [bad](javascript:alert(1))");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("href=");
  });
});

describe("drawer tabs", () => {
  const run = uiRun(10, [uiItem(1, "done", { branch: "feat/x" })]);
  const project = boardProject("alpha", uiState([run]));
  const board = { projects: [project], currentId: "alpha" } as unknown as BoardUi;
  const base: Extract<DrawerState, { kind: "item" }> = { kind: "item", projectId: "alpha", itemNumber: 1, attempts: [], attemptId: undefined, raw: false, loaded: true };

  it("defaults to the log tab and swaps the body for the diff on the Changes tab", () => {
    const log = renderDrawer(board, project, base, "");
    expect(log.attempts).toContain('role="tablist"');
    expect(log.attempts).toContain('id="d-tab-log"');
    expect(log.attempts).toContain("Attempts");
    const drawer: DrawerState = { ...base, tab: "changes", changes: ready() };
    const changes = renderDrawer(board, project, drawer, "");
    expect(changes.attempts).not.toContain("Attempts");
    expect(changes.attempts).toMatch(/aria-selected="true"[^>]*data-tab="changes"|data-tab="changes"[^>]*aria-selected="true"/);
    expect(changes.body).toContain("df-file");
  });

  it("also tabs the feature lifecycle drawer, which is keyed by the parent number", () => {
    const parent = renderDrawer(board, project, { ...base, itemNumber: 10, tab: "changes" }, "");
    expect(parent.head).toContain("Feature lifecycle");
    expect(parent.body).toContain("Loading changes");
  });
});
