import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OperatorError } from "../../src/engine/operatorError.js";
import { CommandFailure } from "../../src/real/commandRunner.js";
import { RecordingCommandRunner } from "../../src/real/fakeCommandRunner.js";
import { lockPath } from "../../src/real/lock.js";
import { applyReset, planReset, type ResetDeps, type ResetIssue } from "../../src/real/reset.js";
import { fsWith, repoDir, SANDCASTLE_DIR, testLayout, testRunModel, testWorkItem } from "./support.js";

const API = repoDir("api");
const LOCK = lockPath(testLayout());
const BRANCH_17 = "feat/17-toy-slice";
const BRANCH_18 = "feat/18-toy-slice-b";
const MANAGED_WORKTREE = join(SANDCASTLE_DIR, "worktrees", "api", "feat-17-toy-slice");

const MODEL = testRunModel([
  testWorkItem({ number: 17, title: "toy slice" }),
  testWorkItem({ number: 18, title: "toy slice b" }),
]);

function issue(overrides: Partial<ResetIssue> & { number: number }): ResetIssue {
  return { state: "OPEN", labels: [], ...overrides };
}

function harness(options: { lock?: string; issues?: ResetIssue[] } = {}) {
  const runner = new RecordingCommandRunner();
  const files: Record<string, string> = options.lock === undefined ? {} : { [LOCK]: options.lock };
  const fs = fsWith(files, [API]);
  const logs: string[] = [];
  const deps: ResetDeps = {
    runner,
    fs,
    layout: testLayout(),
    model: MODEL,
    issues: options.issues ?? [],
    hubRepo: "example-org/hub",
    isAlive: () => false,
    log: (message) => logs.push(message),
  };
  return { runner, fs, logs, deps };
}

function branchAt(runner: RecordingCommandRunner, branch: string, where: "local" | "origin"): void {
  const ref = where === "local" ? `refs/heads/${branch}` : `refs/remotes/origin/${branch}`;
  runner.respond(`rev-parse --verify --quiet ${ref}`, "abc123\n");
}

describe("reset — the lock", () => {
  it("refuses to reset while an orchestrator is still alive", () => {
    const { deps } = harness({ lock: JSON.stringify({ pid: 4242, startedAt: "2026-08-15T00:00:00.000Z" }) });
    expect(() => planReset({ ...deps, isAlive: () => true })).toThrow(OperatorError);
    expect(() => planReset({ ...deps, isAlive: () => true })).toThrow(/still running \(pid 4242\)/);
  });

  it("plans to reclaim a lock whose holder is dead and removes it on apply", () => {
    const { deps, fs } = harness({ lock: JSON.stringify({ pid: 4242, startedAt: "2026-08-15T00:00:00.000Z" }) });
    const plan = planReset(deps);
    expect(plan.lock).toMatchObject({ reclaim: true, pid: 4242, path: LOCK });
    expect(fs.exists(LOCK)).toBe(true);
    const report = applyReset(deps, plan);
    expect(report.lockReclaimed).toBe(true);
    expect(fs.exists(LOCK)).toBe(false);
  });

  it("reclaims a lock file it cannot parse rather than leaving the restart blocked", () => {
    const { deps } = harness({ lock: "{ not json" });
    expect(planReset(deps).lock).toMatchObject({ reclaim: true, pid: undefined });
  });

  it("has nothing to reclaim when no lock file exists", () => {
    const { deps } = harness();
    expect(planReset(deps).lock.reclaim).toBe(false);
  });
});

describe("reset — labels", () => {
  it("strips sc:* labels and flips a parked item back to ready-for-agent", () => {
    const { deps, runner } = harness({
      issues: [issue({ number: 17, labels: ["sc:needs-human", "ready-for-human", "repo:api"] })],
    });
    const plan = planReset(deps);
    expect(plan.labels).toEqual([{ itemNumber: 17, remove: ["sc:needs-human"], swapToAgent: true }]);
    applyReset(deps, plan);
    expect(runner.find("issue edit 17")?.line).toBe(
      "gh issue edit 17 --repo example-org/hub --remove-label sc:needs-human --remove-label ready-for-human --add-label ready-for-agent",
    );
  });

  it("leaves a human-set ready-for-human alone when sandcastle never parked the item", () => {
    const { deps } = harness({ issues: [issue({ number: 17, labels: ["ready-for-human"] })] });
    expect(planReset(deps).labels).toEqual([]);
  });

  it("never touches a closed or already-done item", () => {
    const { deps } = harness({
      issues: [
        issue({ number: 17, state: "CLOSED", labels: ["sc:done"] }),
        issue({ number: 18, labels: ["sc:done"] }),
      ],
    });
    expect(planReset(deps).labels).toEqual([]);
  });

  it("ignores issues that are not items of this parent", () => {
    const { deps } = harness({ issues: [issue({ number: 99, labels: ["sc:developing"] })] });
    expect(planReset(deps).labels).toEqual([]);
  });

  it("keeps a docker hiccup out of the write failures, so it cannot fail the whole reset", () => {
    const { deps, runner } = harness({ issues: [issue({ number: 17, labels: ["sc:developing"] })] });
    runner.fail(/docker ps/, new CommandFailure("docker", ["ps"], 1, "", "daemon not running"));
    const report = applyReset(deps, planReset(deps));
    expect(report.gc.failures.some((failure) => failure.includes("daemon not running"))).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.labelled).toEqual([17]);
  });

  it("records the failure instead of throwing when gh refuses", () => {
    const { deps, runner } = harness({ issues: [issue({ number: 17, labels: ["sc:developing"] })] });
    runner.fail("issue edit 17", new CommandFailure("gh", ["issue"], 1, "", "HTTP 403"));
    const report = applyReset(deps, planReset(deps));
    expect(report.labelled).toEqual([]);
    expect(report.failures.some((failure) => failure.includes("HTTP 403"))).toBe(true);
  });
});

describe("reset — item branches", () => {
  it("deletes an empty branch on both sides and keeps one carrying commits", () => {
    const { deps, runner } = harness();
    branchAt(runner, BRANCH_17, "local");
    branchAt(runner, BRANCH_17, "origin");
    branchAt(runner, BRANCH_18, "local");
    runner.respond("rev-parse --verify --quiet origin/integration/toy-demo", "def456\n");
    runner.respond(`rev-list --count origin/integration/toy-demo..${BRANCH_17}`, "0\n");
    runner.respond(`rev-list --count origin/integration/toy-demo..origin/${BRANCH_17}`, "0\n");
    runner.respond(`rev-list --count origin/integration/toy-demo..${BRANCH_18}`, "3\n");

    const plan = planReset(deps);
    expect(plan.branches.map((branch) => [branch.branch, branch.removable])).toEqual([
      [BRANCH_17, true],
      [BRANCH_18, false],
    ]);
    expect(plan.branches[1]?.verdict).toContain("3 commit(s)");

    const report = applyReset(deps, plan);
    expect(report.deletedBranches).toEqual([`[api] ${BRANCH_17}`]);
    expect(runner.findAll("branch -D").map((call) => call.line)).toEqual([`git branch -D ${BRANCH_17}`]);
    expect(runner.findAll("push origin --delete").map((call) => call.line)).toEqual([
      `git push origin --delete ${BRANCH_17}`,
    ]);
  });

  it("still reports the branch it deleted locally when the origin delete fails", () => {
    const { deps, runner } = harness();
    branchAt(runner, BRANCH_17, "local");
    branchAt(runner, BRANCH_17, "origin");
    runner.respond("rev-parse --verify --quiet origin/integration/toy-demo", "def456\n");
    runner.respond(`rev-list --count origin/integration/toy-demo..${BRANCH_17}`, "0\n");
    runner.respond(`rev-list --count origin/integration/toy-demo..origin/${BRANCH_17}`, "0\n");
    runner.fail(`push origin --delete ${BRANCH_17}`, new CommandFailure("git", ["push"], 1, "", "protected branch"));

    const report = applyReset(deps, planReset(deps));
    expect(runner.findAll("branch -D").map((call) => call.line)).toEqual([`git branch -D ${BRANCH_17}`]);
    expect(report.deletedBranches).toEqual([`[api] ${BRANCH_17}`]);
    expect(report.failures.some((failure) => failure.includes("protected branch"))).toBe(true);
  });

  it("keeps a branch when the integration base is not there to compare against", () => {
    const { deps, runner } = harness();
    branchAt(runner, BRANCH_17, "local");
    const plan = planReset(deps);
    expect(plan.branches[0]?.removable).toBe(false);
    expect(plan.branches[0]?.verdict).toContain("cannot tell whether the branch carries work");
  });

  it("keeps a branch when rev-list succeeds but prints nothing, rather than reading it as empty", () => {
    const { deps, runner } = harness();
    branchAt(runner, BRANCH_17, "local");
    runner.respond("rev-parse --verify --quiet origin/integration/toy-demo", "def456\n");
    runner.respond(`rev-list --count origin/integration/toy-demo..${BRANCH_17}`, "  \n");
    const plan = planReset(deps);
    expect(plan.branches[0]?.removable).toBe(false);
    applyReset(deps, plan);
    expect(runner.findAll("branch -D")).toHaveLength(0);
  });

  it("reports a repo it cannot see instead of dropping its branches off the plan", () => {
    const runner = new RecordingCommandRunner();
    const deps: ResetDeps = {
      runner,
      fs: fsWith({}),
      layout: testLayout(),
      model: MODEL,
      issues: [],
      hubRepo: "example-org/hub",
      isAlive: () => false,
      log: () => undefined,
    };
    const plan = planReset(deps);
    expect(plan.branches.map((branch) => branch.branch)).toEqual([BRANCH_17, BRANCH_18]);
    expect(plan.branches.every((branch) => !branch.removable)).toBe(true);
    expect(plan.branches[0]?.verdict).toContain("reset cannot see this repo's branches");
  });

  it("keeps a branch when git cannot count its commits", () => {
    const { deps, runner } = harness();
    branchAt(runner, BRANCH_17, "local");
    runner.respond("rev-parse --verify --quiet origin/integration/toy-demo", "def456\n");
    runner.fail(`rev-list --count origin/integration/toy-demo..${BRANCH_17}`, new CommandFailure("git", ["rev-list"], 128, "", "bad revision"));
    expect(planReset(deps).branches[0]).toMatchObject({ removable: false, verdict: "git could not count its commits, keeping it" });
  });

  it("reports a branch that exists nowhere without trying to delete it", () => {
    const { deps, runner } = harness();
    const plan = planReset(deps);
    expect(plan.branches.every((branch) => !branch.removable)).toBe(true);
    applyReset(deps, plan);
    expect(runner.findAll("branch -D")).toHaveLength(0);
  });

  it("deletes branches only after garbage collection has released their worktrees", () => {
    const { deps, runner } = harness();
    branchAt(runner, BRANCH_17, "local");
    runner.respond("rev-parse --verify --quiet origin/integration/toy-demo", "def456\n");
    runner.respond(`rev-list --count origin/integration/toy-demo..${BRANCH_17}`, "0\n");
    runner.respond(
      "worktree list",
      [`worktree ${MANAGED_WORKTREE.replace(/\\/g, "/")}`, "HEAD def", ""].join("\n"),
    );
    applyReset(deps, planReset(deps));
    const removedWorktree = runner.lines.findIndex((line) => line.includes("worktree remove --force"));
    const deletedBranch = runner.lines.findIndex((line) => line.includes("branch -D"));
    expect(removedWorktree).toBeGreaterThan(-1);
    expect(deletedBranch).toBeGreaterThan(removedWorktree);
  });
});

describe("reset — dry run", () => {
  it("plans without deleting anything", () => {
    const { deps, runner, fs } = harness({
      lock: JSON.stringify({ pid: 4242, startedAt: "2026-08-15T00:00:00.000Z" }),
      issues: [issue({ number: 17, labels: ["sc:needs-human", "ready-for-human"] })],
    });
    branchAt(runner, BRANCH_17, "local");
    runner.respond("rev-parse --verify --quiet origin/integration/toy-demo", "def456\n");
    runner.respond(`rev-list --count origin/integration/toy-demo..${BRANCH_17}`, "0\n");
    runner.respond("--filter name=sc-demo-", "sc-demo-develop-17-a");

    const plan = planReset(deps);
    expect(plan.orphans.containers).toEqual(["sc-demo-develop-17-a"]);
    expect(plan.branches[0]?.removable).toBe(true);
    expect(plan.labels).toHaveLength(1);
    expect(fs.exists(LOCK)).toBe(true);
    expect(runner.findAll(/docker rm|branch -D|push origin --delete|issue edit|worktree remove/)).toHaveLength(0);
  });
});
