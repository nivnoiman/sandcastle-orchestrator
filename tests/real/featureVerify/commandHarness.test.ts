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
import { RecheckLedger } from "../../../src/real/featureVerify/recheck.js";

const SANDBOX_ENV = join(SANDCASTLE_DIR, ".env.sandbox");

function commandConfig(agent = true, recheck: Record<string, string> = {}): OrchestratorConfig {
  return testConfig({ verify: { strategy: "command", commands: { api: "npm run verify" }, recheck, agent } });
}

function harness(config = commandConfig(), runner = new RecordingCommandRunner(), recheckLedger?: RecheckLedger) {
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
    recheckLedger,
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

describe("command verify recheck after a fix round", () => {
  const SHA_A = "a".repeat(40);
  const SHA_B = "b".repeat(40);
  const recheckConfig = () => commandConfig(true, { api: "npm run affected" });

  function round(ledger: RecheckLedger, head: string, script: (runner: RecordingCommandRunner) => void = () => undefined) {
    const runner = new RecordingCommandRunner();
    runner.respond(/^git rev-parse HEAD$/, `${head}\n`);
    runner.respond(/^git diff --name-only/, "src/x.ts\n");
    script(runner);
    return harness(recheckConfig(), runner, ledger);
  }

  it("runs the full command on the first verify of a run", async () => {
    const { runner, logs, verify } = round(new RecheckLedger(), SHA_A);
    await verify.up();
    expect(runner.find("cd /home/agent/sources/api && npm run verify")).toBeDefined();
    expect(runner.find("npm run affected")).toBeUndefined();
    expect(logs).toContain("[feature-verify] api verify command (full: first verify of this run)");
  });

  it("runs the affected command since the last green commit on a re-verify", async () => {
    const ledger = new RecheckLedger();
    await round(ledger, SHA_A).verify.up();
    const { runner, logs, verify } = round(ledger, SHA_B);
    const facts = await verify.up();

    expect(runner.find(`git merge-base --is-ancestor ${SHA_A} HEAD`)).toBeDefined();
    expect(runner.find(/^git -c core\.autocrlf=false -c core\.eol=lf archive --format=tar -o \S+recheck-api-base\.tar a{40}$/)).toBeDefined();
    expect(runner.find(/^git -c core\.autocrlf=false -c core\.eol=lf archive --format=tar -o \S+recheck-api-head\.tar b{40}$/)).toBeDefined();
    expect(runner.find("tar -xf /home/agent/workspace/recheck-api-base.tar")).toBeDefined();
    expect(runner.find('export SANDCASTLE_RECHECK_BASE="$(git rev-parse HEAD~1)" && npm run affected')).toBeDefined();
    expect(runner.find("cd /home/agent/sources/api && npm run verify")).toBeUndefined();
    expect(logs).toContain(`[feature-verify] api verify command (affected since ${SHA_A.slice(0, 12)})`);
    expect(logs).toContain("[feature-verify] web verify command (full: no verify.recheck for it)");
    expect(facts.commands?.[0]).toMatchObject({ repo: "api", command: "npm run affected" });
  });

  it("skips the command of a repo the fix round did not change", async () => {
    const ledger = new RecheckLedger();
    await round(ledger, SHA_A).verify.up();
    const { runner, logs, verify } = round(ledger, SHA_A);
    const facts = await verify.up();

    expect(runner.find("npm run verify")).toBeUndefined();
    expect(runner.find("npm run affected")).toBeUndefined();
    expect(runner.find("cd /home/agent/sources/api && npm ci")).toBeDefined();
    expect(logs.some((line) => line.includes("api verify command skipped (unchanged since"))).toBe(true);
    expect(facts.commands?.[0]?.outputTail).toMatch(/skipped: unchanged since/);
  });

  it("falls back to the full command when the last green commit is not reachable", async () => {
    const ledger = new RecheckLedger();
    await round(ledger, SHA_A).verify.up();
    const { runner, logs, verify } = round(ledger, SHA_B, (scripted) =>
      scripted.fail(/^git merge-base --is-ancestor/, new CommandFailure("git", ["merge-base"], 1, "", "")),
    );
    await verify.up();

    expect(runner.find("cd /home/agent/sources/api && npm run verify")).toBeDefined();
    expect(runner.find("npm run affected")).toBeUndefined();
    expect(logs).toContain(`[feature-verify] api verify command (full: last verified ${SHA_A.slice(0, 12)} is not reachable)`);
    expect(logs.some((line) => line.includes("merge-base --is-ancestor failed"))).toBe(false);
  });

  it("runs the full command again for a repo that was red last round", async () => {
    const ledger = new RecheckLedger();
    const red = round(ledger, SHA_A, (scripted) => scripted.fail(/npm run verify/, new CommandFailure("docker", ["exec"], 1, "1 failed\n", "")));
    await expect(red.verify.up()).rejects.toThrow(/1 failed/);
    const { runner, logs, verify } = round(ledger, SHA_B);
    await verify.up();

    expect(runner.find("cd /home/agent/sources/api && npm run verify")).toBeDefined();
    expect(logs).toContain("[feature-verify] api verify command (full: it was red last round)");
  });

  it("resets the copy and runs the full command when the recheck history cannot be seeded", async () => {
    const ledger = new RecheckLedger();
    await round(ledger, SHA_A).verify.up();
    const { runner, logs, verify } = round(ledger, SHA_B, (scripted) =>
      scripted.fail(/git init -q/, new CommandFailure("docker", ["exec"], 1, "patch does not apply\n", "")),
    );
    await verify.up();

    expect(runner.find("rm -rf /home/agent/sources/api")).toBeDefined();
    expect(runner.find("cd /home/agent/sources/api && npm run verify")).toBeDefined();
    expect(logs).toContain("[feature-verify] api verify command (full: recheck history could not be seeded)");
  });
});
