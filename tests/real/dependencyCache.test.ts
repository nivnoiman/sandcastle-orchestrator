import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CommandFailure } from "../../src/real/commandRunner.js";
import { RecordingCommandRunner } from "../../src/real/fakeCommandRunner.js";
import {
  bootstrapAfterInstall,
  dependencyCacheKey,
  DependencyCaches,
  planDependencyCache,
  pruneDependencyCaches,
  staleDependencyCaches,
  type DependencyCachePlan,
} from "../../src/real/dependencyCache.js";
import { collectOrphans } from "../../src/real/gc.js";
import { CommandVerifyHarness } from "../../src/real/featureVerify/commandHarness.js";
import { fsWith, SANDCASTLE_DIR, testConfig, testLayout } from "./support.js";
import { FakeWorktrees, verifyWorktree } from "./featureVerify/support.js";

const WORKTREE = join("W:", "wt", "api");
const MANIFEST = JSON.stringify({ name: "api", dependencies: { express: "^5.0.0" } });
const LOCKFILE = '{"lockfileVersion":3}';
const KEY_INPUT = { imageId: "sha256:img", install: "npm ci", manifestDependencies: "[]", lockfile: LOCKFILE };

function worktreeFs(files: Record<string, string> = {}) {
  return fsWith({ [join(WORKTREE, "package.json")]: MANIFEST, [join(WORKTREE, "package-lock.json")]: LOCKFILE, ...files });
}

function plan(overrides: Partial<Parameters<typeof planDependencyCache>[0]> = {}) {
  return planDependencyCache({
    fs: worktreeFs(),
    repo: "api",
    worktree: WORKTREE,
    bootstrap: "npm ci",
    imageId: "sha256:img",
    setting: undefined,
    ...overrides,
  });
}

function cachedPlan(overrides: Partial<Parameters<typeof planDependencyCache>[0]> = {}): DependencyCachePlan {
  const decision = plan(overrides);
  if (decision.kind !== "cache") throw new Error(`expected a cache plan, got skip: ${decision.reason}`);
  return decision.plan;
}

describe("dependency cache key", () => {
  it("is stable for the same lockfile and image", () => {
    expect(dependencyCacheKey(KEY_INPUT)).toBe(dependencyCacheKey({ ...KEY_INPUT }));
    expect(dependencyCacheKey(KEY_INPUT)).toMatch(/^[0-9a-f]{12}$/);
  });

  it("changes with the lockfile, the image, the install command or the manifest's dependencies", () => {
    const base = dependencyCacheKey(KEY_INPUT);
    expect(dependencyCacheKey({ ...KEY_INPUT, lockfile: '{"lockfileVersion":2}' })).not.toBe(base);
    expect(dependencyCacheKey({ ...KEY_INPUT, imageId: "sha256:other" })).not.toBe(base);
    expect(dependencyCacheKey({ ...KEY_INPUT, install: "npm install" })).not.toBe(base);
    expect(dependencyCacheKey({ ...KEY_INPUT, manifestDependencies: '[{"a":"1"}]' })).not.toBe(base);
  });

  it("ignores manifest fields that cannot change node_modules", () => {
    const scripted = JSON.stringify({ name: "api", version: "9.9.9", scripts: { test: "jest" }, dependencies: { express: "^5.0.0" } });
    expect(cachedPlan({ fs: worktreeFs({ [join(WORKTREE, "package.json")]: scripted }) }).key).toBe(cachedPlan().key);
  });

  it("names the volume per project, repo and key", () => {
    const found = cachedPlan();
    expect(found.volume).toBe(`sc-demo-deps-api-${found.key}`);
    expect(found.mountPath).toBe("/home/agent/dependency-cache/api");
  });
});

describe("dependency cache plan", () => {
  it("splits only an exact leading npm ci and keeps the rest of the bootstrap", () => {
    expect(bootstrapAfterInstall("npm ci")).toBe("");
    expect(bootstrapAfterInstall(" npm ci && npm run build && npx prisma generate")).toBe("npm run build && npx prisma generate");
    expect(bootstrapAfterInstall("npm ci --ignore-scripts")).toBeUndefined();
    expect(bootstrapAfterInstall("npm install")).toBeUndefined();
    expect(bootstrapAfterInstall("pnpm install --frozen-lockfile")).toBeUndefined();
    expect(bootstrapAfterInstall("npm ci; npm run build")).toBeUndefined();
  });

  it("caches a plain npm ci repo and carries the remainder", () => {
    expect(cachedPlan({ bootstrap: "npm ci && npm run build" }).remainder).toBe("npm run build");
  });

  it.each([
    ["the repo opts out", { setting: false }, /cacheDependencies is false/],
    ["bootstrap is not npm ci", { bootstrap: "pnpm install --frozen-lockfile" }, /does not start with exactly "npm ci"/],
    ["the image id is unknown", { imageId: "" }, /image id/],
    ["there is no lockfile", { fs: fsWith({ [join(WORKTREE, "package.json")]: MANIFEST }) }, /no npm-shrinkwrap.json or package-lock.json/],
    ["there is no package.json", { fs: fsWith({}) }, /no readable package.json/],
    [
      "the repo uses npm workspaces",
      { fs: worktreeFs({ [join(WORKTREE, "package.json")]: JSON.stringify({ workspaces: ["packages/*"] }) }), setting: true },
      /workspaces/,
    ],
    [
      "the root package runs install scripts",
      { fs: worktreeFs({ [join(WORKTREE, "package.json")]: JSON.stringify({ scripts: { postinstall: "prisma generate" } }) }) },
      /postinstall/,
    ],
  ])("skips when %s", (_label, overrides, reason) => {
    const decision = plan(overrides);
    expect(decision.kind).toBe("skip");
    expect(decision.kind === "skip" && decision.reason).toMatch(reason);
  });

  it("caches past root install scripts when the repo opts in explicitly", () => {
    const scripted = worktreeFs({ [join(WORKTREE, "package.json")]: JSON.stringify({ scripts: { prepare: "husky" } }) });
    expect(plan({ fs: scripted, setting: true }).kind).toBe("cache");
  });
});

function caches(runner: RecordingCommandRunner, logs: string[]) {
  runner.respond("docker image inspect", "sha256:img\n");
  const subject = new DependencyCaches({ runner, fs: worktreeFs(), image: "sandcastle:demo", settings: undefined, log: (line) => logs.push(line) });
  subject.plan("api", WORKTREE, "npm ci && npm run build");
  return subject;
}

function recordExec(executed: string[]) {
  return async (command: string) => {
    executed.push(command);
  };
}

describe("dependency cache bootstrap", () => {
  it("on a hit restores node_modules, skips npm ci and still runs the rest of the bootstrap", async () => {
    const runner = new RecordingCommandRunner();
    const logs: string[] = [];
    const executed: string[] = [];
    const subject = caches(runner, logs);
    const key = cachedPlan().key;

    expect(subject.volumes()).toEqual([{ volume: `sc-demo-deps-api-${key}`, containerPath: "/home/agent/dependency-cache/api" }]);
    await subject.bootstrap("box", "api", "/src/api", "npm ci && npm run build", recordExec(executed));

    expect(logs).toContain(`[feature-verify] api dependencies cache hit ${key}`);
    expect(executed).toEqual([
      "rm -rf /src/api/node_modules && cp -a /home/agent/dependency-cache/api/node_modules /src/api/node_modules",
      "cd /src/api && npm run build",
    ]);
  });

  it("on a miss runs the full bootstrap, saves the cache and prunes old ones", async () => {
    const runner = new RecordingCommandRunner();
    runner.fail("test -f /home/agent/dependency-cache/api/.sandcastle-complete", new CommandFailure("docker", ["exec"], 1, "", ""));
    const logs: string[] = [];
    const executed: string[] = [];
    const subject = caches(runner, logs);

    await subject.bootstrap("box", "api", "/src/api", "npm ci && npm run build", recordExec(executed));

    expect(logs).toContain(`[feature-verify] api dependencies cache miss ${cachedPlan().key}`);
    expect(executed[0]).toBe("cd /src/api && npm ci && npm run build");
    expect(executed[1]).toMatch(/cp -a \/src\/api\/node_modules .*touch \/home\/agent\/dependency-cache\/api\/\.sandcastle-complete$/);
    expect(runner.find("docker volume ls --filter name=^sc-demo-deps-")).toBeDefined();
  });

  it("falls back to a full install when the restore fails", async () => {
    const runner = new RecordingCommandRunner();
    const logs: string[] = [];
    const executed: string[] = [];
    const subject = caches(runner, logs);
    const exec = async (command: string) => {
      executed.push(command);
      if (command.startsWith("rm -rf /src/api/node_modules")) throw new Error("cp: disk full");
    };

    await subject.bootstrap("box", "api", "/src/api", "npm ci && npm run build", exec);

    expect(executed).toContain("cd /src/api && npm ci && npm run build");
    expect(logs.some((line) => line.includes("restore failed, installing instead"))).toBe(true);
  });

  it("runs the bootstrap untouched for a repo without a plan", async () => {
    const runner = new RecordingCommandRunner();
    const executed: string[] = [];
    const subject = new DependencyCaches({ runner, fs: fsWith({}), image: "sandcastle:demo", settings: undefined, log: () => undefined });
    subject.plan("web", WORKTREE, "pnpm install");
    await subject.bootstrap("box", "web", "/src/web", "pnpm install", recordExec(executed));
    expect(executed).toEqual(["cd /src/web && pnpm install"]);
    expect(subject.volumes()).toEqual([]);
  });
});

describe("dependency cache garbage collection", () => {
  const volumes = [
    { name: "sc-demo-deps-api-aaaaaaaaaaaa", createdAt: "2026-11-01T10:00:00Z" },
    { name: "sc-demo-deps-api-bbbbbbbbbbbb", createdAt: "2026-11-03T10:00:00Z" },
    { name: "sc-demo-deps-api-cccccccccccc", createdAt: "2026-11-02T10:00:00Z" },
    { name: "sc-demo-deps-web-dddddddddddd", createdAt: "2026-10-01T10:00:00Z" },
    { name: "sc-demo-deps-web-eeeeeeeeeeee", createdAt: "2026-10-02T10:00:00Z" },
    { name: "sc-demo-vol-16-abc", createdAt: "2020-01-01T00:00:00Z" },
    { name: "sc-other-deps-api-ffffffffffff", createdAt: "2020-01-01T00:00:00Z" },
  ];

  it("keeps the newest two per repo and never selects volumes outside the scheme", () => {
    expect(staleDependencyCaches(volumes)).toEqual(["sc-demo-deps-api-aaaaaaaaaaaa"]);
    expect(staleDependencyCaches(volumes, 1)).toEqual([
      "sc-demo-deps-api-cccccccccccc",
      "sc-demo-deps-api-aaaaaaaaaaaa",
      "sc-demo-deps-web-dddddddddddd",
    ]);
  });

  it("removes stale caches through docker and reports a volume still in use", () => {
    const runner = new RecordingCommandRunner();
    runner.respond("docker volume ls", volumes.map((volume) => volume.name).join("\n"));
    runner.respond(
      "docker volume inspect",
      volumes.slice(0, 5).map((volume) => `${volume.name} ${volume.createdAt}`).join("\n"),
    );
    runner.fail("docker volume rm -f sc-demo-deps-api-cccccccccccc", new CommandFailure("docker", ["volume"], 1, "", "volume is in use"));

    const report = pruneDependencyCaches(runner, () => undefined, 1);

    expect(report.removed).toEqual(["sc-demo-deps-api-aaaaaaaaaaaa", "sc-demo-deps-web-dddddddddddd"]);
    expect(report.failures).toHaveLength(1);
    expect(runner.find("docker volume inspect")?.args).not.toContain("sc-demo-vol-16-abc");
  });

  it("runs as part of the startup garbage collection", () => {
    const runner = new RecordingCommandRunner();
    runner.respond("--filter name=^sc-demo-deps-", volumes.slice(0, 3).map((volume) => volume.name).join("\n"));
    runner.respond("docker volume inspect", volumes.slice(0, 3).map((volume) => `${volume.name} ${volume.createdAt}`).join("\n"));

    const report = collectOrphans({ runner, fs: fsWith({}), layout: testLayout(), log: () => undefined, repos: [] });

    expect(report.volumes).toEqual(["sc-demo-deps-api-aaaaaaaaaaaa"]);
  });
});

describe("command verify with a dependency cache", () => {
  function commandHarness() {
    const runner = new RecordingCommandRunner();
    runner.respond("docker image inspect", "sha256:img\n");
    const logs: string[] = [];
    const fs = fsWith({
      [join(SANDCASTLE_DIR, ".env.sandbox")]: "NODE_ENV=development\n",
      [join(verifyWorktree("api"), "package.json")]: MANIFEST,
      [join(verifyWorktree("api"), "package-lock.json")]: LOCKFILE,
    });
    const verify = new CommandVerifyHarness({
      runner,
      fs,
      layout: testLayout(),
      config: testConfig({ verify: { strategy: "command", commands: {}, agent: false } }),
      git: new FakeWorktrees(),
      parentNumber: 16,
      integrationBranch: "integration/toy-demo",
      involvedRepos: ["api"],
      log: (line: string) => logs.push(line),
      now: () => 1_700_000_000_000,
    });
    return { runner, logs, verify };
  }

  it("mounts the repo's cache volume and restores from it instead of running npm ci", async () => {
    const { runner, logs, verify } = commandHarness();
    await verify.up();

    expect(runner.find("docker run")?.line).toMatch(/-v sc-demo-deps-api-[0-9a-f]{12}:\/home\/agent\/dependency-cache\/api/);
    expect(runner.find("chown agent:agent /home/agent/dependency-cache/api")).toBeDefined();
    expect(logs.some((line) => /\[feature-verify\] api dependencies cache hit [0-9a-f]{12}/.test(line))).toBe(true);
    expect(runner.find("cp -a /home/agent/dependency-cache/api/node_modules /home/agent/sources/api/node_modules")).toBeDefined();
    expect(runner.find("cd /home/agent/sources/api && npm ci")).toBeUndefined();
  });

  it("installs and saves the cache on a miss", async () => {
    const { runner, logs, verify } = commandHarness();
    runner.fail("test -f /home/agent/dependency-cache/api/.sandcastle-complete", new CommandFailure("docker", ["exec"], 1, "", ""));
    await verify.up();

    expect(logs.some((line) => /api dependencies cache miss/.test(line))).toBe(true);
    expect(runner.find("cd /home/agent/sources/api && npm ci")).toBeDefined();
    expect(runner.find("touch /home/agent/dependency-cache/api/.sandcastle-complete")).toBeDefined();
  });
});
