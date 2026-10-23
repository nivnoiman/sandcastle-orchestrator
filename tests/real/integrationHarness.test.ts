import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TargetRepo } from "../../src/model/runModel.js";
import { resolveAgent } from "../../src/real/agents/index.js";
import { CommandFailure } from "../../src/real/commandRunner.js";
import { RecordingCommandRunner } from "../../src/real/fakeCommandRunner.js";
import { DockerIntegrationHarness, type IntegrationGit } from "../../src/real/integrationHarness.js";
import { POLISH_COMMAND_FILES, POLISH_NOTES_FILE } from "../../src/real/polish/runPolish.js";
import { CheckFailure } from "../../src/real/sandboxRunner.js";
import { fsWith, WORKTREES_DIR, testConfig, testLayout } from "./support.js";

const WORKTREE = join(WORKTREES_DIR, "api", "integration-toy-demo");
const API = join("W:", "work", "acme", "api");
const HOST_GIT_DIR = `${API}\\.git\\worktrees\\integration-toy-demo`;

class FakeGit implements IntegrationGit {
  readonly created: { repo: TargetRepo; branch: string; baseBranch: string }[] = [];
  readonly dropped: string[] = [];

  createItemBranch(repo: TargetRepo, branch: string, baseBranch: string): void {
    this.created.push({ repo, branch, baseBranch });
  }

  worktreeFor(): string {
    return WORKTREE;
  }

  dropWorktree(_repo: TargetRepo, target: string): void {
    this.dropped.push(target);
  }
}

function boot(files: Record<string, string> = {}) {
  const runner = new RecordingCommandRunner();
  runner.respond("rev-parse --absolute-git-dir", `${HOST_GIT_DIR}\n`);
  runner.respond("rev-parse HEAD", "abc123\n");
  const fs = fsWith(files, [WORKTREE]);
  const git = new FakeGit();
  const polish = new DockerIntegrationHarness({
    agent: { stage: "polish", agent: resolveAgent(testConfig(), "polish"), requiredCommands: POLISH_COMMAND_FILES },
    runner,
    fs,
    layout: testLayout(),
    config: testConfig(),
    git,
    parentNumber: 16,
    integrationBranch: "integration/toy-demo",
    log: () => undefined,
    now: () => 1_700_000_000_000,
  });
  return { runner, fs, git, polish };
}

describe("DockerIntegrationHarness", () => {
  it("checks out the integration branch and pins its head as the baseline", () => {
    const { git, polish } = boot();
    const workspace = polish.checkout("api");
    expect(git.created).toEqual([{ repo: "api", branch: "integration/toy-demo", baseBranch: "dev" }]);
    expect(workspace.baseline).toBe("abc123");
    expect(workspace.worktree).toBe(WORKTREE);
    expect(workspace.checks).toBe(testConfig().checkCommands.api);
  });

  it("runs the agent in a bind-mounted polish container that has the polish and review commands", async () => {
    const { runner, polish } = boot();
    const workspace = polish.checkout("api");
    await polish.runAgent(workspace, "polish it");

    const run = runner.find("docker run");
    expect(run?.line).toMatch(/sc-demo-polish-16-/);
    expect(runner.find("commands/polish.md")?.line).toContain("commands/review.md");
    expect(runner.find("claude -p")?.input).toBe("polish it");
    expect(runner.find("docker rm -f")).toBeDefined();
  });

  it("lists the commits polish made since the baseline", () => {
    const { runner, polish } = boot();
    runner.respond("abc123..HEAD", "chore: remove comments\nrefactor: simplify toy\n");
    expect(polish.commitsSince(polish.checkout("api"))).toEqual(["chore: remove comments", "refactor: simplify toy"]);
  });

  it("re-runs the checks in a copied workspace and reports a red run as a CheckFailure", async () => {
    const { runner, polish } = boot();
    const workspace = polish.checkout("api");
    runner.fail(workspace.checks, new CommandFailure("docker", [], 1, "FAIL toy.test.ts", ""));

    await expect(polish.runChecks(workspace)).rejects.toBeInstanceOf(CheckFailure);
    expect(runner.find("docker run")?.line).toContain("/home/agent/source");
    expect(runner.find("docker rm -f")).toBeDefined();
  });

  it("pushes the polished head onto the integration branch without forcing", () => {
    const { runner, polish } = boot();
    polish.push(polish.checkout("api"));
    const push = runner.find("git push");
    expect(push?.args).toEqual(["push", "origin", "HEAD:refs/heads/integration/toy-demo"]);
    expect(push?.cwd).toBe(WORKTREE);
  });

  it("reads the deferred-notes file once and deletes it so the checks never see it", () => {
    const notesFile = join(WORKTREE, POLISH_NOTES_FILE);
    const { fs, polish } = boot({ [notesFile]: "- a.ts:1 — deferred" });
    const workspace = polish.checkout("api");
    expect(polish.takeFile(workspace, POLISH_NOTES_FILE)).toBe("- a.ts:1 — deferred");
    expect(fs.exists(notesFile)).toBe(false);
    expect(polish.takeFile(workspace, POLISH_NOTES_FILE)).toBeUndefined();
  });

  it("resets tracked changes and removes untracked files, keeping ignored ones like .env", () => {
    const { runner, polish } = boot();
    runner.respond("status --porcelain", " M src/a.ts\n?? src/b.ts\n");
    expect(polish.discardUncommitted(polish.checkout("api"))).toEqual(["M src/a.ts", "?? src/b.ts"]);
    expect(runner.find("reset --hard HEAD")?.cwd).toBe(WORKTREE);
    expect(runner.find("clean -fd")?.args).toEqual(["clean", "-fd"]);
  });

  it("touches nothing when the tree is already clean", () => {
    const { runner, polish } = boot();
    expect(polish.discardUncommitted(polish.checkout("api"))).toEqual([]);
    expect(runner.find("reset --hard")).toBeUndefined();
  });

  it("keeps the real cause when the polish commands check fails", async () => {
    const { runner, polish } = boot();
    runner.fail("commands/polish.md", new Error("docker exec: container not running"));
    await expect(polish.runAgent(polish.checkout("api"), "polish it")).rejects.toThrow(/container not running/);
  });

  it("keeps the stage error when the container cannot be removed afterwards", async () => {
    const { runner, polish } = boot();
    const workspace = polish.checkout("api");
    runner.fail(workspace.checks, new Error("exit 1"));
    runner.fail("docker rm -f", new Error("daemon gone"));
    await expect(polish.runChecks(workspace)).rejects.toBeInstanceOf(CheckFailure);
  });

  it("drops the worktree on release", () => {
    const { git, polish } = boot();
    polish.release(polish.checkout("api"));
    expect(git.dropped).toEqual([WORKTREE]);
  });
});
