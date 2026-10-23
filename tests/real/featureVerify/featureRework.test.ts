import { describe, expect, it } from "vitest";
import {
  featureReworkSection,
  FEATURE_PARKED_SENTINEL,
  type FeatureFixBrief,
  type FeatureRound,
} from "../../../src/real/featureVerify/featureBrief.js";
import {
  runFeatureFix,
  runFeatureVerifyLoop,
  type FeatureFixResult,
  type FeatureLoopGh,
} from "../../../src/real/featureVerify/featureRework.js";
import { idleFeatureVerify, type FeatureVerifyRun, type FeatureVerifyStatus } from "../../../src/real/featureVerify/runFeatureVerify.js";
import type { IntegrationHarness, IntegrationWorkspace } from "../../../src/real/integrationHarness.js";
import type { TargetRepo } from "../../../src/model/runModel.js";
import { testRunModel, testWorkItem } from "../support.js";

const MODEL = testRunModel([testWorkItem({ number: 17, repo: "api" }), testWorkItem({ number: 18, repo: "web" })]);
const COUNTS = { pass: 1, fail: 1, requiresStg: 0 };

class FakeGh implements FeatureLoopGh {
  readonly comments: string[] = [];
  readonly labels: string[] = [];
  history: string[] = [];

  issueComments(): string[] {
    return this.history;
  }

  comment(_: number, body: string): void {
    this.comments.push(body);
  }

  addLabel(_: number, label: string): void {
    this.labels.push(label);
  }

  removeLabel(): void {}
}

function fixing(round: FeatureRound): FeatureVerifyRun {
  return { phase: "fixing", counts: COUNTS, reason: "1 scenario(s) FAILED", pullRequests: [], rework: round, story: `story ${round.round}` };
}

function green(): FeatureVerifyRun {
  return { phase: "green", counts: { pass: 2, fail: 0, requiresStg: 0 }, reason: undefined, pullRequests: ["https://x/1"] };
}

const PUSHED: FeatureFixResult[] = [{ repo: "api", outcome: { kind: "pushed", checks: "npm test", subjects: ["fix: lead import"] } }];
const NOTHING: FeatureFixResult[] = [{ repo: "api", outcome: { kind: "unchanged" } }];

function boot(verdicts: FeatureVerifyRun[], fixes: FeatureFixResult[][] = [PUSHED, PUSHED, PUSHED]) {
  const gh = new FakeGh();
  const rounds: FeatureRound[] = [];
  const fixCalls: { briefs: FeatureFixBrief[]; round: FeatureRound }[] = [];
  const statuses: FeatureVerifyStatus[] = [];
  const run = () =>
    runFeatureVerifyLoop({
      gh,
      model: MODEL,
      limit: 3,
      verify: async (round) => {
        rounds.push(round);
        return verdicts.shift() ?? green();
      },
      fix: async (briefs, round) => {
        fixCalls.push({ briefs: briefs.map((brief) => ({ ...brief })), round });
        return fixes.shift() ?? PUSHED;
      },
      onStatus: (status) => statuses.push(status),
      log: () => undefined,
      warn: () => undefined,
    });
  return { gh, rounds, fixCalls, statuses, run };
}

describe("runFeatureVerifyLoop", () => {
  it("returns a first-pass green untouched", async () => {
    const { fixCalls, run } = boot([green()]);
    expect((await run()).phase).toBe("green");
    expect(fixCalls).toEqual([]);
  });

  it("fixes, re-verifies and stops on green", async () => {
    const { rounds, fixCalls, gh, statuses, run } = boot([fixing({ round: 1, limit: 3 }), green()]);
    const status = await run();

    expect(status.phase).toBe("green");
    expect(rounds).toEqual([{ round: 1, limit: 3 }, { round: 2, limit: 3 }]);
    expect(fixCalls).toHaveLength(1);
    expect(gh.comments[0]).toContain("<!-- sandcastle:feature-fix=1 -->");
    expect(gh.comments[0]).toContain("pushed 1 commit(s)");
    expect(statuses.map((entry) => entry.phase)).toEqual(["running", "fixing", "running"]);
    expect(statuses[2]?.rework).toEqual({ round: 1, limit: 3 });
  });

  it("hands every fix agent all briefs so far, each with what its round did", async () => {
    const { fixCalls, run } = boot([fixing({ round: 1, limit: 3 }), fixing({ round: 2, limit: 3 }), green()]);
    await run();
    expect(fixCalls[1]?.briefs.map((brief) => brief.round)).toEqual([1, 2]);
    expect(fixCalls[1]?.briefs[0]?.fix).toContain("fix: lead import");
    expect(fixCalls[1]?.briefs[1]?.story).toBe("story 2");
  });

  it("ends with whatever verify decides once the rounds are used up", async () => {
    const red: FeatureVerifyRun = { phase: "red", counts: COUNTS, reason: "1 scenario(s) FAILED", pullRequests: [] };
    const { rounds, run } = boot([fixing({ round: 1, limit: 3 }), fixing({ round: 2, limit: 3 }), fixing({ round: 3, limit: 3 }), red]);
    expect((await run()).phase).toBe("red");
    expect(rounds.at(-1)).toEqual({ round: 4, limit: 3 });
  });

  it("parks when a fix round lands nothing, since re-verifying would test the same code", async () => {
    const { gh, rounds, run } = boot([fixing({ round: 1, limit: 3 })], [NOTHING]);
    const status = await run();
    expect(status.phase).toBe("red");
    expect(status.reason).toContain("landed nothing");
    expect(rounds).toHaveLength(1);
    expect(gh.labels).toEqual(["sc:needs-human", "ready-for-human"]);
    expect(gh.comments[0]).toContain(FEATURE_PARKED_SENTINEL);
    expect(status.rework).toEqual({ round: 2, limit: 3 });
  });

  it("parks instead of restarting the round count when earlier rounds cannot be read", async () => {
    const { gh, rounds, run } = boot([green()]);
    gh.issueComments = () => {
      throw new Error("gh timed out");
    };
    const status = await run();
    expect(status.phase).toBe("red");
    expect(status.reason).toContain("gh timed out");
    expect(rounds).toEqual([]);
    expect(gh.labels).toEqual(["sc:needs-human", "ready-for-human"]);
  });

  it("continues the round count from the parent's comments after a restart", async () => {
    const { gh, rounds, run } = boot([green()]);
    gh.history = [featureReworkSection({ round: 1, limit: 3 }, "earlier story")];
    await run();
    expect(rounds).toEqual([{ round: 2, limit: 3 }]);
  });

});

class FakeHarness implements IntegrationHarness {
  readonly prompts = new Map<TargetRepo, string>();

  checkout(repo: TargetRepo): IntegrationWorkspace {
    return { repo, worktree: `W:/${repo}`, baseline: "base", checks: `npm test --prefix ${repo}` };
  }

  async runAgent(workspace: IntegrationWorkspace, prompt: string): Promise<void> {
    this.prompts.set(workspace.repo, prompt);
  }

  commitsSince(workspace: IntegrationWorkspace): string[] {
    return workspace.repo === "api" ? ["test: lead import 500", "fix: lead import"] : [];
  }

  takeFile(): string | undefined {
    return undefined;
  }

  discardUncommitted(): string[] {
    return [];
  }

  async runChecks(): Promise<void> {}

  push(): void {}

  release(): void {}
}

describe("runFeatureFix", () => {
  it("runs one fix agent per involved repo with every brief, and reports what each landed", async () => {
    const harness = new FakeHarness();
    const briefs: FeatureFixBrief[] = [{ round: 1, story: "the lead import story", fix: undefined }];
    const results = await runFeatureFix({ harness, model: MODEL, hubRepo: "example-org/hub", briefs, round: { round: 1, limit: 3 }, warn: () => undefined });

    expect(results.map((result) => [result.repo, result.outcome.kind])).toEqual([
      ["api", "pushed"],
      ["web", "unchanged"],
    ]);
    const prompt = harness.prompts.get("api") ?? "";
    expect(prompt).toContain("the lead import story");
    expect(prompt).toContain("CURRENT");
    expect(prompt).toContain("`web`");
    expect(prompt).toContain("npm test --prefix api");
    expect(prompt).toContain("test: <what it proves>");
  });
});

describe("idle status", () => {
  it("carries no fix round before the loop starts", () => {
    expect(idleFeatureVerify().rework).toBeUndefined();
  });
});
