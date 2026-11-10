import { describe, expect, it } from "vitest";
import { buildAttention } from "../../../src/ui/board/attention.js";
import { isDismissed, pruneDismissed } from "../../../src/ui/board/humanAlerts.js";
import { ATTENTION_VISIBLE, renderAttention } from "../../../src/ui/board/view/attention.js";
import type { BoardUi } from "../../../src/ui/board/view/ui.js";
import { boardProject, NOW, uiItem, uiRun, uiState } from "./fixtures.js";

function entriesFor(reasons: Record<number, string>, since = "2026-08-15T08:00:00.000Z") {
  const items = Object.entries(reasons).map(([number, reason]) => uiItem(Number(number), "parked", { stage: "develop", parkReason: reason, phaseSince: since }));
  const project = boardProject("alpha", uiState([uiRun(10, items)]));
  return { project, entries: buildAttention([project], "alpha") };
}

function ui(entries: ReturnType<typeof entriesFor>, extra: Partial<BoardUi> = {}): BoardUi {
  return { scope: "project", projects: [entries.project], currentId: "alpha", nowMs: NOW, held: [], dismissed: {}, showDismissed: false, notifyPermission: "granted", busy: new Set(), ...extra } as unknown as BoardUi;
}

describe("attention dismissal", () => {
  it("hides only while the version is unchanged", () => {
    const first = entriesFor({ 1: "boom" }).entries[0]!;
    const dismissed = { [first.key]: first.version };
    expect(isDismissed(dismissed, first)).toBe(true);
    expect(isDismissed(dismissed, entriesFor({ 1: "different failure" }).entries[0]!)).toBe(false);
    expect(isDismissed(dismissed, entriesFor({ 1: "boom" }, "2026-08-15T08:30:00.000Z").entries[0]!)).toBe(false);
  });

  it("prunes dismissals of cleared entries but keeps unknown projects", () => {
    const { entries } = entriesFor({ 1: "a", 2: "b" });
    const dismissed = { [entries[0]!.key]: entries[0]!.version, [entries[1]!.key]: "stale", "other:parked:1:1": "v" };
    const pruned = pruneDismissed(dismissed, [entries[0]!], new Set(["alpha"]));
    expect(Object.keys(pruned).sort()).toEqual([entries[0]!.key, "other:parked:1:1"].sort());
    expect(pruneDismissed(pruned, [entries[0]!], new Set(["alpha"]))).toBe(pruned);
  });
});

describe("attention render", () => {
  const many = entriesFor(Object.fromEntries(Array.from({ length: 8 }, (_, i) => [i + 1, `reason ${i + 1}`])));

  it("labels a dismiss button per entry and keeps the true total", () => {
    const html = renderAttention(ui(many), many.entries);
    expect(html.match(/data-act="att-dismiss"/g)).toHaveLength(8);
    expect(html).toContain('aria-label="Dismiss: #1');
    expect(html).toContain('<span class="count">8</span>');
  });

  it("caps with a focusable scroll region and a +N more hint", () => {
    const html = renderAttention(ui(many), many.entries);
    expect(html).toMatch(/class="alerts-scroll"[^>]*tabindex="0"/);
    expect(html).toContain(`+${8 - ATTENTION_VISIBLE} more`);
    const few = entriesFor({ 1: "a", 2: "b" });
    expect(renderAttention(ui(few), few.entries)).not.toContain("alerts-scroll");
  });

  it("hides dismissed rows, counts them, and the toggle shows them again", () => {
    const dismissed = Object.fromEntries(many.entries.slice(0, 3).map((entry) => [entry.key, entry.version]));
    const hidden = renderAttention(ui(many, { dismissed }), many.entries);
    expect(hidden.match(/<li /g)).toHaveLength(5);
    expect(hidden).toContain("3 dismissed");
    expect(hidden).toContain('aria-pressed="false"');
    expect(hidden).not.toContain("alerts-scroll");
    expect(hidden).toContain('<span class="count">8</span>');
    const shown = renderAttention(ui(many, { dismissed, showDismissed: true }), many.entries);
    expect(shown.match(/<li /g)).toHaveLength(8);
    expect(shown.match(/ dismissed"/g)).toHaveLength(3);
    expect(shown).toContain('aria-pressed="true"');
    expect(shown).toContain('aria-label="Restore: #1');
  });

  it("keeps the section (with the toggle) when everything is dismissed", () => {
    const one = entriesFor({ 1: "a" });
    const html = renderAttention(ui(one, { dismissed: { [one.entries[0]!.key]: one.entries[0]!.version } }), one.entries);
    expect(html).toContain("1 dismissed");
    expect(html).not.toContain("<li ");
  });
});
