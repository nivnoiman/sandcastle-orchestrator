import { describe, expect, it } from "vitest";
import { buildAttention } from "../../../src/ui/board/attention.js";
import { transcriptTurns } from "../../../src/ui/board/transcript.js";
import { switchTargets } from "../../../src/ui/board/view/chrome.js";
import { renderMain } from "../../../src/ui/board/view/main.js";
import { renderRail } from "../../../src/ui/board/view/rail.js";
import type { BoardUi } from "../../../src/ui/board/view/ui.js";
import type { BoardProject } from "../../../src/ui/board/model.js";
import { boardProject, NOW, uiItem, uiRun, uiState } from "./fixtures.js";

function ui(projects: BoardProject[], extra: Partial<BoardUi> = {}): BoardUi {
  return {
    scope: "project",
    projects,
    currentId: projects[0]?.id ?? "",
    selectedRuns: {},
    feedAll: false,
    feedOpen: false,
    doneOpen: new Set(),
    parentQuery: "",
    selectedParent: "",
    startCap: undefined,
    theme: "auto",
    dashboard: { url: "http://127.0.0.1:7700/", up: false },
    nowMs: NOW,
    localFeed: {},
    drawer: undefined,
    switcher: undefined,
    toasts: [],
    busy: new Set(),
    flash: undefined,
    ...extra,
  };
}

function main(board: BoardUi): string {
  return renderMain(board, buildAttention(board.projects, board.currentId));
}

describe("board render", () => {
  const run = uiRun(10, [
    uiItem(1, "done", { stage: "verify", pullRequestUrl: "https://github.com/acme/api/pull/7" }),
    uiItem(2, "running", { stage: "develop", title: "<script>alert(1)</script>", quiet: { silentSeconds: 600, timeoutSeconds: 1200 } }),
    uiItem(3, "blocked", { blockers: [2] }),
  ]);

  it("renders columns from the project's stages with waits-on chips, Phase Clock and Quiet", () => {
    const html = main(ui([boardProject("alpha", uiState([run], { stages: ["queued", "develop", "security", "merged"] }))]));
    expect(html).toContain('aria-label="security"');
    expect(html).toContain('data-act="jump" data-n="2"');
    expect(html).toContain("quiet 10m / 20m");
    expect(html).toContain('data-since="');
    expect(html).toContain("1 merged");
  });

  it("shows a settled dry run's strip and gate cards as skipped, never idle or current", () => {
    const settled = uiRun(11, [uiItem(1, "done")], { complete: true, settled: true });
    const html = main(ui([boardProject("alpha", uiState([settled], { mode: "dry" }), { mode: "dry" })]));
    expect(html).not.toContain('class="step active"');
    expect(html).not.toContain('class="gate idle"');
    expect(html).toContain('class="gate skipped"');
    expect(html).toContain("dry run — nothing to polish");
  });

  it("keeps the Event feed closed by default and renders it, with a hide control, when opened", () => {
    const project = boardProject("alpha", uiState([run]));
    const closed = main(ui([project]));
    expect(closed).not.toContain("feed-panel");
    expect(closed).toContain('data-act="toggle-feed"');
    expect(closed).toContain('class="lower no-feed"');
    const open = main(ui([project], { feedOpen: true }));
    expect(open).toContain("feed-panel");
    expect(open).toContain('aria-label="Hide event feed"');
  });

  it("escapes item titles", () => {
    const html = main(ui([boardProject("alpha", uiState([run]))]));
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("shows the loud banner only for a dry Project Server", () => {
    const dry = main(ui([boardProject("alpha", uiState([run], { mode: "dry" }), { mode: "dry" })]));
    expect(dry).toContain("mode-banner");
    expect(dry).toContain("mode-chip dry");
    expect(main(ui([boardProject("alpha", uiState([run]))]))).not.toContain("mode-banner");
  });

  it("offers the parent picker with a filter on an Idle Project Server", () => {
    const parents = [{ number: 5, title: "Link previews", subIssues: 4, completedSubIssues: 0 }, { number: 6, title: "Slash commands", subIssues: 2, completedSubIssues: 1 }];
    const idle = boardProject("alpha", uiState([]), { idle: true, parents });
    const html = main(ui([idle]));
    expect(html).toContain("Idle Project Server");
    expect(html).toContain('data-act="parent-filter"');
    expect(html).toContain("#5 Link previews (0/4 closed)");
    const filtered = main(ui([idle], { parentQuery: "slash" }));
    expect(filtered).toContain("#6 Slash commands");
    expect(filtered).not.toContain("#5 Link previews");
  });

  it("disables Pause project when nothing is running and renders the rail badge", () => {
    const quiet = boardProject("alpha", uiState([]));
    expect(main(ui([quiet]))).toMatch(/Pause project/);
    expect(main(ui([quiet]))).toMatch(/disabled[^>]*data-act="pause-project"|data-act="pause-project"[^>]*disabled/);
    const parked = boardProject("alpha", uiState([uiRun(10, [uiItem(1, "parked", { stage: "develop" })])]));
    const board = ui([parked]);
    expect(renderRail(board, buildAttention(board.projects, "alpha"))).toContain('class="badge"');
  });

  it("links to the Dashboard only when it answers", () => {
    const project = boardProject("alpha", uiState([run]));
    const down = renderRail(ui([project]), []);
    expect(down).toContain("sandcastle dashboard");
    expect(down).not.toContain("Open dashboard");
    const up = renderRail(ui([project], { dashboard: { url: "http://127.0.0.1:7700/", up: true } }), []);
    expect(up).toContain("Open dashboard");
  });
});

describe("switcher and transcript", () => {
  it("filters projects and runs for Ctrl K", () => {
    const projects = [boardProject("alpha", uiState([uiRun(10, [])])), boardProject("beta", uiState([uiRun(20, [])]))];
    expect(switchTargets(projects, "").map((target) => target.label)).toEqual(["alpha", "#10 parent 10", "beta", "#20 parent 20"]);
    expect(switchTargets(projects, "20").map((target) => target.label)).toEqual(["#20 parent 20"]);
  });

  it("turns agent JSON lines into readable turns", () => {
    const text = [
      JSON.stringify({ type: "system", subtype: "init", model: "m" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hello" }, { type: "tool_use", name: "Bash", input: { command: "ls" } }] } }),
      "plain line",
      "{broken",
    ].join("\n");
    const turns = transcriptTurns(text);
    expect(turns.map((turn) => turn.kind)).toEqual(["meta", "", "meta", "meta"]);
    expect(turns[1]?.text).toContain("→ Bash");
  });
});
