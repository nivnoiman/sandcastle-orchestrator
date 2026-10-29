import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRunModel } from "../../src/model/runModel.js";
import { parseProjectConfig } from "../../src/project/projectConfig.js";
import { NodeCommandRunner } from "../../src/real/commandRunner.js";
import { nodeFileSystem } from "../../src/real/fileSystem.js";
import { layoutFrom } from "../../src/real/paths.js";
import { createRunReader, ensureLocalRemote, LocalIssueStore, LocalTrackerClient } from "../../src/tracker/index.js";
import { parseFrontmatter, setFrontmatterKey } from "../../src/tracker/local/frontmatter.js";
import { toRunSnapshot } from "../../src/tracker/local/snapshot.js";

const GIT_TEST_TIMEOUT_MS = 120_000;

const PARENT = [
  "---",
  "# operator comment",
  "title-note: keep me",
  "---",
  "# Toy demo",
  "",
  "```yaml",
  "sandcastle: v1",
  "feature: toy-demo",
  "```",
  "",
].join("\n");

const FIRST = [
  "---",
  "repo: api",
  "status: ready-for-agent",
  "# operator note",
  "owner: niv",
  "---",
  "# 01: First slice",
  "",
  "**What to build:** a thing",
  "",
].join("\n");

const SECOND = [
  "# 02: Second slice",
  "",
  "**Blocked by:** 01-first-slice (First slice)",
  "",
  "**Status:** ready-for-agent",
  "",
  "- [ ] done",
  "",
].join("\n");

let root: string;

function write(relative: string, content: string): string {
  const path = join(root, relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function seedFeature(): { first: string; second: string; parent: string } {
  return {
    parent: write(".scratch/toy-demo/issues/00-parent.md", PARENT),
    first: write(".scratch/toy-demo/issues/01-first-slice.md", FIRST),
    second: write(".scratch/toy-demo/issues/02-second-slice.md", `---\nrepo: web\n---\n${SECOND}`),
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sc-local-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("frontmatter", () => {
  it("parses and round-trips one key without touching anything else", () => {
    const written = setFrontmatterKey(FIRST, "stage", "sc:developing");
    expect(parseFrontmatter(written).data).toMatchObject({ repo: "api", stage: "sc:developing", owner: "niv" });
    expect(written.replace("stage: sc:developing\n", "")).toBe(FIRST);
    expect(setFrontmatterKey(written, "stage", undefined)).toBe(FIRST);
  });

  it("adds frontmatter to a file that has none, keeping the body", () => {
    const written = setFrontmatterKey(SECOND, "state", "closed");
    expect(written).toBe(`---\nstate: closed\n---\n${SECOND}`);
    expect(parseFrontmatter(written).body).toBe(SECOND);
  });

  it("writes lists inline and quotes values that YAML would reinterpret", () => {
    const written = setFrontmatterKey(FIRST, "labels", ["sc:needs-human", "yes"]);
    expect(parseFrontmatter(written).data["labels"]).toEqual(["sc:needs-human", "yes"]);
  });
});

describe("local run reader", () => {
  it("maps the files to a run snapshot, with fallbacks for to-tickets' Status and Blocked by lines", async () => {
    seedFeature();
    const project = parseProjectConfig({ tracker: "local", name: "demo", repos: { api: { checks: "x" }, web: { checks: "x" } } }, join(root, ".sandcastle", "config.json"));
    expect(project.hubRepo).toBe("local/demo");
    const reader = createRunReader({ ...project, projectRoot: root });
    const [summary] = await reader.listParents();
    expect(summary).toMatchObject({ number: 100, title: "Toy demo", subIssues: 2, completedSubIssues: 0 });
    const snapshot = await reader.fetchRunSnapshot(100);
    expect(snapshot.subIssues.map((issue) => [issue.number, issue.title, issue.labels, issue.blockedBy])).toEqual([
      [101, "First slice", ["repo:api", "ready-for-agent"], null],
      [102, "Second slice", ["repo:web", "ready-for-agent"], [101]],
    ]);
    expect(snapshot.parent.labels).toContain("sandcastle");
  });

  it("feeds admission: blocked-by edges and closed state resolve like the GitHub snapshot", async () => {
    seedFeature();
    const store = new LocalIssueStore(join(root, ".scratch"));
    store.updateIssue(101, "blocked-by", []);
    store.updateIssue(102, "blocked-by", [1]);
    const project = parseProjectConfig({ tracker: "local", name: "demo", repos: { api: { checks: "x" }, web: { checks: "x" } } }, join(root, ".sandcastle", "config.json"));
    const reader = createRunReader({ ...project, projectRoot: root });
    const result = loadRunModel(await reader.fetchRunSnapshot(100));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.items.map((item) => [item.number, item.dependsOn, item.admission])).toEqual([
      [101, [], "queued"],
      [102, [101], "queued"],
    ]);
    store.updateIssue(101, "state", "closed");
    const next = await reader.fetchRunSnapshot(100);
    expect(next.subIssues[0]?.state).toBe("CLOSED");
  });

  it("numbers parents once and keeps them; accepts number, slug and path handles", () => {
    seedFeature();
    write(".scratch/another/issues/00-parent.md", PARENT);
    write(".scratch/another/issues/01-x.md", FIRST);
    const store = new LocalIssueStore(join(root, ".scratch"));
    expect(store.features().map((feature) => [feature.slug, feature.parent.number])).toEqual([["another", 100], ["toy-demo", 200]]);
    expect(readFileSync(join(root, ".scratch/toy-demo/issues/00-parent.md"), "utf8")).toContain("number: 200");
    expect(store.resolve("toy-demo")).toBe(200);
    expect(store.resolve("toy-demo/02")).toBe(202);
    expect(store.resolve("#201")).toBe(201);
    expect(store.resolve(".scratch/another/issues/01-x.md")).toBe(101);
    expect(() => store.resolve("nope")).toThrow(/no local issue/);
  });
});

describe("local writer", () => {
  function client(store: LocalIssueStore): LocalTrackerClient {
    return new LocalTrackerClient({
      runner: new NodeCommandRunner(),
      fs: nodeFileSystem,
      layout: layoutFrom(join(root, ".sandcastle"), root),
      store,
      locate: () => ({ repo: "api", branch: "x" }),
      itemOfBranch: () => undefined,
      log: () => undefined,
    });
  }

  it("writes only engine keys, keeps the Operator's lines, and re-reads Operator edits", () => {
    const { first } = seedFeature();
    const store = new LocalIssueStore(join(root, ".scratch"));
    const tracker = client(store);

    tracker.setStageLabel(101, "sc:developing");
    tracker.addLabel(101, "sc:needs-human");
    tracker.comment(101, "parked: tests red");
    const after = readFileSync(first, "utf8");
    expect(after).toContain("# operator note\nowner: niv");
    expect(parseFrontmatter(after).data).toMatchObject({ repo: "api", status: "ready-for-agent", stage: "sc:developing", labels: ["ready-for-agent", "sc:needs-human"] });
    expect(after).toContain("parked: tests red");
    expect(tracker.issueComments(101)).toEqual(["parked: tests red"]);
    expect(tracker.stageLabels(101)).toEqual(["sc:developing", "sc:needs-human"]);

    writeFileSync(first, after.replace("owner: niv", "owner: sam").replace("a thing", "a better thing"));
    tracker.swapLabels(101, "sc:needs-human", "ready-for-agent");
    const edited = readFileSync(first, "utf8");
    expect(edited).toContain("owner: sam");
    expect(edited).toContain("a better thing");
    expect(tracker.stageLabels(101)).toEqual(["sc:developing"]);
    const snapshotBody = toRunSnapshot(store.feature(100), "local/demo").subIssues[0]?.body;
    expect(snapshotBody).toContain("a better thing");
    expect(snapshotBody).not.toContain("parked: tests red");
  });

  it("setStageLabel drops other sc: labels, closeIssue closes with a note", () => {
    seedFeature();
    const store = new LocalIssueStore(join(root, ".scratch"));
    const tracker = client(store);
    tracker.addLabel(101, "sc:needs-human");
    tracker.setStageLabel(101, "sc:verifying");
    expect(tracker.stageLabels(101)).toEqual(["sc:verifying"]);
    tracker.closeIssue(101, "local-pr://api/x");
    expect(store.find(101).data["state"]).toBe("closed");
    expect(tracker.issueComments(101)[0]).toContain("local-pr://api/x");
  });
});

describe("local git remote and merge", () => {
  function codeRepo(): string {
    const dir = join(root, "code");
    mkdirSync(dir);
    git(dir, "init", "-q", "-b", "dev");
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "t");
    writeFileSync(join(dir, "a.txt"), "base\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "init");
    return dir;
  }

  function setup() {
    const dir = codeRepo();
    const layout = layoutFrom(join(root, ".sandcastle"), root, { repoRoots: { api: dir }, worktreesDir: join(root, "wt") });
    const deps = { runner: new NodeCommandRunner(), fs: nodeFileSystem, layout, integrationBase: "dev", log: () => undefined };
    return { dir, layout, deps };
  }

  it("stands a bare repo in for a missing origin, seeded with the base branch, and leaves a real origin alone", () => {
    const { dir, layout, deps } = setup();
    expect(ensureLocalRemote(deps, "api")).toBe(true);
    const bare = join(root, ".sandcastle", "remotes", "api.git");
    expect(existsSync(bare)).toBe(true);
    expect(git(dir, "remote", "get-url", "origin")).toBe(bare);
    expect(git(dir, "rev-parse", "origin/dev")).toBe(git(dir, "rev-parse", "dev"));
    expect(ensureLocalRemote(deps, "api")).toBe(false);
    expect(layout.repoRoots?.["api"]).toBe(dir);
  }, GIT_TEST_TIMEOUT_MS);

  it("merges an item's draft pull request with git merge --squash into the integration branch and records review", () => {
    const { dir, layout, deps } = setup();
    ensureLocalRemote(deps, "api");
    seedFeature();
    git(dir, "push", "origin", "dev:refs/heads/integration/toy-demo");
    git(dir, "checkout", "-q", "-b", "sc/101");
    writeFileSync(join(dir, "b.txt"), "one\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "feat: one");
    writeFileSync(join(dir, "c.txt"), "two\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "feat: two");
    git(dir, "push", "-q", "origin", "sc/101");
    git(dir, "checkout", "-q", "dev");

    const store = new LocalIssueStore(join(root, ".scratch"));
    const tracker = new LocalTrackerClient({
      runner: deps.runner,
      fs: deps.fs,
      layout,
      store,
      locate: () => ({ repo: "api", branch: "sc/101" }),
      itemOfBranch: () => 101,
      log: () => undefined,
    });
    const pullRequest = tracker.createDraftPullRequest({ repo: "api", branch: "sc/101", baseBranch: "integration/toy-demo", title: "feat: slice one", body: "## What changed" });
    expect(tracker.findPullRequest("api", "sc/101", "integration/toy-demo")?.isDraft).toBe(true);
    tracker.appendToPullRequestBody("api", pullRequest, "<!-- sandcastle:review -->\n## Review\nlooks good");

    const merged = tracker.mergePullRequest(101);
    expect(merged.url).toBe(pullRequest.url);
    expect(tracker.findPullRequest("api", "sc/101")).toBeUndefined();

    git(dir, "fetch", "-q", "origin");
    const log = git(dir, "log", "--format=%s", "origin/integration/toy-demo").split("\n");
    expect(log[0]).toBe("feat: slice one");
    expect(log).not.toContain("feat: one");
    expect(git(dir, "show", "origin/integration/toy-demo:c.txt")).toBe("two");
    expect(git(dir, "ls-remote", "--heads", "origin", "sc/101")).toBe("");
    const data = store.find(101).data;
    expect(data["review"]).toBe("approved (round 0)");
    expect(data["merged"]).toBe(git(dir, "rev-parse", "origin/integration/toy-demo"));
  }, GIT_TEST_TIMEOUT_MS);
});
