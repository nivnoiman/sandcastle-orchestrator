import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CommandFailure } from "../../src/real/commandRunner.js";
import { RecordingCommandRunner } from "../../src/real/fakeCommandRunner.js";
import { isRebaseConflict } from "../../src/engine/adapters.js";
import {
  commitSubjectsAhead,
  countCommitsAhead,
  isRebasedOnto,
  MAX_CONFLICT_FILES,
  extendedLengthPath,
  RealGitOps,
  removeWorktreeTree,
  unmergedPaths,
} from "../../src/real/gitOps.js";
import { fsWith, repoDir, SANDCASTLE_DIR, testLayout, worktreeDir } from "./support.js";

const INTEGRATION = "integration/toy-demo";
const BRANCH = "feat/17-toy-slice";
const SANITIZED = "feat-17-toy-slice";
const API = repoDir("api");
const WORKTREE = worktreeDir("api", SANITIZED);
const SANDBOX_ENV = join(SANDCASTLE_DIR, ".env.sandbox");

function harness(options: { worktreeExists?: boolean; platform?: NodeJS.Platform } = {}) {
  const runner = new RecordingCommandRunner();
  const directories = [API, ...(options.worktreeExists ? [WORKTREE] : [])];
  const fs = fsWith({ [SANDBOX_ENV]: "NODE_ENV=development" }, directories);
  const messages: string[] = [];
  const git = new RealGitOps({ runner, fs, layout: testLayout(), log: (message) => messages.push(message), now: () => 1_700_000_000_000, platform: options.platform ?? "linux" });
  return { runner, fs, git, messages };
}

describe("createIntegrationBranch", () => {
  it("pushes origin/dev to the integration branch when it does not exist yet", () => {
    const { runner, git } = harness();
    git.createIntegrationBranch("api", INTEGRATION);
    expect(runner.lines).toEqual([
      "git fetch origin --prune",
      `git ls-remote --heads origin ${INTEGRATION}`,
      `git push origin origin/dev:refs/heads/${INTEGRATION}`,
    ]);
    expect(runner.find("push")?.cwd).toBe(API);
  });

  it("is a no-op when the integration branch is already on origin", () => {
    const { runner, git } = harness();
    runner.respond("ls-remote", `abc123\trefs/heads/${INTEGRATION}`);
    git.createIntegrationBranch("api", INTEGRATION);
    expect(runner.findAll("push")).toHaveLength(0);
  });

  it("fails fast when the sibling checkout is missing", () => {
    const runner = new RecordingCommandRunner();
    const git = new RealGitOps({ runner, fs: fsWith({}), layout: testLayout(), log: () => undefined });
    expect(() => git.createIntegrationBranch("api", INTEGRATION)).toThrow(/repos.<name>.path/);
  });
});

describe("createItemBranch", () => {
  it("adds a worktree off the integration branch and installs the sanitized env", () => {
    const { runner, git, fs } = harness();
    git.createItemBranch("api", BRANCH, INTEGRATION);
    expect(runner.lines).toEqual([
      "git fetch origin --prune",
      `git ls-remote --heads origin ${BRANCH}`,
      `git branch --list ${BRANCH}`,
      `git worktree add --force -b ${BRANCH} ${WORKTREE} origin/${INTEGRATION}`,
    ]);
    expect(fs.readText(join(WORKTREE, ".env"))).toBe("NODE_ENV=development");
  });

  it("reuses an item branch that already exists on origin", () => {
    const { runner, git } = harness();
    runner.respond(`ls-remote --heads origin ${BRANCH}`, `abc123\trefs/heads/${BRANCH}`);
    git.createItemBranch("api", BRANCH, INTEGRATION);
    expect(runner.find("worktree add")?.line).toBe(`git worktree add --force -B ${BRANCH} ${WORKTREE} origin/${BRANCH}`);
    expect(runner.findAll("branch --list")).toHaveLength(0);
  });

  it("reuses a local-only branch a killed run left behind, keeping its commits", () => {
    const { runner, git, messages } = harness();
    runner.respond(`branch --list ${BRANCH}`, `  ${BRANCH}\n`);
    git.createItemBranch("api", BRANCH, INTEGRATION);
    expect(runner.find("worktree add")?.line).toBe(`git worktree add --force -B ${BRANCH} ${WORKTREE} ${BRANCH}`);
    expect(messages.some((message) => message.includes("its commits are kept"))).toBe(true);
  });

  it("removes a stale worktree with git, never with a recursive delete", () => {
    const { runner, git } = harness({ worktreeExists: true });
    git.createItemBranch("api", BRANCH, INTEGRATION);
    expect(runner.lines).toContain(`git worktree remove --force ${WORKTREE}`);
    expect(runner.findAll(/rm -rf|rimraf|Remove-Item/)).toHaveLength(0);
  });

  it("explains the node_modules junction hazard when git cannot remove the stale worktree", () => {
    const { runner, git } = harness({ worktreeExists: true });
    runner.fail("worktree remove", new CommandFailure("git", ["worktree", "remove"], 128, "", "locked"));
    expect(() => git.createItemBranch("api", BRANCH, INTEGRATION)).toThrow(/never delete it with rm -rf/);
  });


  it("falls back to an extended-length rmdir on Windows when git cannot remove the stale worktree", () => {
    const runner = new RecordingCommandRunner();
    runner.fail("worktree remove", new CommandFailure("git", ["worktree", "remove"], 255, "", "Filename too long"));
    removeWorktreeTree({ runner, fs: fsWith({}), platform: "win32" }, API, WORKTREE);
    const rmdir = runner.find("rmdir");
    expect(rmdir?.args).toEqual(["/d", "/c", "rmdir", "/s", "/q", extendedLengthPath(WORKTREE)]);
    expect(extendedLengthPath("E:\\sc\\worktrees\\api\\feat-1")).toBe("\\\\?\\E:\\sc\\worktrees\\api\\feat-1");
    expect(runner.lines.at(-1)).toBe("git worktree prune");
  });

  it("still fails loudly when the folder survives the Windows fallback", () => {
    const runner = new RecordingCommandRunner();
    runner.fail("worktree remove", new CommandFailure("git", ["worktree", "remove"], 255, "", "Filename too long"));
    const survivor = { runner, fs: fsWith({}, [WORKTREE]), platform: "win32" as const };
    expect(() => removeWorktreeTree(survivor, API, WORKTREE)).toThrow(/survived both git worktree remove and rmdir/);
  });

  it("keeps the git error off Windows", () => {
    const runner = new RecordingCommandRunner();
    runner.fail("worktree remove", new CommandFailure("git", ["worktree", "remove"], 128, "", "locked"));
    expect(() => removeWorktreeTree({ runner, fs: fsWith({}), platform: "linux" }, API, WORKTREE)).toThrow(/locked/);
    expect(runner.find("rmdir")).toBeUndefined();
  });

  it("fails fast when no sanitized sandbox env exists for the repo", () => {
    const runner = new RecordingCommandRunner();
    const git = new RealGitOps({ runner, fs: fsWith({}, [API]), layout: testLayout(), log: () => undefined });
    expect(() => git.createItemBranch("api", BRANCH, INTEGRATION)).toThrow(/missing sanitized sandbox env/);
  });
});

describe("rebaseOntoIntegration", () => {
  it("rebases inside the worktree and updates the remote branch with a lease", () => {
    const { runner, git } = harness({ worktreeExists: true });
    git.rebaseOntoIntegration("api", BRANCH, INTEGRATION);
    expect(runner.lines).toEqual([
      "git fetch origin --prune",
      "git status --porcelain",
      `git rebase origin/${INTEGRATION}`,
      `git push --force-with-lease origin ${BRANCH}`,
    ]);
    expect(runner.find("rebase origin")?.cwd).toBe(WORKTREE);
  });

  it("saves a killed stage's uncommitted leftovers as a patch and discards them before rebasing", () => {
    const { runner, fs, git, messages } = harness({ worktreeExists: true });
    runner.respond("status --porcelain", " M src/half.ts\n?? src/new.ts\n", 1);
    runner.respond("diff --cached --binary HEAD", "diff --git a/src/half.ts b/src/half.ts\n");
    git.rebaseOntoIntegration("api", BRANCH, INTEGRATION);
    expect(runner.lines).toEqual([
      "git fetch origin --prune",
      "git status --porcelain",
      "git add --all",
      "git diff --cached --binary HEAD",
      "git reset --hard HEAD",
      "git clean -fd",
      `git rebase origin/${INTEGRATION}`,
      `git push --force-with-lease origin ${BRANCH}`,
    ]);
    const saved = join(SANDCASTLE_DIR, "logs", "leftovers", `api-${SANITIZED}-1700000000000.patch`);
    expect(fs.readText(saved)).toContain("src/half.ts");
    expect(messages.join()).toContain(saved);
  });

  it("aborts the rebase and reports the conflict", () => {
    const { runner, git } = harness({ worktreeExists: true });
    runner.fail(`rebase origin/${INTEGRATION}`, new CommandFailure("git", ["rebase"], 1, "", "CONFLICT (content)"));
    expect(() => git.rebaseOntoIntegration("api", BRANCH, INTEGRATION)).toThrow(/does not rebase cleanly/);
    expect(runner.lines).toContain("git rebase --abort");
  });

  it("fails fast when the worktree disappeared", () => {
    const { git } = harness();
    expect(() => git.rebaseOntoIntegration("api", BRANCH, INTEGRATION)).toThrow(/worktree .* is gone/);
  });

  it("names the conflicting files from git status before aborting", () => {
    const { runner, git } = harness({ worktreeExists: true });
    runner.fail(`rebase origin/${INTEGRATION}`, new CommandFailure("git", ["rebase"], 1, "", "CONFLICT (content)"));
    runner.respond("status --porcelain", "", 1);
    runner.respond("status --porcelain", "UU src/a.ts\nAA src/b.ts\n M src/untouched.ts\n?? scratch.txt\n");
    let thrown: unknown;
    try {
      git.rebaseOntoIntegration("api", BRANCH, INTEGRATION);
    } catch (cause) {
      thrown = cause;
    }
    expect(isRebaseConflict(thrown)).toBe(true);
    if (!isRebaseConflict(thrown)) return;
    expect(thrown.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(thrown.gitOutput).toContain("CONFLICT (content)");
    expect(thrown.message).toContain("merge conflict in src/a.ts, src/b.ts");
    expect(runner.find("status --porcelain")?.cwd).toBe(WORKTREE);
    expect(runner.lines.lastIndexOf("git status --porcelain")).toBeLessThan(runner.lines.indexOf("git rebase --abort"));
  });

  it("stays a plain failure when git reports no unmerged paths", () => {
    const { runner, git } = harness({ worktreeExists: true });
    runner.fail(`rebase origin/${INTEGRATION}`, new CommandFailure("git", ["rebase"], 128, "", "not something we can rebase"));
    let thrown: unknown;
    try {
      git.rebaseOntoIntegration("api", BRANCH, INTEGRATION);
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/does not rebase cleanly/);
    expect(isRebaseConflict(thrown)).toBe(false);
  });

  it("does not let a failing git status hide the rebase failure", () => {
    const { runner, git } = harness({ worktreeExists: true });
    runner.fail(`rebase origin/${INTEGRATION}`, new CommandFailure("git", ["rebase"], 1, "", "CONFLICT (content)"));
    runner.respond("status --porcelain", "", 1);
    runner.fail("status --porcelain", new CommandFailure("git", ["status"], 1, "", "index locked"));
    expect(() => git.rebaseOntoIntegration("api", BRANCH, INTEGRATION)).toThrow(/does not rebase cleanly/);
  });
});

describe("unmergedPaths", () => {
  it("keeps only the conflict status codes", () => {
    expect(unmergedPaths("UU a.ts\nDD b.ts\nAU c.ts\nUD d.ts\nUA e.ts\nDU f.ts\nAA g.ts")).toEqual([
      "a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts",
    ]);
  });

  it("drops staged, modified and untracked entries", () => {
    expect(unmergedPaths("M  staged.ts\n M dirty.ts\n?? new.ts\nA  added.ts")).toEqual([]);
  });

  it("bounds the list so a whole-tree conflict cannot flood the park comment", () => {
    const porcelain = Array.from({ length: MAX_CONFLICT_FILES + 10 }, (_, index) => `UU src/file${index}.ts`).join("\n");
    expect(unmergedPaths(porcelain)).toHaveLength(MAX_CONFLICT_FILES);
  });

  it("tolerates CRLF porcelain output", () => {
    expect(unmergedPaths("UU src/a.ts\r\nUU src/b.ts\r\n")).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

describe("countCommitsAhead", () => {
  it("counts commits between the integration branch and the worktree head", () => {
    const runner = new RecordingCommandRunner();
    runner.respond("git log", "a1b2c3\nd4e5f6\n");
    expect(countCommitsAhead(runner, WORKTREE, INTEGRATION)).toBe(2);
    expect(runner.lines[0]).toBe(`git log origin/${INTEGRATION}..HEAD --format=%h`);
  });

  it("reports zero for an untouched branch", () => {
    const runner = new RecordingCommandRunner();
    expect(countCommitsAhead(runner, WORKTREE, INTEGRATION)).toBe(0);
  });
});

describe("commitSubjectsAhead", () => {
  it("reads the commit subjects so stage tags can be counted off them", () => {
    const runner = new RecordingCommandRunner();
    runner.respond("git log", "feat: toy slice\r\nfix(review): guard the null\n\n");
    expect(commitSubjectsAhead(runner, WORKTREE, INTEGRATION)).toEqual([
      "feat: toy slice",
      "fix(review): guard the null",
    ]);
    expect(runner.lines[0]).toBe(`git log origin/${INTEGRATION}..HEAD --format=%s`);
  });

  it("reports nothing for an untouched branch", () => {
    const runner = new RecordingCommandRunner();
    expect(commitSubjectsAhead(runner, WORKTREE, INTEGRATION)).toEqual([]);
  });
});

describe("syncWithIntegration", () => {
  it("returns no conflicts when the branch still rebases cleanly", () => {
    const { runner, git } = harness({ worktreeExists: true });
    expect(git.syncWithIntegration("api", BRANCH, INTEGRATION)).toEqual([]);
    expect(runner.lines).toContain(`git push --force-with-lease origin ${BRANCH}`);
  });

  it("returns the conflicting files for the stage agent instead of throwing", () => {
    const { runner, git } = harness({ worktreeExists: true });
    runner.fail(`rebase origin/${INTEGRATION}`, new CommandFailure("git", ["rebase"], 1, "", "CONFLICT (content)"));
    runner.respond("status --porcelain", "UU src/a.ts\nAA src/b.ts\n");

    expect(git.syncWithIntegration("api", BRANCH, INTEGRATION)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(runner.lines).toContain("git rebase --abort");
  });

  it("still throws when the failure is not a conflict an agent could resolve", () => {
    const { git } = harness();
    expect(() => git.syncWithIntegration("api", BRANCH, INTEGRATION)).toThrow(/worktree .* is gone/);
  });
});

describe("isRebasedOnto", () => {
  it("is true when the integration tip is an ancestor of HEAD", () => {
    const runner = new RecordingCommandRunner();
    expect(isRebasedOnto(runner, WORKTREE, INTEGRATION)).toBe(true);
    expect(runner.lines).toEqual(["git fetch origin --prune", `git merge-base --is-ancestor origin/${INTEGRATION} HEAD`]);
  });

  it("is false when the branch is still off the tip", () => {
    const runner = new RecordingCommandRunner();
    runner.fail("merge-base", new CommandFailure("git", ["merge-base"], 1, "", ""));
    expect(isRebasedOnto(runner, WORKTREE, INTEGRATION)).toBe(false);
  });
});
