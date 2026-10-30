import { describe, expect, it } from "vitest";
import { addBuiltin, addStage, draftEdits, draftOf, draftProblem, isDirty, missingBuiltins, moveRow, removeRow, type StagesDraft } from "../../../src/ui/board/stagesDraft.js";
import { renderDrawer } from "../../../src/ui/board/view/drawer.js";
import type { BoardUi, DrawerState } from "../../../src/ui/board/view/ui.js";
import type { StagesView } from "../../../src/project/stagesEditor.js";
import { boardProject, NOW, uiState } from "./fixtures.js";

const VIEW: StagesView = {
  stages: [
    { name: "develop", kind: "builtin", hasAgent: true, agent: undefined },
    { name: "review", kind: "builtin", hasAgent: true, agent: { provider: "codex", model: "gpt-5.5" } },
    { name: "security", kind: "agent", hasAgent: true, agent: undefined, promptText: "Audit {{issue}}\nsecond line", promptPath: ".sandcastle/prompts/security.md" },
    { name: "e2e", kind: "command", hasAgent: false, agent: undefined, run: "npm run e2e <b>" },
    { name: "perrepo", kind: "command", hasAgent: false, agent: undefined, run: { web: "npx playwright test" } },
    { name: "verify", kind: "verify", hasAgent: false, agent: undefined },
  ],
  defaultAgent: { provider: "claude", model: undefined },
  providers: ["claude", "codex", "cursor"],
  models: { claude: ["opus"], codex: ["gpt-5.5"], cursor: [] },
  placeholders: ["issue", "branch"],
  missingBuiltins: ["simplify"],
  promptsDir: ".sandcastle/prompts",
  appliesTo: "new runs",
};

function names(draft: StagesDraft): string[] {
  return draft.rows.map((row) => row.name);
}

type StagesDrawer = Extract<DrawerState, { kind: "stages" }>;

function drawer(extra: Partial<StagesDrawer> = {}): StagesDrawer {
  return { kind: "stages", projectId: "p", view: VIEW, draft: draftOf(VIEW), busy: false, error: undefined, notice: undefined, editing: undefined, dragKey: undefined, ...extra };
}

function render(d: StagesDrawer): string {
  const project = boardProject("p", uiState([]));
  return renderDrawer({ nowMs: NOW } as BoardUi, project, d, "").body;
}

describe("stage draft", () => {
  it("starts clean and sends nothing new", () => {
    expect(isDirty(VIEW, draftOf(VIEW))).toBe(false);
  });

  it("sends the whole chain in order, clearing an empty provider and trimming the model", () => {
    const draft = draftOf(VIEW);
    draft.rows[0]!.provider = "claude";
    draft.rows[0]!.model = " opus ";
    draft.rows[1]!.provider = "";
    expect(draftEdits(draft).slice(0, 3)).toEqual([
      { kind: "builtin", name: "develop", provider: "claude", model: "opus" },
      { kind: "builtin", name: "review", provider: null, model: null },
      { kind: "agent", name: "security", prompt: "Audit {{issue}}\nsecond line", provider: null, model: null },
    ]);
    expect(isDirty(VIEW, draft)).toBe(true);
  });

  it("keeps a per-repo command map as it was, and sends a plain command trimmed", () => {
    const draft = draftOf(VIEW);
    draft.rows[3]!.run = "  npm run e2e  ";
    const edits = draftEdits(draft);
    expect(edits[3]).toEqual({ kind: "command", name: "e2e", run: "npm run e2e" });
    expect(edits[4]).toEqual({ kind: "command", name: "perrepo", run: { web: "npx playwright test" } });
  });

  it("adds new stages just before verify, and puts a removed built-in back", () => {
    const draft = draftOf(VIEW);
    addStage(draft, "agent").name = "docs";
    addBuiltin(draft, "simplify");
    expect(names(draft)).toEqual(["develop", "review", "security", "e2e", "perrepo", "docs", "simplify", "verify"]);
    expect(missingBuiltins(draft)).toEqual([]);
  });

  it("removes stages but never develop or verify", () => {
    const draft = draftOf(VIEW);
    removeRow(draft, draft.rows[1]!.key);
    removeRow(draft, draft.rows[0]!.key);
    removeRow(draft, draft.rows.at(-1)!.key);
    expect(names(draft)).toEqual(["develop", "security", "e2e", "perrepo", "verify"]);
    expect(missingBuiltins(draft)).toEqual(["simplify", "review"]);
  });

  it("moves stages within develop..verify and leaves the locked ones alone", () => {
    const draft = draftOf(VIEW);
    moveRow(draft, draft.rows[3]!.key, 0);
    expect(names(draft)).toEqual(["develop", "e2e", "review", "security", "perrepo", "verify"]);
    moveRow(draft, draft.rows[1]!.key, 99);
    expect(names(draft)).toEqual(["develop", "review", "security", "perrepo", "e2e", "verify"]);
    moveRow(draft, draft.rows[0]!.key, 3);
    moveRow(draft, draft.rows.at(-1)!.key, 1);
    expect(names(draft)).toEqual(["develop", "review", "security", "perrepo", "e2e", "verify"]);
  });

  it("names what is missing before the server is asked", () => {
    const draft = draftOf(VIEW);
    expect(draftProblem(draft)).toBeUndefined();
    const added = addStage(draft, "agent");
    expect(draftProblem(draft)).toMatch(/Name the new agent stage/);
    added.name = "docs";
    expect(draftProblem(draft)).toMatch(/docs has no prompt/);
    added.prompt = "do it";
    expect(draftProblem(draft)).toBeUndefined();
    addStage(draft, "command").name = "lint";
    expect(draftProblem(draft)).toMatch(/lint has no command/);
  });
});

describe("stages drawer", () => {
  it("shows the flow, a picker per agent row, the prompt button and the new-runs-only notice", () => {
    const html = render(drawer());
    expect(html).toContain("Applies to new runs only");
    expect(html).toContain('<span class="flow-step">security</span>');
    expect(html).toContain('data-act="stage-provider"');
    expect(html).toContain('<option value="gpt-5.5">');
    expect(html).toContain("default (claude)");
    expect(html).toContain("Edit prompt…");
    expect(html).toContain("Audit {{issue}}");
    expect(html).toContain("+ Built-in…");
    expect(html).toContain('<option value="simplify">');
  });

  it("escapes command text, locks develop and verify, and keeps Save off until something changed", () => {
    const html = render(drawer());
    expect(html).toContain("npm run e2e &lt;b&gt;");
    expect(html).toContain("per repo:");
    expect(html).toContain(">first<");
    expect(html).toContain(">last<");
    expect(html).toMatch(/disabled[^>]*data-act="stages-save"|data-act="stages-save"[^>]*disabled/);
    const edited = drawer();
    edited.draft.rows[3]!.run = "npm run other";
    expect(render(edited)).not.toMatch(/disabled[^>]*data-act="stages-save"|data-act="stages-save"[^>]*disabled/);
  });

  it("offers drag grips only on movable rows", () => {
    const html = render(drawer());
    expect(html.match(/data-drag="stage"/g)?.length).toBe(4);
  });

  it("blocks Save with the reason when a new stage is incomplete", () => {
    const d = drawer();
    addStage(d.draft, "agent");
    const html = render(d);
    expect(html).toContain("Name the new agent stage.");
    expect(html).toMatch(/disabled[^>]*data-act="stages-save"|data-act="stages-save"[^>]*disabled/);
  });

  it("opens the prompt modal with the placeholders, the file path and the new-runs note", () => {
    const d = drawer();
    d.editing = d.draft.rows[2]!.key;
    const html = render(d);
    expect(html).toContain('role="dialog"');
    expect(html).toContain("<code>{{issue}}</code>");
    expect(html).toContain(".sandcastle/prompts/security.md");
    expect(html).toContain("A run already in flight keeps what it started with");
    expect(html).toContain("NEEDS-REWORK:");
  });

  it("shows a new stage's future prompt path, and escapes an error", () => {
    const d = drawer({ error: "boom <x>" });
    const added = addStage(d.draft, "agent");
    added.name = "docs";
    d.editing = added.key;
    const html = render(d);
    expect(html).toContain(".sandcastle/prompts/docs.md");
    expect(html).toContain("boom &lt;x&gt;");
  });

  it("shows Loading before the view arrives", () => {
    expect(render(drawer({ view: undefined, draft: { rows: [], nextKey: 0 } }))).toContain("Loading");
  });
});
