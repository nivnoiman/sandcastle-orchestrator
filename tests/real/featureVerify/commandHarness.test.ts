import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CommandFailure } from "../../../src/real/commandRunner.js";
import { RecordingCommandRunner } from "../../../src/real/fakeCommandRunner.js";
import { CommandVerifyHarness, NoVerifyHarness } from "../../../src/real/featureVerify/commandHarness.js";
import { REPORT_FILE } from "../../../src/real/featureVerify/composeHarness.js";
import { readVerdict } from "../../../src/real/featureVerify/verdict.js";
import { createVerifyHarness } from "../../../src/real/featureVerify/verifyStrategy.js";
import type { OrchestratorConfig } from "../../../src/real/env.js";
import { fsWith, SANDCASTLE_DIR, testConfig, testLayout } from "../support.js";
import { FakeWorktrees, verifyWorktree } from "./support.js";

const SANDBOX_ENV = join(SANDCASTLE_DIR, ".env.sandbox");

function commandConfig(agent = true): OrchestratorConfig {
  return testConfig({ verify: { strategy: "command", commands: { api: "npm run verify" }, agent } });
}

function harness(config = commandConfig()) {
  const runner = new RecordingCommandRunner();
  const fs = fsWith({ [SANDBOX_ENV]: "NODE_ENV=development\n" });
  const git = new FakeWorktrees();
  const logs: string[] = [];
  const deps = {
    runner,
    fs,
    layout: testLayout(),
    config,
    git,
    parentNumber: 16,
    feature: "toy-demo",
    integrationBranch: "integration/toy-demo",
    involvedRepos: ["api", "web"],
    log: (message: string) => logs.push(message),
    now: () => 1_700_000_000_000,
  };
  return { runner, fs, git, logs, deps, verify: new CommandVerifyHarness(deps) };
}

describe("command verify", () => {
  it("copies every involved repo's integration branch into one container, bootstraps it and runs its verify command", async () => {
    const { runner, git, verify } = harness();
    runner.respond(/npm run verify/, "Tests 12 passed\n");
    const facts = await verify.up();

    expect(git.created.map((entry) => [entry.repo, entry.ref])).toEqual([
      ["api", "origin/integration/toy-demo"],
      ["web", "origin/integration/toy-demo"],
    ]);
    const container = runner.find("docker run");
    expect(container?.line).toMatch(/--name sc-demo-fvcheck-16-/);
    expect(container?.line).toContain(`${verifyWorktree("api").replace(/\\/g, "/")}:/home/agent/sources-ro/api:ro`);
    expect(runner.find("tar -C /home/agent/sources-ro/api")).toBeDefined();
    expect(runner.find("cd /home/agent/sources/api && npm ci")).toBeDefined();
    expect(runner.find("cd /home/agent/sources/api && npm run verify")).toBeDefined();
    expect(runner.find("cd /home/agent/sources/web && npx tsc -b && npm run build")).toBeDefined();

    expect(facts.mongoUri).toBeUndefined();
    expect(facts.services.every((service) => service.baseUrl === undefined)).toBe(true);
    expect(facts.commands?.[0]).toMatchObject({ repo: "api", command: "npm run verify" });
    expect(facts.commands?.[0]?.outputTail).toContain("Tests 12 passed");
  });

  it("fails the round with the command's own output when a verify command is red", async () => {
    const { runner, verify } = harness();
    runner.fail(/npm run verify/, new CommandFailure("docker", ["exec"], 1, "1 failed\n", ""));
    await expect(verify.up()).rejects.toThrow(/api verify command.*1 failed/s);
  });

  it("refuses to call the base branch the feature when the integration branch never reached origin", async () => {
    const { git, verify } = harness();
    git.missingIntegration.add("web");
    await expect(verify.up()).rejects.toThrow(/web has work items in this run but no integration\/toy-demo on origin/);
  });

  it("hands the same container to the verify agent", async () => {
    const { runner, verify } = harness();
    await verify.up();
    await verify.runAgent("the prompt");
    expect(runner.find("claude -p")?.line).toMatch(/docker exec -i sc-demo-fvcheck-16-/);
  });

  it("writes a green report from the commands alone when verify.agent is off", async () => {
    const { runner, fs, verify } = harness(commandConfig(false));
    await verify.up();
    await verify.runAgent("unused");
    expect(runner.find("claude -p")).toBeUndefined();
    const report = verify.readReport();
    expect(report).toContain("PASS — `npm run verify` in api");
    expect(readVerdict(report).verdict).toBe("green");
    expect([...fs.files.keys()].some((path) => path.endsWith(REPORT_FILE))).toBe(true);
  });

  it("tears down the container, the worktrees and the scratch dir", async () => {
    const { runner, git, fs, verify } = harness();
    await verify.up();
    verify.down();
    expect(runner.find("docker rm -f -v sc-demo-fvcheck-16-")).toBeDefined();
    expect(git.dropped.map((entry) => entry.repo).sort()).toEqual(["api", "web"]);
    expect([...fs.directories].some((path) => path.includes("sandcastle-verify-"))).toBe(false);
  });
});

describe("verify strategy", () => {
  it("picks the harness the project config names", () => {
    const { deps } = harness();
    expect(createVerifyHarness(deps)).toBeInstanceOf(CommandVerifyHarness);
    expect(createVerifyHarness({ ...deps, config: testConfig({ verify: { strategy: "none" } }) })).toBeInstanceOf(NoVerifyHarness);
    expect(createVerifyHarness({ ...deps, config: testConfig() }).constructor.name).toBe("DockerComposeHarness");
  });

  it("none: reports a single PASS that says nothing beyond each item's gate was checked", async () => {
    const none = new NoVerifyHarness({ integrationBranch: "integration/toy-demo", involvedRepos: ["api"], log: () => undefined });
    const facts = await none.up();
    expect(facts.environment).toMatch(/"none"/);
    const verdict = readVerdict(none.readReport());
    expect(verdict.verdict).toBe("green");
    expect(verdict.counts.pass).toBe(1);
  });
});
