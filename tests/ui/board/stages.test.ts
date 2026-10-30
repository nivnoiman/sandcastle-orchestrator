import { describe, expect, it } from "vitest";
import { draftEdits, draftOf } from "../../../src/ui/board/stagesDraft.js";
import { renderDrawer } from "../../../src/ui/board/view/drawer.js";
import type { BoardUi } from "../../../src/ui/board/view/ui.js";
import type { StagesView } from "../../../src/project/stagesEditor.js";
import { boardProject, NOW, uiState } from "./fixtures.js";

const VIEW: StagesView = {
  stages: [
    { name: "develop", kind: "builtin", hasAgent: true, agent: undefined },
    { name: "review", kind: "builtin", hasAgent: true, agent: { provider: "codex", model: "gpt-5.5" } },
    { name: "e2e", kind: "command", hasAgent: false, agent: undefined, run: "npm run e2e <b>" },
    { name: "verify", kind: "verify", hasAgent: false, agent: undefined },
  ],
  defaultAgent: { provider: "claude", model: undefined },
  providers: ["claude", "codex", "cursor"],
  models: { claude: ["opus"], codex: ["gpt-5.5"], cursor: [] },
  placeholders: [],
  appliesTo: "new runs",
};

function drawer(extra: object = {}) {
  return { kind: "stages" as const, projectId: "p", view: VIEW as StagesView | undefined, draft: draftOf(VIEW), busy: false, error: undefined as string | undefined, notice: undefined as string | undefined, ...extra };
}

function render(d: ReturnType<typeof drawer>): string {
  const project = boardProject("p", uiState([]));
  return renderDrawer({ nowMs: NOW } as BoardUi, project, d, "").body;
}

describe("stage draft", () => {
  it("starts clean and sends nothing", () => {
    expect(draftEdits(VIEW, draftOf(VIEW))).toEqual([]);
  });

  it("sends only the rows that changed; an empty provider clears the row", () => {
    const draft = draftOf(VIEW);
    draft["develop"] = { provider: "claude", model: " opus " };
    draft["review"] = { provider: "", model: "ignored" };
    expect(draftEdits(VIEW, draft)).toEqual([
      { name: "develop", provider: "claude", model: "opus" },
      { name: "review", provider: null, model: null },
    ]);
  });
});

describe("stages drawer", () => {
  it("shows the flow, a picker per agent row, and the new-runs-only notice", () => {
    const html = render(drawer());
    expect(html).toContain("Applies to new runs only");
    expect(html).toContain('<span class="flow-step">review</span>');
    expect(html).toContain('data-act="stage-provider"');
    expect(html).toContain('<option value="gpt-5.5">');
    expect(html).toContain("default (claude)");
  });

  it("escapes command text, shows no pickers for command and verify rows, and disables Save until something changed", () => {
    const html = render(drawer());
    expect(html).toContain("npm run e2e &lt;b&gt;");
    expect(html).not.toContain('data-stage="e2e"');
    expect(html).not.toContain('data-stage="verify"');
    expect(html).toMatch(/<button[^>]*data-act="stages-save"[^>]*>|<button[^>]*disabled[^>]*>[^<]*Save/);
    expect(html).toMatch(/disabled[^>]*data-act="stages-save"|data-act="stages-save"[^>]*disabled/);
  });

  it("counts pending changes on the Save button and shows an error", () => {
    const d = drawer({ error: "boom <x>" });
    d.draft["develop"] = { provider: "codex", model: "" };
    const html = render(d);
    expect(html).toContain("Save 1 change");
    expect(html).toContain("boom &lt;x&gt;");
  });

  it("shows Loading before the view arrives", () => {
    expect(render(drawer({ view: undefined, draft: {} }))).toContain("Loading");
  });
});
