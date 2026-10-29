import { describe, expect, it } from "vitest";
import { buildAttention } from "../../../src/ui/board/attention.js";
import { lifecycleSteps, mergeCommand, webUrl } from "../../../src/ui/board/model.js";
import { renderDrawer } from "../../../src/ui/board/view/drawer.js";
import { renderMain } from "../../../src/ui/board/view/main.js";
import type { BoardUi, DrawerState } from "../../../src/ui/board/view/ui.js";
import type { BoardProject } from "../../../src/ui/board/model.js";
import { boardProject, NOW, uiItem, uiRun, uiState } from "./fixtures.js";
import { idleFeatureVerify, idlePolish } from "../../../src/ui/state.js";

const LOCAL_PARENT = { number: 100, title: "billing export", subIssues: 2, completedSubIssues: 2, integrationBranch: "integration/billing-export" };

function localProject(runs = [] as ReturnType<typeof uiRun>[]): BoardProject {
  return boardProject("local-app", uiState(runs, { tracker: "local", hubRepo: "local/app" }), { parents: [LOCAL_PARENT] });
}

function ui(projects: BoardProject[], drawer?: DrawerState): BoardUi {
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
    drawer,
    switcher: undefined,
    toasts: [],
    dialog: undefined,
    held: [],
    notifyPermission: "default",
    busy: new Set(),
    flash: undefined,
  };
}

const LOCAL_URL = "local-pr://app/integration/billing-export";

describe("Needs Attention kind 7 with the local Tracker", () => {
  it("names the branch and the git merge command, and offers no PR or issue link", () => {
    const [entry] = buildAttention([localProject()], "local-app");
    expect(entry).toMatchObject({
      kind: "integration-ready",
      rank: 7,
      local: true,
      merge: { branch: "integration/billing-export", command: "git merge origin/integration/billing-export" },
      actions: [],
    });
    expect(entry?.detail).toContain("integration/billing-export");
    expect(entry?.detail).toContain("no pull request");
  });

  it("takes the branch from the run when one exists", () => {
    const run = uiRun(100, [uiItem(101, "done")], { complete: true, settled: true, featureVerify: idleFeatureVerify("green"), polish: idlePolish("green") });
    const entry = buildAttention([localProject([run])], "local-app")[0];
    expect(entry?.merge?.branch).toBe("integration/p100");
  });

  it("renders the branch and a copy button wired to the command", () => {
    const html = renderMain(ui([localProject()]), buildAttention([localProject()], "local-app"));
    expect(html).toContain("git merge origin/integration/billing-export");
    expect(html).toContain('data-act="att-copy"');
    expect(html).toContain('data-copy="git merge origin/integration/billing-export"');
    expect(html).not.toContain("github.com");
  });

  it("keeps the PR link for a github Project", () => {
    const github = boardProject("gh", uiState([], { hubRepo: "acme/hub" }), { parents: [{ number: 90, title: "p", subIssues: 1, completedSubIssues: 1 }] });
    const [entry] = buildAttention([github], "gh");
    expect(entry?.merge).toBeUndefined();
    expect(entry?.actions[0]).toMatchObject({ id: "open-link", href: "https://github.com/acme/hub/issues/90" });
  });
});

describe("local Board View chrome", () => {
  const settled = uiRun(100, [uiItem(101, "done", { pullRequestUrl: LOCAL_URL, issueUrl: "" })], {
    complete: true,
    settled: true,
    featureVerify: { ...idleFeatureVerify("green"), pullRequests: [LOCAL_URL] },
    polish: { ...idlePolish("green"), pullRequests: [LOCAL_URL] },
  });

  it("labels the last Run Lifecycle step Integration branch, PRs for github", () => {
    expect(lifecycleSteps(settled, "real", "local").at(-1)).toMatchObject({ label: "Integration branch", state: "done", detail: "ready for your merge" });
    expect(lifecycleSteps(settled, "real").at(-1)?.label).toBe("PRs");
  });

  it("shows a tracker chip and no dead links for file-based issues", () => {
    const board = ui([localProject([settled])]);
    const html = renderMain(board, buildAttention(board.projects, board.currentId));
    expect(html).toContain("mode-chip tracker local");
    expect(html).toContain("Integration branch");
    expect(html).not.toContain('href=""');
    expect(html).not.toContain("local-pr://");
  });

  it("treats only http(s) urls as links", () => {
    expect(webUrl(LOCAL_URL)).toBeUndefined();
    expect(webUrl("")).toBeUndefined();
    expect(webUrl("https://github.com/a/b/pull/1")).toBe("https://github.com/a/b/pull/1");
    expect(mergeCommand("integration/x")).toBe("git merge origin/integration/x");
  });

  it("the add drawer creates a parent file in local mode and checks issue numbers on github", () => {
    const drawer: DrawerState = { kind: "add", projectId: "local-app", title: "Billing", text: "", busy: false, result: undefined };
    const local = renderDrawer(ui([localProject()], drawer), localProject(), drawer, "");
    expect(local.label).toBe("New orchestration issue");
    expect(local.body).toContain('data-act="add-title"');
    expect(local.body).toContain("Create parent file");
    expect(local.head).toContain(".scratch/");
    const github = boardProject("gh", uiState([]));
    const remote = renderDrawer(ui([github], drawer), github, drawer, "");
    expect(remote.label).toBe("Add orchestration issue");
    expect(remote.body).toContain("Issue numbers or URLs");
  });

  it("parked items show their branch instead of an issue link, with local re-queue wording", () => {
    const run = uiRun(100, [uiItem(101, "parked", { stage: "review", parkReason: "no", issueUrl: "", branch: "sc/101-slice" })]);
    const board = ui([localProject([run])]);
    const html = renderMain(board, buildAttention(board.projects, board.currentId));
    expect(html).toContain("sc/101-slice");
    expect(html).toContain("issue files are untouched");
    expect(html).not.toContain("ready-for-agent");
  });
});
