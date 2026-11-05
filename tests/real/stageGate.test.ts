import { describe, expect, it } from "vitest";
import { type SpawnRequest, type VerifyRequest } from "../../src/engine/adapters.js";
import { CommandFailure } from "../../src/real/commandRunner.js";
import { RecordingCommandRunner } from "../../src/real/fakeCommandRunner.js";
import type { CreateDraftPrInput, PullRequestOps, PullRequestRef } from "../../src/real/ghClient.js";
import type { TargetRepo } from "../../src/model/runModel.js";
import { RunContext } from "../../src/real/runContext.js";
import { DockerSandboxRunner } from "../../src/real/sandboxRunner.js";
import type { OrchestratorConfig } from "../../src/real/env.js";
import type { StageCompletion } from "../../src/engine/adapters.js";
import { fsWith, repoDir, testConfig, testLayout, testRunModel, worktreeDir } from "./support.js";

const INTEGRATION = "integration/toy-demo";
const BRANCH = "feat/17-toy-slice";
const SANITIZED = "feat-17-toy-slice";
const API = repoDir("api");
const WORKTREE = worktreeDir("api", SANITIZED);
const HOST_GIT_DIR = `${API}\\.git\\worktrees\\${SANITIZED}`;
const SPAWN: SpawnRequest = { itemNumber: 17, stage: "develop", repo: "api", branch: BRANCH, integrationBranch: INTEGRATION };
const VERIFY: VerifyRequest = { itemNumber: 17, repo: "api", branch: BRANCH, integrationBranch: INTEGRATION };

class NoGh implements PullRequestOps {
  findPullRequest(): PullRequestRef | undefined {
    return { number: 42, url: "https://github.com/example-org/api/pull/42", state: "OPEN", isDraft: true, body: "", title: "feat: toy slice" };
  }
  createDraftPullRequest(_input: CreateDraftPrInput): PullRequestRef {
    throw new Error("not expected");
  }
  appendToPullRequestBody(_repo: TargetRepo): void {
    return;
  }
}

function harness(config: Partial<OrchestratorConfig>, stageCommits: string[] = ["feat: toy slice"]) {
  const runner = new RecordingCommandRunner();
  runner.respond("docker images", "sha256:abc");
  runner.respond("rev-parse --absolute-git-dir", `${HOST_GIT_DIR}\n`);
  runner.respond("--format=%s", stageCommits.join("\n"));
  runner.respond("git log", "sha0");
  const warnings: string[] = [];
  let finish: (completion: StageCompletion) => void = () => undefined;
  const completion = new Promise<StageCompletion>((resolve) => {
    finish = resolve;
  });
  const sandbox = new DockerSandboxRunner({
    runner,
    fs: fsWith({}, [API, WORKTREE]),
    layout: testLayout(),
    config: testConfig(config),
    gh: new NoGh(),
    context: new RunContext(testRunModel(), { loadMemories: () => [], hubRepo: "example-org/hub" }),
    log: () => undefined,
    warn: (itemNumber, message) => warnings.push(`#${itemNumber} ${message}`),
    onComplete: finish,
    now: () => 1_700_000_000_000,
  });
  return { runner, sandbox, completion, warnings };
}

const GATE = { api: { develop: ["echo gate-a", "echo gate-b"] } };
const indexOf = (lines: readonly string[], text: string): number => lines.findIndex((line) => line.includes(text));
const red = (output: string) => new CommandFailure("docker", ["exec"], 1, output, "exit 1");

describe("stage checks gate", () => {
  it("runs nothing extra for a stage without a list, so existing configs behave as before", async () => {
    const { runner, sandbox, completion } = harness({ stageChecks: { api: { review: ["echo only-review"] } } });
    sandbox.spawnStage(SPAWN);
    await completion;
    expect(runner.find("echo only-review")).toBeUndefined();
    expect(runner.find("pre-push")).toBeUndefined();
  });

  it("runs the stage's commands in order, in a clean copy, after the agent", async () => {
    const { runner, sandbox, completion } = harness({ stageChecks: GATE });
    sandbox.spawnStage(SPAWN);
    expect((await completion).outcome).toBe("success");
    const lines = runner.lines;
    const agent = indexOf(lines, "claude -p");
    const first = indexOf(lines, "echo gate-a");
    const second = indexOf(lines, "echo gate-b");
    expect(agent).toBeGreaterThan(-1);
    expect(first).toBeGreaterThan(agent);
    expect(second).toBeGreaterThan(first);
    expect(runner.findAll("docker run").some((call) => call.line.includes("/home/agent/source:ro"))).toBe(true);
    expect(runner.find("claude -p")?.input).toContain("Stage checks");
  });

  it("installs a pre-push hook for the agent in github mode, none with the local tracker", async () => {
    const github = harness({ stageChecks: GATE });
    github.sandbox.spawnStage(SPAWN);
    await github.completion;
    expect(github.runner.find("sandcastle-hooks/pre-push")?.line).toContain("exec -u root");
    const local = harness({ tracker: "local", stageChecks: GATE });
    local.sandbox.spawnStage(SPAWN);
    await local.completion;
    expect(local.runner.find("sandcastle-hooks/pre-push")).toBeUndefined();
  });

  it("stops at the first red command and never runs the ones after it", async () => {
    const { runner, sandbox, completion } = harness({ stageChecks: GATE, stageCheckFixLimit: 0 });
    runner.fail("echo gate-a", red("lint: boom\n"));
    sandbox.spawnStage(SPAWN);
    const result = await completion;
    expect(result.outcome).toBe("failure");
    expect(result.detail).toContain("lint: boom");
    expect(runner.find("echo gate-b")).toBeUndefined();
  });

  it("feeds the failure output to a fix pass, then re-runs the list and succeeds when it is green", async () => {
    const { runner, sandbox, completion, warnings } = harness({ stageChecks: GATE, stageCheckFixLimit: 2 });
    runner.fail("echo gate-a", red("src/a.ts(3,7): error TS2345: nope\n"), 1);
    sandbox.spawnStage(SPAWN);
    expect((await completion).outcome).toBe("success");
    const agents = runner.findAll(/claude -p/);
    expect(agents).toHaveLength(2);
    expect(agents[1]?.input).toContain("Stage-check fix pass 1/2");
    expect(agents[1]?.input).toContain("error TS2345: nope");
    expect(runner.findAll("echo gate-a")).toHaveLength(2);
    expect(runner.find("echo gate-b")).toBeDefined();
    expect(warnings.join("\n")).toMatch(/fix pass 1\/2/);
  });

  it("gives up after the fix limit: develop fails outright", async () => {
    const { runner, sandbox, completion } = harness({ stageChecks: GATE, stageCheckFixLimit: 1 });
    runner.fail("echo gate-a", red("red\n"));
    sandbox.spawnStage(SPAWN);
    const result = await completion;
    expect(result.outcome).toBe("failure");
    expect(result.rework).toBeUndefined();
    expect(runner.findAll(/claude -p/)).toHaveLength(2);
  });

  it("sends the item back to develop when a later stage stays red", async () => {
    const { runner, sandbox, completion } = harness({ stageChecks: { api: { review: ["echo gate-a"] } }, stageCheckFixLimit: 0 });
    runner.fail("echo gate-a", red("red\n"));
    sandbox.spawnStage({ ...SPAWN, stage: "review" });
    const result = await completion;
    expect(result.outcome).toBe("failure");
    expect(result.rework?.source).toBe("review");
    expect(result.rework?.story).toContain("red");
  });

  it("gates the merge on the verify list when one is set, and on the repo default checks when not", async () => {
    const listed = harness({ stageChecks: { api: { verify: ["echo v1", "echo v2"] } } });
    listed.sandbox.runChecks(VERIFY);
    await listed.completion;
    expect(indexOf(listed.runner.lines, "echo v2")).toBeGreaterThan(indexOf(listed.runner.lines, "echo v1"));
    expect(listed.runner.find("tsc -p tsconfig.ci.json")).toBeUndefined();

    const fallback = harness({});
    fallback.sandbox.runChecks(VERIFY);
    await fallback.completion;
    expect(fallback.runner.find("tsc -p tsconfig.ci.json")).toBeDefined();
  });
});
