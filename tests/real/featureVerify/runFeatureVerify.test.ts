import { describe, expect, it } from "vitest";
import type { TargetRepo } from "../../../src/model/runModel.js";
import type { ComposeFacts, VerifyHarness } from "../../../src/real/featureVerify/composeHarness.js";
import { runFeatureVerify, type FeatureVerifyGh } from "../../../src/real/featureVerify/runFeatureVerify.js";
import { FEATURE_PARKED_SENTINEL, type FeatureRound } from "../../../src/real/featureVerify/featureBrief.js";
import { PR_BODY_REPORT_LIMIT } from "../../../src/real/featureVerify/verdict.js";
import type { CreateDraftPrInput, PullRequestRef } from "../../../src/real/ghClient.js";
import { testRunModel, testWorkItem } from "../support.js";

const FACTS: ComposeFacts = {
  network: "sc-demo-net-16-a",
  environment: "throwaway docker network — a fresh `mongo` container plus api and web; no hosted database was reachable from it",
  mongoUri: "mongodb://mongo:27017/sandcastle_verify_toy_demo",
  reportPath: "/home/agent/workspace/report.md",
  services: [
    { repo: "api", ref: "origin/integration/toy-demo", baseUrl: "http://api:5000", sourcePath: "/home/agent/sources/api" },
    { repo: "web", ref: "origin/integration/toy-demo", baseUrl: "http://web:4173", sourcePath: "/home/agent/sources/web" },
  ],
};

const GREEN_REPORT = [
  "## Test plan",
  "- login works — covers #17",
  "",
  "## Results",
  "- PASS — login works — 200 with a token",
  "- REQUIRES-STG — sms send — the SMS gateway is not reachable here",
].join("\n");

class FakeHarness implements VerifyHarness {
  report: string | undefined = GREEN_REPORT;
  upFailure: Error | undefined;
  agentFailure: Error | undefined;
  prompts: string[] = [];
  downCalls = 0;

  async up(): Promise<ComposeFacts> {
    if (this.upFailure) throw this.upFailure;
    return FACTS;
  }

  async runAgent(prompt: string): Promise<void> {
    this.prompts.push(prompt);
    if (this.agentFailure) throw this.agentFailure;
  }

  readReport(): string | undefined {
    return this.report;
  }

  down(): void {
    this.downCalls += 1;
  }
}

class FakeGh implements FeatureVerifyGh {
  readonly comments: { itemNumber: number; body: string }[] = [];
  readonly labels: { itemNumber: number; label: string }[] = [];
  readonly removedLabels: { itemNumber: number; label: string }[] = [];
  readonly lookups: { repo: TargetRepo; branch: string; baseBranch: string | undefined }[] = [];
  readonly created: CreateDraftPrInput[] = [];
  existing = new Map<TargetRepo, PullRequestRef>();
  createFailure: Error | undefined;

  comment(itemNumber: number, body: string): void {
    this.comments.push({ itemNumber, body });
  }

  addLabel(itemNumber: number, label: string): void {
    this.labels.push({ itemNumber, label });
  }

  removeLabel(itemNumber: number, label: string): void {
    this.removedLabels.push({ itemNumber, label });
  }

  findPullRequest(repo: TargetRepo, branch: string, baseBranch?: string): PullRequestRef | undefined {
    this.lookups.push({ repo, branch, baseBranch });
    return this.existing.get(repo);
  }

  createPullRequest(input: CreateDraftPrInput): PullRequestRef {
    if (this.createFailure) throw this.createFailure;
    this.created.push(input);
    return {
      number: 100 + this.created.length,
      url: `https://github.com/example-org/${input.repo}/pull/${100 + this.created.length}`,
      state: "OPEN",
      isDraft: false,
      body: input.body,
      title: input.title,
    };
  }
}

function harness(options: { repos?: TargetRepo[]; rework?: FeatureRound } = {}) {
  const repos = options.repos ?? ["api", "web"];
  const model = testRunModel(
    repos.map((repo, index) => testWorkItem({ number: 17 + index, repo, title: `toy: ${repo} slice` })),
  );
  const verifyHarness = new FakeHarness();
  const gh = new FakeGh();
  const logs: string[] = [];
  const warnings: string[] = [];
  return {
    harness: verifyHarness,
    gh,
    logs,
    warnings,
    run: () =>
      runFeatureVerify({
        harness: verifyHarness,
        gh,
        model,
        hubRepo: "example-org/hub",
        rework: options.rework,
        log: (message) => logs.push(message),
        warn: (itemNumber, message) => warnings.push(`#${itemNumber} ${message}`),
      }),
  };
}

describe("green path", () => {
  it("posts the report on the parent and opens one integration → dev pull request per involved repo", async () => {
    const { gh, run } = harness();
    const status = await run();

    expect(status.phase).toBe("green");
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0]?.itemNumber).toBe(16);
    expect(gh.comments[0]?.body).toContain("Feature Verify: GREEN");
    expect(gh.comments[0]?.body).toContain("- PASS — login works");
    expect(gh.created.map((input) => input.repo)).toEqual(["api", "web"]);
    expect(gh.created.every((input) => input.baseBranch === "dev")).toBe(true);
    expect(gh.created.every((input) => input.branch === "integration/toy-demo")).toBe(true);
    expect(gh.created.every((input) => input.title === "feat: toy-demo")).toBe(true);
    expect(status.pullRequests).toHaveLength(2);
  });

  it("opens no pull request in a repo the run never touched", async () => {
    const { gh, run } = harness({ repos: ["api"] });
    await run();
    expect(gh.created.map((input) => input.repo)).toEqual(["api"]);
  });

  it("puts the requires-STG checklist and the human-merges note in the pull request body", async () => {
    const { gh, run } = harness();
    await run();

    const body = gh.created[0]?.body ?? "";
    expect(body).toContain("- [ ] REQUIRES-STG — sms send");
    expect(body).toContain("A human merges this pull request");
    expect(body).toContain("https://github.com/example-org/hub/issues/16");
  });

  it("carries the report itself into the pull request body, not just the counts", async () => {
    const { gh, run } = harness();
    await run();

    const body = gh.created[0]?.body ?? "";
    expect(body).toContain("- PASS — login works — 200 with a token");
    expect(body).toContain("## Results");
  });

  it("bounds the report it pastes into a pull request body", async () => {
    const { harness: verifyHarness, gh, run } = harness({ repos: ["api"] });
    verifyHarness.report = `- PASS — login works\n${"x".repeat(PR_BODY_REPORT_LIMIT + 500)}`;
    await run();

    const body = gh.created[0]?.body ?? "";
    expect(body).toContain("report truncated");
    expect(body.length).toBeLessThan(PR_BODY_REPORT_LIMIT + 2000);
  });

  it("says which ref each service was actually built from, on the parent and on the pull request", async () => {
    const { gh, run } = harness({ repos: ["api"] });
    await run();

    expect(gh.comments[0]?.body).toContain("`api` — built from `origin/integration/toy-demo`");
    expect(gh.created[0]?.body).toContain("`web` — built from `origin/integration/toy-demo`");
  });

  it("never labels the parent for a human when the feature is green", async () => {
    const { gh, run } = harness();
    await run();
    expect(gh.labels).toEqual([]);
  });

  it("clears a stale park from an earlier red run when the feature comes back green", async () => {
    const { gh, run } = harness({ repos: ["api"] });
    await run();
    expect(gh.removedLabels).toEqual([
      { itemNumber: 16, label: "sc:needs-human" },
      { itemNumber: 16, label: "ready-for-human" },
    ]);
  });

  it("reuses a pull request that is already open against dev instead of opening a second one", async () => {
    const { gh, run } = harness({ repos: ["api"] });
    gh.existing.set("api", {
      number: 7,
      url: "https://github.com/example-org/api/pull/7",
      state: "OPEN",
      isDraft: false,
      body: "",
      title: "feat: toy-demo",
    });
    const status = await run();

    expect(gh.created).toEqual([]);
    expect(status.pullRequests).toEqual(["https://github.com/example-org/api/pull/7"]);
  });

  it("looks a reusable pull request up by head and base, so a wrong-base one cannot be adopted", async () => {
    const { gh, run } = harness({ repos: ["api"] });
    await run();
    expect(gh.lookups[0]).toEqual({ repo: "api", branch: "integration/toy-demo", baseBranch: "dev" });
  });

  it("reports the failure on the parent when one repo's pull request cannot be opened", async () => {
    const { gh, warnings, run } = harness({ repos: ["api"] });
    gh.createFailure = new Error("No commits between dev and integration/toy-demo");
    const status = await run();

    expect(status.phase).toBe("green");
    expect(status.pullRequests).toEqual([]);
    expect(gh.comments[0]?.body).toContain("No commits between dev");
    expect(warnings.join("\n")).toContain("could not open integration/toy-demo → dev");
  });
});

describe("red path", () => {
  it("opens no pull request, posts the report and parks the parent with the engine's park labels", async () => {
    const { harness: verifyHarness, gh, run } = harness();
    verifyHarness.report = `${GREEN_REPORT}\n- FAIL — lead import — 500 on POST /api/leads`;
    const status = await run();

    expect(status.phase).toBe("red");
    expect(gh.created).toEqual([]);
    expect(gh.comments[0]?.body).toContain("Feature Verify: RED");
    expect(gh.labels).toEqual([
      { itemNumber: 16, label: "sc:needs-human" },
      { itemNumber: 16, label: "ready-for-human" },
    ]);
    expect(gh.removedLabels).toEqual([]);
  });

  it("is red when nothing passed, however many scenarios were deferred to staging", async () => {
    const { harness: verifyHarness, gh, run } = harness();
    verifyHarness.report = "- REQUIRES-STG — sms send\n- REQUIRES-STG — payment renewal";
    const status = await run();

    expect(status.phase).toBe("red");
    expect(status.reason).toContain("no automated scenario passed");
    expect(gh.created).toEqual([]);
  });

  it("says the environment never came up rather than naming refs it never built", async () => {
    const { harness: verifyHarness, gh, run } = harness();
    verifyHarness.upFailure = new Error("web has work items in this run but no integration/toy-demo on origin");
    verifyHarness.report = undefined;
    await run();

    expect(gh.comments[0]?.body).toContain("the environment never came up");
    expect(gh.comments[0]?.body).toContain("no integration/toy-demo on origin");
  });

  it("never touches a per-item label when it parks the run", async () => {
    const { harness: verifyHarness, gh, run } = harness();
    verifyHarness.report = "- FAIL — everything";
    await run();
    expect(gh.labels.every((entry) => entry.itemNumber === 16)).toBe(true);
  });

  it("is red when the environment never came up, and says why", async () => {
    const { harness: verifyHarness, gh, run } = harness();
    verifyHarness.upFailure = new Error("mongo never answered a ping");
    verifyHarness.report = undefined;
    const status = await run();

    expect(status.phase).toBe("red");
    expect(status.reason).toContain("mongo never answered");
    expect(gh.comments[0]?.body).toContain("mongo never answered");
    expect(gh.created).toEqual([]);
  });

  it("is red when the agent died mid-run even if it left a half-written green report", async () => {
    const { harness: verifyHarness, run } = harness();
    verifyHarness.agentFailure = new Error("agent produced no output for 600s — killed");
    const status = await run();

    expect(status.phase).toBe("red");
    expect(status.reason).toContain("no output for 600s");
  });
});

describe("fix rounds", () => {
  const FAILING = `${GREEN_REPORT}\n- FAIL — lead import — 500 on POST /api/leads`;

  it("sends a report with FAIL scenarios back for a fix round instead of parking", async () => {
    const { harness: verifyHarness, gh, run } = harness({ rework: { round: 1, limit: 3 } });
    verifyHarness.report = FAILING;
    const status = await run();

    expect(status.phase).toBe("fixing");
    expect(status.rework).toEqual({ round: 1, limit: 3 });
    expect(status.story).toContain("- FAIL — lead import");
    expect(gh.labels).toEqual([]);
    expect(gh.created).toEqual([]);
    expect(gh.comments[0]?.body).toContain("<!-- sandcastle:feature-rework=1 -->");
    expect(gh.comments[0]?.body).toContain("fix round 1/3");
    expect(gh.comments[0]?.body).not.toContain(FEATURE_PARKED_SENTINEL);
  });

  it("parks once the rounds are used up and says how many ran", async () => {
    const { harness: verifyHarness, gh, run } = harness({ rework: { round: 4, limit: 3 } });
    verifyHarness.report = FAILING;
    const status = await run();

    expect(status.phase).toBe("red");
    expect(gh.labels.map((entry) => entry.label)).toEqual(["sc:needs-human", "ready-for-human"]);
    expect(gh.comments[0]?.body).toContain("after 3 fix round(s)");
    expect(gh.comments[0]?.body).toContain(FEATURE_PARKED_SENTINEL);
  });

  it("never sends REQUIRES-STG-only or nothing-passed reports to a fix round", async () => {
    const { harness: verifyHarness, gh, run } = harness({ rework: { round: 1, limit: 3 } });
    verifyHarness.report = "- REQUIRES-STG — sms send";
    const status = await run();

    expect(status.phase).toBe("red");
    expect(gh.labels).toHaveLength(2);
    expect(gh.comments[0]?.body).toContain("nothing to send to a fix round");
  });

  it("parks a broken environment rather than asking an agent to fix it", async () => {
    const { harness: verifyHarness, run } = harness({ rework: { round: 1, limit: 3 } });
    verifyHarness.upFailure = new Error("mongo never answered a ping");
    verifyHarness.report = FAILING;
    expect((await run()).phase).toBe("red");
  });
});

describe("teardown and prompt", () => {
  it("tears the environment down on the green path", async () => {
    const { harness: verifyHarness, run } = harness();
    await run();
    expect(verifyHarness.downCalls).toBe(1);
  });

  it("tears the environment down when compose failed", async () => {
    const { harness: verifyHarness, run } = harness();
    verifyHarness.upFailure = new Error("boom");
    await run();
    expect(verifyHarness.downCalls).toBe(1);
  });

  it("tears the environment down when the agent failed", async () => {
    const { harness: verifyHarness, run } = harness();
    verifyHarness.agentFailure = new Error("boom");
    await run();
    expect(verifyHarness.downCalls).toBe(1);
  });

  it("feeds the agent the parent spec, every sub-issue and the live service urls", async () => {
    const { harness: verifyHarness, run } = harness();
    await run();

    const prompt = verifyHarness.prompts[0] ?? "";
    expect(prompt).toContain("example-org/hub#16");
    expect(prompt).toContain("example-org/hub#17");
    expect(prompt).toContain("example-org/hub#18");
    expect(prompt).toContain("http://api:5000");
    expect(prompt).toContain("http://web:4173");
    expect(prompt).toContain("/home/agent/workspace/report.md");
  });
});
