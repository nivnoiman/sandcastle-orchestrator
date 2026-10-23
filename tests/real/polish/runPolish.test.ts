import { describe, expect, it } from "vitest";
import type { TargetRepo } from "../../../src/model/runModel.js";
import type { PullRequestRef } from "../../../src/real/ghClient.js";
import type { IntegrationHarness, IntegrationWorkspace } from "../../../src/real/integrationHarness.js";
import { POLISH_SENTINEL, runPolish, type PolishGh } from "../../../src/real/polish/runPolish.js";
import { CheckFailure } from "../../../src/real/sandboxRunner.js";
import { testRunModel, testWorkItem } from "../support.js";

const MODEL = testRunModel([testWorkItem({ number: 17, repo: "api" }), testWorkItem({ number: 18, repo: "web" })]);

function pullRequest(repo: TargetRepo, body = "## What changed\nthe feature"): PullRequestRef {
  const number = repo === "api" ? 801 : 401;
  return { number, url: `https://github.com/example-org/${repo}/pull/${number}`, state: "OPEN", isDraft: false, body, title: "feat: toy-demo" };
}

class FakeHarness implements IntegrationHarness {
  readonly prompts: { repo: TargetRepo; prompt: string }[] = [];
  readonly pushed: TargetRepo[] = [];
  readonly released: TargetRepo[] = [];
  readonly checked: TargetRepo[] = [];
  readonly discarded: TargetRepo[] = [];
  leftovers = new Map<TargetRepo, string[]>();
  commits = new Map<TargetRepo, string[]>([
    ["api", ["refactor: simplify toy-demo", "chore: remove comments"]],
    ["web", []],
  ]);
  notes = new Map<TargetRepo, string>();
  agentFailure = new Map<TargetRepo, Error>();
  checkFailure = new Map<TargetRepo, Error>();
  pushFailure = new Map<TargetRepo, Error>();

  checkout(repo: TargetRepo): IntegrationWorkspace {
    return { repo, worktree: `W:/worktrees/${repo}/integration-toy-demo`, baseline: `base-${repo}`, checks: `npm test --prefix ${repo}` };
  }

  async runAgent(workspace: IntegrationWorkspace, prompt: string): Promise<void> {
    this.prompts.push({ repo: workspace.repo, prompt });
    const failure = this.agentFailure.get(workspace.repo);
    if (failure) throw failure;
  }

  commitsSince(workspace: IntegrationWorkspace): string[] {
    return this.commits.get(workspace.repo) ?? [];
  }

  takeFile(workspace: IntegrationWorkspace): string | undefined {
    return this.notes.get(workspace.repo);
  }

  discardUncommitted(workspace: IntegrationWorkspace): string[] {
    this.discarded.push(workspace.repo);
    return this.leftovers.get(workspace.repo) ?? [];
  }

  async runChecks(workspace: IntegrationWorkspace): Promise<void> {
    if (!this.discarded.includes(workspace.repo)) throw new Error("checks ran on a tree with uncommitted leftovers");
    this.checked.push(workspace.repo);
    const failure = this.checkFailure.get(workspace.repo);
    if (failure) throw failure;
  }

  push(workspace: IntegrationWorkspace): void {
    const failure = this.pushFailure.get(workspace.repo);
    if (failure) throw failure;
    this.pushed.push(workspace.repo);
  }

  release(workspace: IntegrationWorkspace): void {
    this.released.push(workspace.repo);
  }
}

class FakeGh implements PolishGh {
  readonly open = new Map<TargetRepo, PullRequestRef>([
    ["api", pullRequest("api")],
    ["web", pullRequest("web")],
  ]);
  readonly appended: { repo: TargetRepo; number: number; addition: string }[] = [];
  readonly comments: { repo: TargetRepo; number: number; body: string }[] = [];
  readonly lookups: { repo: TargetRepo; branch: string; baseBranch: string | undefined }[] = [];
  appendFailures = 0;

  findPullRequest(repo: TargetRepo, branch: string, baseBranch?: string): PullRequestRef | undefined {
    this.lookups.push({ repo, branch, baseBranch });
    return this.open.get(repo);
  }

  appendToPullRequestBody(repo: TargetRepo, pr: PullRequestRef, addition: string): void {
    if (this.appendFailures > 0) {
      this.appendFailures -= 1;
      throw new Error("gh 502");
    }
    this.appended.push({ repo, number: pr.number, addition });
  }

  commentOnPullRequest(repo: TargetRepo, pr: PullRequestRef, body: string): void {
    this.comments.push({ repo, number: pr.number, body });
  }
}

function boot() {
  const harness = new FakeHarness();
  const gh = new FakeGh();
  const warnings: string[] = [];
  const deps = { harness, gh, model: MODEL, hubRepo: "example-org/hub", log: () => undefined, warn: (_: number, message: string) => warnings.push(message) };
  return { harness, gh, warnings, run: () => runPolish(deps) };
}

function sectionFor(gh: FakeGh, repo: TargetRepo): string {
  const entry = gh.appended.find((candidate) => candidate.repo === repo);
  if (!entry) throw new Error(`no polish section appended for ${repo}`);
  return entry.addition;
}

describe("runPolish", () => {
  it("looks up each involved repo's integration → dev pull request", async () => {
    const { gh, run } = boot();
    await run();
    expect(gh.lookups).toEqual(
      expect.arrayContaining([
        { repo: "api", branch: "integration/toy-demo", baseBranch: "dev" },
        { repo: "web", branch: "integration/toy-demo", baseBranch: "dev" },
      ]),
    );
  });

  it("runs one polish agent per pull request with the polish command and origin/dev as fixed point", async () => {
    const { harness, run } = boot();
    await run();
    expect(harness.prompts.map((entry) => entry.repo).sort()).toEqual(["api", "web"]);
    for (const { prompt } of harness.prompts) {
      expect(prompt).toContain("polish");
      expect(prompt).toContain("origin/dev");
    }
  });

  it("re-runs the checks and pushes when polish committed and the checks stay green", async () => {
    const { harness, gh, run } = boot();
    const status = await run();
    expect(harness.checked).toEqual(["api"]);
    expect(harness.pushed).toEqual(["api"]);
    expect(status.phase).toBe("green");
    expect(status.pullRequests).toEqual(expect.arrayContaining([pullRequest("api").url, pullRequest("web").url]));
    const section = sectionFor(gh, "api");
    expect(section).toContain(POLISH_SENTINEL);
    expect(section).toContain("## Polish");
    expect(section).toContain("refactor: simplify toy-demo");
    expect(section).toContain("npm test --prefix api");
  });

  it("records a no-change section and pushes nothing when polish committed nothing", async () => {
    const { harness, gh, run } = boot();
    await run();
    expect(harness.pushed).not.toContain("web");
    expect(harness.checked).not.toContain("web");
    expect(sectionFor(gh, "web")).toContain("nothing to change");
  });

  it("drops the polish commits, comments on the pull request and never parks when the checks go red", async () => {
    const { harness, gh, warnings, run } = boot();
    harness.checkFailure.set("api", new CheckFailure("npm test --prefix api", "FAIL toy.test.ts", new Error("exit 1")));
    const status = await run();
    expect(harness.pushed).toEqual([]);
    expect(status.phase).toBe("reverted");
    expect(status.reason).toContain("api");
    expect(sectionFor(gh, "api")).toContain("dropped");
    const comment = gh.comments.find((entry) => entry.repo === "api");
    expect(comment?.body).toContain("FAIL toy.test.ts");
    expect(warnings.some((message) => message.includes("polish"))).toBe(true);
  });

  it("drops whatever a crashed polish agent committed", async () => {
    const { harness, gh, run } = boot();
    harness.agentFailure.set("api", new Error("agent idle-timed out"));
    const status = await run();
    expect(harness.checked).toEqual([]);
    expect(harness.pushed).toEqual([]);
    expect(status.phase).toBe("reverted");
    expect(sectionFor(gh, "api")).toContain("agent idle-timed out");
  });

  it("treats a rejected push as reverted", async () => {
    const { harness, run } = boot();
    harness.pushFailure.set("api", new Error("non-fast-forward"));
    const status = await run();
    expect(status.phase).toBe("reverted");
    expect(status.reason).toContain("non-fast-forward");
  });

  it("discards uncommitted leftovers before the checks so they test exactly what gets pushed", async () => {
    const { harness, warnings, run } = boot();
    harness.leftovers.set("api", ["?? src/half-done.ts"]);
    const status = await run();
    expect(harness.checked).toEqual(["api"]);
    expect(status.phase).toBe("green");
    expect(warnings.some((message) => message.includes("src/half-done.ts"))).toBe(true);
  });

  it("retries a failed body write once so a resumed run does not polish twice", async () => {
    const { gh, warnings, run } = boot();
    gh.appendFailures = 1;
    await run();
    expect(gh.appended.map((entry) => entry.repo).sort()).toEqual(["api", "web"]);
    expect(warnings.some((message) => message.includes("could not be recorded"))).toBe(false);
  });

  it("warns that a re-run will polish again when the body write keeps failing", async () => {
    const { gh, warnings, run } = boot();
    gh.appendFailures = 10;
    await run();
    expect(warnings.some((message) => message.includes("polish it again"))).toBe(true);
  });

  it("puts the review's deferred list into the section", async () => {
    const { harness, gh, run } = boot();
    harness.notes.set("api", "- src/toy.ts:12 rename needs a behaviour change");
    await run();
    expect(sectionFor(gh, "api")).toContain("src/toy.ts:12 rename needs a behaviour change");
  });

  it("releases every workspace it checked out, even when one fails", async () => {
    const { harness, run } = boot();
    harness.checkFailure.set("api", new Error("boom"));
    await run();
    expect(harness.released.sort()).toEqual(["api", "web"]);
  });

  it("skips a pull request that already carries the polish section", async () => {
    const { harness, gh, run } = boot();
    gh.open.set("api", pullRequest("api", `body\n${POLISH_SENTINEL}\n## Polish\ndone`));
    gh.open.delete("web");
    const status = await run();
    expect(harness.prompts).toEqual([]);
    expect(gh.appended).toEqual([]);
    expect(status.phase).toBe("skipped");
  });

  it("is skipped when no integration → dev pull request is open", async () => {
    const { harness, gh, run } = boot();
    gh.open.clear();
    const status = await run();
    expect(harness.prompts).toEqual([]);
    expect(status.phase).toBe("skipped");
    expect(status.reason).toContain("no integration");
  });
});
