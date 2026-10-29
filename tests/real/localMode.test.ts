import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_STAGES } from "../../src/engine/adapters.js";
import { loadRunModel } from "../../src/model/runModel.js";
import { parseProjectConfig } from "../../src/project/projectConfig.js";
import { buildLocalInitConfig } from "../../src/project/scaffold.js";
import { ISSUE_TRACKER_DOC, issueTrackerDoc, writeIssueTrackerDoc } from "../../src/project/trackerDoc.js";
import { loadOrchestratorConfig } from "../../src/real/env.js";
import { RecordingCommandRunner } from "../../src/real/fakeCommandRunner.js";
import { MemoryFileSystem } from "../../src/real/fileSystem.js";
import { RealGitOps } from "../../src/real/gitOps.js";
import { buildResolvePrompt, buildSalvagePrompt, buildStagePrompt, type StagePromptContext } from "../../src/real/promptBuilder.js";
import { checkLocalIssueFiles, containerEgressHosts, runPreflight } from "../../src/real/preflight.js";
import { LOCAL_PR_NOTES_FILE } from "../../src/tracker/local/pullRequests.js";
import { toRunSnapshot } from "../../src/tracker/local/snapshot.js";
import { LocalIssueStore } from "../../src/tracker/local/store.js";
import { isParentHandle, resolveParentHandle } from "../../src/cli/parentArg.js";
import { fsWith, repoDir, SANDCASTLE_DIR, testConfig, testLayout, testRunModel, testWorkItem, worktreeDir } from "./support.js";

function context(overrides: Partial<StagePromptContext> = {}): StagePromptContext {
  return {
    stage: "develop",
    item: testWorkItem(),
    branch: "feat/17-toy-slice",
    integrationBranch: "integration/toy-demo",
    requiredReading: ["CLAUDE.md"],
    memories: [],
    hubRepo: "local/demo",
    parentNumber: 16,
    feature: "toy-demo",
    tracker: "local",
    ...overrides,
  };
}

describe("local prompt variant", () => {
  const stages = ["develop", "simplify", "review"] as const;

  it.each(stages)("%s: no gh, no push, stage notes go to the untracked notes file", (stage) => {
    const prompt = buildStagePrompt(context({ stage }));
    expect(prompt).not.toMatch(/gh pr|gh auth|GH_TOKEN|git push/);
    expect(prompt).toContain(LOCAL_PR_NOTES_FILE);
    expect(prompt).toMatch(/never `git add` or commit it/);
    expect(prompt).not.toContain("Closes ");
  });

  it("review appends its marker section to the notes file, not a pull request body", () => {
    const prompt = buildStagePrompt(context({ stage: "review" }));
    expect(prompt).toContain(`cat >> ${LOCAL_PR_NOTES_FILE}`);
    expect(prompt).toContain("<!-- sandcastle:review -->");
    expect(prompt).not.toContain("pull request body");
  });

  it("develop writes What changed / How tested to the notes file", () => {
    const prompt = buildStagePrompt(context());
    expect(prompt).toContain(`cat > ${LOCAL_PR_NOTES_FILE}`);
    expect(prompt).toContain("## What changed");
    expect(prompt).toContain("## How tested");
  });

  it("salvage, resolve and rework prompts carry no gh pr or push either", () => {
    const rework = { round: 1, limit: 2, briefs: [{ round: 1, source: "review" as const, story: "wrong" }] };
    const prompts = [
      ...stages.map((stage) => buildSalvagePrompt(context({ stage }))),
      buildStagePrompt(context({ rework })),
      buildSalvagePrompt(context({ rework })),
      buildResolvePrompt(context(), ["a.ts"]),
    ];
    for (const prompt of prompts) expect(prompt).not.toMatch(/gh pr|git push|git fetch/);
  });

  it("the github variant is unchanged: gh pr create and a pull request body append", () => {
    const develop = buildStagePrompt(context({ tracker: "github" }));
    const review = buildStagePrompt(context({ tracker: "github", stage: "review" }));
    expect(develop).toContain("gh pr create --draft");
    expect(review).toContain("gh pr edit");
    expect(develop).not.toContain(LOCAL_PR_NOTES_FILE);
  });

  it("covers every built-in agent stage", () => {
    for (const stage of AGENT_STAGES) expect(buildStagePrompt(context({ stage }))).toContain(LOCAL_PR_NOTES_FILE);
  });
});

describe("local config and egress", () => {
  const ENV_PATH = join(SANDCASTLE_DIR, ".env.orchestrator");

  it("starts without GH_TOKEN, and without any env file", () => {
    const withFile = loadOrchestratorConfig(fsWith({ [ENV_PATH]: "ANTHROPIC_API_KEY=k" }), testLayout(), { tracker: "local" });
    expect(withFile).toMatchObject({ tracker: "local", ghToken: "", anthropicApiKey: "k" });
    expect(loadOrchestratorConfig(fsWith({}), testLayout(), { tracker: "local" }).ghToken).toBe("");
  });

  it("still demands GH_TOKEN for the github Tracker", () => {
    expect(() => loadOrchestratorConfig(fsWith({ [ENV_PATH]: "ANTHROPIC_API_KEY=k" }), testLayout(), { tracker: "github" })).toThrow(/no GH_TOKEN/);
  });

  it("probes no GitHub host from the containers", () => {
    expect(containerEgressHosts(testConfig({ tracker: "local" }))).not.toContain("api.github.com");
    expect(containerEgressHosts(testConfig())).toContain("api.github.com");
  });
});

const PARENT = ["# Toy demo", "", "```yaml", "sandcastle: v1", "feature: toy-demo", "```", ""].join("\n");

describe("local issue files", () => {
  let dir: string;
  let store: LocalIssueStore;

  function writeFeature(slug: string, files: Record<string, string>): void {
    const issues = join(dir, ".scratch", slug, "issues");
    mkdirSync(issues, { recursive: true });
    for (const [name, content] of Object.entries(files)) writeFileSync(join(issues, name), content);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sc-local-mode-"));
    store = new LocalIssueStore(join(dir, ".scratch"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("preflight skips gh and origin checks and validates the issue files", async () => {
    writeFeature("toy-demo", { "00-parent.md": PARENT, "01-first.md": "---\nrepo: api\n---\n# 01: First\n" });
    const runner = new RecordingCommandRunner();
    runner.respond("docker", "27.0.0\nsha");
    const report = await runPreflight({
      runner,
      fs: new MemoryFileSystem(),
      layout: testLayout(),
      config: testConfig({ tracker: "local" }),
      model: { ...testRunModel(), parentNumber: 100 },
      skipVerify: true,
      localStore: store,
      probe: async () => ({ ok: true, reason: undefined, detail: undefined }),
    });
    const names = report.checks.map((check) => check.name);
    expect(names).toContain("issue files");
    expect(names).not.toContain("gh auth (host)");
    expect(names).not.toContain("GH_TOKEN (containers)");
    expect(names).not.toContain("integration base");
    expect(runner.findAll(/^gh /)).toHaveLength(0);
    expect(runner.findAll(/fetch origin/)).toHaveLength(0);
    expect(report.checks.find((check) => check.name === "issue files")?.ok).toBe(true);
  });

  it("names the file with a missing or unknown repo, and sandcastle init as the fix", () => {
    writeFeature("toy-demo", {
      "00-parent.md": PARENT,
      "01-first.md": "# 01: First\n",
      "02-second.md": "---\nrepo: mobile\n---\n# 02: Second\n",
    });
    const attempt = () => checkLocalIssueFiles(store, 100);
    expect(attempt).toThrow(/01-first\.md: no `repo:`/);
    expect(attempt).toThrow(/02-second\.md: repo "mobile" is not a repo of this project/);
    expect(attempt).toThrow(/sandcastle init/);
  });

  it("reports an unparsable issue file as a failed check", async () => {
    writeFeature("toy-demo", { "00-parent.md": PARENT, "01-first.md": "---\nrepo: [api\n---\n# 01\n" });
    const report = await runPreflight({
      runner: new RecordingCommandRunner(),
      fs: new MemoryFileSystem(),
      layout: testLayout(),
      config: testConfig({ tracker: "local" }),
      model: { ...testRunModel(), parentNumber: 100 },
      skipVerify: true,
      localStore: store,
      probe: async () => ({ ok: true, reason: undefined, detail: undefined }),
    });
    expect(report.failures.map((check) => check.name)).toContain("issue files");
  });

  it("resolves a slug, #n, a number and a file path to the parent", () => {
    writeFeature("toy-demo", { "00-parent.md": PARENT, "01-first.md": "---\nrepo: api\n---\n# 01\n" });
    const project = { tracker: "local" as const, projectRoot: dir };
    expect(resolveParentHandle(project, "toy-demo")).toBe(100);
    expect(resolveParentHandle(project, "#100")).toBe(100);
    expect(resolveParentHandle(project, "100")).toBe(100);
    expect(resolveParentHandle(project, join(".scratch", "toy-demo", "issues", "00-parent.md"))).toBe(100);
    expect(() => resolveParentHandle(project, "nope")).toThrow(/no local issue "nope"/);
    expect(isParentHandle(project, "fixture.json")).toBe(false);
    expect(isParentHandle(project, "toy-demo")).toBe(true);
    expect(resolveParentHandle({ tracker: "github", projectRoot: dir }, "#12")).toBe(12);
    expect(() => resolveParentHandle({ tracker: "github", projectRoot: dir }, "toy-demo")).toThrow(/not an issue number/);
  });

  it("creates a parent file that satisfies the publish contract, with a unique slug", () => {
    const first = store.createParent({ title: "Add billing export!", body: "Export invoices as CSV." });
    expect(first.slug).toBe("add-billing-export");
    expect(first.parent.number).toBe(100);
    const text = readFileSync(first.parent.path, "utf8");
    expect(text).toContain("# Add billing export!");
    expect(text).toContain("feature: add-billing-export");
    const second = store.createParent({ title: "Add billing export" });
    expect(second.slug).toBe("add-billing-export-2");
    expect(second.parent.number).toBe(200);
    const result = loadRunModel(toRunSnapshot(store.feature(100), "local/demo"));
    expect(result.ok || result.errors.every((error) => error.includes("work item"))).toBe(true);
    expect(() => store.createParent({ title: "  " })).toThrow(/needs a title/);
  });
});

describe("local init output", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sc-init-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("builds a config the parser accepts with no hubRepo and no github slugs", () => {
    const raw = buildLocalInitConfig({ dirName: "My_App", commands: { bootstrap: "npm ci", checks: "npm test" }, port: 7781 });
    expect(raw).not.toHaveProperty("hubRepo");
    const project = parseProjectConfig(raw, join(dir, "my-app", ".sandcastle", "config.json"));
    expect(project.tracker).toBe("local");
    expect(project.name).toBe("my-app");
    expect(project.hubRepo).toBe("local/my-app");
    expect(Object.keys(project.repos)).toEqual(["my-app"]);
  });

  it("writes the local and github issue-tracker docs as separate variants", () => {
    const local = writeIssueTrackerDoc(dir, "local");
    expect(local).toEqual({ written: true, path: join(dir, ISSUE_TRACKER_DOC) });
    const text = readFileSync(local.path, "utf8");
    expect(text).toContain("Sandcastle's Tracker is `local`");
    expect(text).toContain(".scratch/");
    expect(text).not.toContain("gh issue");
    expect(issueTrackerDoc("github", "acme/hub")).toContain("Sandcastle's Tracker is `github`");
    expect(issueTrackerDoc("github", "acme/hub")).toContain("gh issue view");
    expect(issueTrackerDoc("github", "acme/hub")).not.toContain(".scratch/<feature-slug>");
  });

  it("leaves an existing issue-tracker doc alone", () => {
    writeIssueTrackerDoc(dir, "local");
    const again = writeIssueTrackerDoc(dir, "github", "acme/hub");
    expect(again.written).toBe(false);
    expect(readFileSync(again.path, "utf8")).toContain("Local markdown");
  });
});

describe("notes file stays out of git status", () => {
  const BRANCH = "feat/17-toy-slice";
  const WORKTREE = worktreeDir("api", "feat-17-toy-slice");
  const EXCLUDE = join(repoDir("api"), ".git", "info", "exclude");

  function gitOps(untrackedNotesFile: string | undefined) {
    const runner = new RecordingCommandRunner();
    runner.respond("--git-path info/exclude", `${EXCLUDE}\n`);
    const fs = fsWith({ [join(SANDCASTLE_DIR, ".env.sandbox")]: "NODE_ENV=development" }, [repoDir("api")]);
    const git = new RealGitOps({ runner, fs, layout: testLayout(), log: () => undefined, ...(untrackedNotesFile ? { untrackedNotesFile } : {}) });
    return { runner, fs, git };
  }

  it("adds the notes file to the repo's info/exclude when an item worktree is created", () => {
    const { fs, git } = gitOps(LOCAL_PR_NOTES_FILE);
    git.createItemBranch("api", BRANCH, "integration/toy-demo");
    expect(fs.readText(EXCLUDE)).toBe(`${LOCAL_PR_NOTES_FILE}\n`);
    git.createItemBranch("api", BRANCH, "integration/toy-demo");
    expect(fs.readText(EXCLUDE)).toBe(`${LOCAL_PR_NOTES_FILE}\n`);
    expect(WORKTREE).toContain("feat-17-toy-slice");
  });

  it("does nothing for the github Tracker", () => {
    const { runner, git } = gitOps(undefined);
    git.createItemBranch("api", BRANCH, "integration/toy-demo");
    expect(runner.findAll("info/exclude")).toHaveLength(0);
  });
});
