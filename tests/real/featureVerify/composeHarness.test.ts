import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AttemptLogStore } from "../../../src/real/attemptLog.js";
import { CommandFailure } from "../../../src/real/commandRunner.js";
import { RecordingCommandRunner } from "../../../src/real/fakeCommandRunner.js";
import {
  DockerComposeHarness,
  REPORT_FILE,
  SOURCE_MOUNT_ROOT,
  type ComposeHarnessDeps,
} from "../../../src/real/featureVerify/composeHarness.js";
import { fsWith, HOME, SANDCASTLE_DIR, testConfig, testLayout } from "../support.js";
import { FakeWorktrees, verifyWorktree } from "./support.js";

const SANDBOX_ENV = join(SANDCASTLE_DIR, ".env.sandbox");
function scratchDir(fs: { directories: Set<string> }): string {
  const found = [...fs.directories].find((path) => path.includes("sandcastle-verify-"));
  if (!found) throw new Error("the harness created no scratch directory");
  return found;
}

function harness(options: { sandboxEnv?: string; deps?: Partial<ComposeHarnessDeps> } = {}) {
  const runner = new RecordingCommandRunner();
  const fs = fsWith({ [SANDBOX_ENV]: options.sandboxEnv ?? "NODE_ENV=development\nMONGO_URI=\nJWT_SECRET=dev-only\n" });
  const git = new FakeWorktrees();
  const logs: string[] = [];
  const compose = new DockerComposeHarness({
    runner,
    fs,
    layout: testLayout(),
    config: testConfig(),
    git,
    parentNumber: 16,
    feature: "toy-demo",
    integrationBranch: "integration/toy-demo",
    involvedRepos: ["api", "web"],
    log: (message) => logs.push(message),
    now: () => 1_700_000_000_000,
    ...options.deps,
  });
  return { runner, fs, git, logs, compose };
}

describe("compose up", () => {
  it("creates a network, a fresh volume and a mongo container that only the compose network can reach", async () => {
    const { runner, compose } = harness();
    await compose.up();

    const network = runner.find("docker network create");
    expect(network?.line).toMatch(/docker network create sc-demo-net-16-/);
    expect(runner.find("docker volume create")?.line).toMatch(/sc-demo-vol-16-/);

    const mongo = runner.findAll("docker run").find((call) => call.line.includes("mongo:7"));
    expect(mongo?.line).toContain("--network-alias mongo");
    expect(mongo?.line).toMatch(/-v sc-demo-vol-16-[0-9a-z]+:\/data\/db/);
    expect(mongo?.line).not.toContain("-p ");
    expect(mongo?.line).not.toContain("sleep infinity");
  });

  it("waits for mongo and for every service to answer before handing the environment over", async () => {
    const { runner, compose } = harness();
    await compose.up();

    expect(runner.find(/mongosh --quiet --eval/)).toBeDefined();
    expect(runner.find(/curl -sf http:\/\/localhost:5000\/api\/health/)).toBeDefined();
    expect(runner.find(/curl -sf http:\/\/localhost:4173\//)).toBeDefined();
  });

  it("builds each service from a detached worktree of the integration branch", async () => {
    const { git, compose } = harness();
    await compose.up();

    expect(git.created).toEqual([
      { repo: "api", ref: "origin/integration/toy-demo", slug: "verify/integration/toy-demo" },
      { repo: "web", ref: "origin/integration/toy-demo", slug: "verify/integration/toy-demo" },
    ]);
  });

  it("falls back to origin/dev only for a repo with no work in this run", async () => {
    const { git, logs, compose } = harness({ deps: { involvedRepos: ["api"] } });
    git.missingIntegration.add("web");
    await compose.up();

    expect(git.created[1]?.ref).toBe("origin/dev");
    expect(logs.join("\n")).toContain("composing it from origin/dev");
  });

  it("refuses to verify an involved repo from origin/dev, and fails before it creates anything", async () => {
    const { runner, git, compose } = harness();
    git.missingIntegration.add("web");

    await expect(compose.up()).rejects.toThrow(/web has work items in this run but no integration\/toy-demo on origin/);
    expect(runner.calls).toEqual([]);
    expect(git.created).toEqual([]);
  });

  it("points the composed env at the local mongo container and rewrites the worktree .env", async () => {
    const { fs, compose } = harness();
    await compose.up();

    const written = fs.readText(join(verifyWorktree("api"), ".env")) ?? "";
    expect(written).toContain("MONGO_URI=mongodb://mongo:27017/sandcastle_verify_toy_demo");
    expect(written).toContain("PORT=5000");
    expect(written).not.toContain("mongodb+srv");
  });

  it("writes the worktree .env as a private file, like every other env sandcastle drops on disk", async () => {
    const { fs, compose } = harness();
    await compose.up();
    expect(fs.privateFiles.has(join(verifyWorktree("api"), ".env"))).toBe(true);
  });

  it("names the credential-shaped keys that reach the throwaway environment instead of hiding them", async () => {
    const { logs, compose } = harness({ sandboxEnv: "MONGO_URI=\nJWT_SECRET=dev-only\nMETA_TOKEN=dev-only\n" });
    await compose.up();

    const warning = logs.find((line) => line.includes("credential-shaped"));
    expect(warning).toContain("JWT_SECRET");
    expect(warning).toContain("META_TOKEN");
  });

  it("builds the web against the in-network api, never a deployed one", async () => {
    const { fs, compose } = harness();
    await compose.up();

    expect(fs.readText(join(verifyWorktree("web"), ".env")) ?? "").toContain("VITE_API_BASE_URL=http://api:5000");
  });

  it("refuses to compose an environment whose sanitized env can still reach a hosted cluster", async () => {
    const { compose } = harness({
      sandboxEnv: "MONGO_URI=\nMONGO_ANALYTICS_URI=mongodb+srv://user:pass@cluster0.abc.mongodb.net/prod\n",
    });
    await expect(compose.up()).rejects.toThrow(/outside the throwaway compose environment/);
  });

  it("refuses to compose an environment pointed at any database that is not the compose mongo", async () => {
    const { compose } = harness({ sandboxEnv: "MONGO_URI=\nLEGACY_MONGO_URI=mongodb://db.internal:27017/prod\n" });
    await expect(compose.up()).rejects.toThrow(/LEGACY_MONGO_URI/);
  });

  it("runs build then seed then a detached serve for each service", async () => {
    const { runner, compose } = harness();
    await compose.up();

    const apiSteps = runner.lines.filter((line) => line.includes("npm ci") || line.includes("npm run migrations:run") || line.includes("npm start"));
    expect(apiSteps[0]).toContain("npm ci && npm run build");
    expect(apiSteps[1]).toContain("npm run migrations:run");
    expect(runner.find("exec -d")?.line).toContain("npm start > /tmp/sandcastle-api.log 2>&1");
  });

  it("skips the seed step for a service that declares none", async () => {
    const { runner, compose } = harness();
    await compose.up();
    expect(runner.findAll(/exec -d/)).toHaveLength(2);
    expect(runner.findAll(/migrations:run/)).toHaveLength(1);
  });

  it("gives the verify agent the compose network, read-only sources and no push credentials", async () => {
    const { runner, fs, compose } = harness();
    await compose.up();

    const agent = runner.findAll("docker run").find((call) => call.line.includes("fvagent"));
    expect(agent?.line).toMatch(/--network sc-demo-net-16-/);
    expect(agent?.line).toContain(`${SOURCE_MOUNT_ROOT}/api:ro`);
    expect(agent?.line).toContain(`${SOURCE_MOUNT_ROOT}/web:ro`);
    expect(agent?.line).toContain(`${HOME.replace(/\\/g, "/")}/.claude:`);
    expect(agent?.line).not.toContain("--network-alias");

    const envFiles = [...fs.files.entries()].filter(([path]) => path.endsWith("container.env"));
    expect(envFiles.map(([, content]) => content).join("\n")).not.toContain("GH_TOKEN");
  });
});

describe("verify agent", () => {
  it("hydrates the container home and feeds the prompt to claude on stdin", async () => {
    const { runner, compose } = harness();
    await compose.up();
    await compose.runAgent("PROMPT BODY");

    expect(runner.find(/cp -a --no-preserve=ownership/)).toBeDefined();
    const claude = runner.find("claude -p --model sonnet");
    expect(claude?.input).toBe("PROMPT BODY");
    expect(claude?.line).toContain("fvagent");
  });

  it("records the agent transcript as a feature-verify attempt under the parent number", async () => {
    const logs = new AttemptLogStore({ fs: fsWith({}), layout: testLayout(), parentNumber: 16 });
    const { runner, compose } = harness({ deps: { logs } });
    await compose.up();
    runner.respond("claude -p --model sonnet", '{"type":"result"}\n');
    await compose.runAgent("PROMPT");

    const [attempt] = logs.list(16);
    expect(attempt).toMatchObject({ id: "16-feature-verify-1", stage: "feature-verify", outcome: "success" });
    expect(logs.read("16-feature-verify-1").chunk).toContain('"type":"result"');
  });

  it("marks the attempt failed with the reason when the agent dies", async () => {
    const logs = new AttemptLogStore({ fs: fsWith({}), layout: testLayout(), parentNumber: 16 });
    const { runner, compose } = harness({ deps: { logs } });
    await compose.up();
    runner.fail("claude -p --model sonnet", new Error("idle timeout"));
    await expect(compose.runAgent("PROMPT")).rejects.toThrow(/idle timeout/);

    expect(logs.list(16)[0]).toMatchObject({ stage: "feature-verify", outcome: "failure" });
    expect(logs.read("16-feature-verify-1").chunk).toContain("failed: idle timeout");
  });

  it("refuses to run before the environment is up", async () => {
    const { compose } = harness();
    await expect(compose.runAgent("PROMPT")).rejects.toThrow(/before up\(\)/);
  });

  it("reads the report the agent wrote into the scratch mount", async () => {
    const { fs, compose } = harness();
    await compose.up();
    fs.writeText(join(scratchDir(fs), REPORT_FILE), "## Results\n- PASS — it works");
    expect(compose.readReport()).toContain("- PASS");
  });

  it("has no report before the environment is up", () => {
    const { compose } = harness();
    expect(compose.readReport()).toBeUndefined();
  });
});

describe("teardown", () => {
  it("removes every container, the network, the volume, the worktrees and the scratch dir", async () => {
    const { runner, fs, git, compose } = harness();
    await compose.up();
    compose.down();

    expect(runner.findAll("docker rm -f")).toHaveLength(4);
    expect(runner.find("docker network rm")).toBeDefined();
    expect(runner.find("docker volume rm")).toBeDefined();
    expect(git.dropped.map((entry) => entry.repo).sort()).toEqual(["api", "web"]);
    expect([...fs.directories].some((path) => path.includes("sandcastle-verify-"))).toBe(false);
  });

  it("tears down in reverse creation order, so containers go before the network they sit on", async () => {
    const { runner, compose } = harness();
    await compose.up();
    const before = runner.calls.length;
    compose.down();

    const removals = runner.calls.slice(before).map((call) => call.line);
    expect(removals.findIndex((line) => line.includes("rm -f"))).toBeLessThan(
      removals.findIndex((line) => line.includes("network rm")),
    );
  });

  it("still tears down what it created when a service build fails half-way", async () => {
    const { runner, compose } = harness();
    runner.fail(/npm ci && npm run build/, new CommandFailure("docker", ["exec"], 1, "", "build blew up"));

    await expect(compose.up()).rejects.toThrow(/api build/);
    compose.down();

    expect(runner.find("docker network rm")).toBeDefined();
    expect(runner.find("docker volume rm")).toBeDefined();
    expect(runner.findAll("docker rm -f")).toHaveLength(2);
  });

  it("tears down a container whose own docker run failed, instead of leaking it to the next run's gc", async () => {
    const { runner, compose } = harness();
    runner.fail(/docker run .*fvapi/, new CommandFailure("docker", ["run"], 1, "", "name already in use"));

    await expect(compose.up()).rejects.toThrow(/name already in use/);
    compose.down();

    expect(runner.findAll("docker rm -f").map((call) => call.line).join("\n")).toContain("fvapi");
    expect(runner.find("docker network rm")).toBeDefined();
    expect(runner.find("docker volume rm")).toBeDefined();
  });

  it("drops a worktree whose creation failed half-way without pretending it exists", async () => {
    const { git, compose } = harness();
    git.createFailure = new Error("worktree add refused");

    await expect(compose.up()).rejects.toThrow(/worktree add refused/);
    compose.down();

    expect(git.dropped).toEqual([]);
  });

  it("keeps tearing the rest down when docker refuses one removal", async () => {
    const { runner, logs, compose } = harness();
    await compose.up();
    runner.fail("docker network rm", new CommandFailure("docker", ["network"], 1, "", "network in use"));
    compose.down();

    expect(logs.join("\n")).toContain("could not tear down");
    expect(runner.find("docker volume rm")).toBeDefined();
  });

  it("is idempotent, so a second call cannot double-remove", async () => {
    const { runner, compose } = harness();
    await compose.up();
    compose.down();
    const after = runner.calls.length;
    compose.down();
    expect(runner.calls).toHaveLength(after);
  });
});
