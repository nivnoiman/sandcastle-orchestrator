import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CommandFailure } from "../../src/real/commandRunner.js";
import { RecordingCommandRunner } from "../../src/real/fakeCommandRunner.js";
import { collectOrphans } from "../../src/real/gc.js";
import { fsWith, repoDir, SANDCASTLE_DIR, testLayout } from "./support.js";

const API = repoDir("api");
const MANAGED = join(SANDCASTLE_DIR, "worktrees", "api", "feat-17-toy-slice");
const FOREIGN = join("W:", "work", "acme", "api-hotfix");

function worktreeListing(...paths: string[]): string {
  return [`worktree ${API.replace(/\\/g, "/")}`, "HEAD abc", "branch refs/heads/dev", ""]
    .concat(paths.flatMap((path) => [`worktree ${path.replace(/\\/g, "/")}`, "HEAD def", ""]))
    .join("\n");
}

function harness() {
  const runner = new RecordingCommandRunner();
  const fs = fsWith({}, [API]);
  const logs: string[] = [];
  return {
    runner,
    fs,
    logs,
    gc: () =>
      collectOrphans({
        runner,
        fs,
        layout: testLayout(),
        log: (message) => logs.push(message),
        repos: ["api"],
        platform: "linux",
      }),
  };
}

describe("container garbage collection", () => {
  it("removes the containers this orchestrator's naming scheme produces", () => {
    const { runner, gc } = harness();
    runner.respond("--filter name=sc-demo-", "sc-demo-develop-17-a\nsc-demo-verify-18-b\nsc-demo-salvage-19-c");
    const report = gc();
    expect(report.containers).toEqual(["sc-demo-develop-17-a", "sc-demo-verify-18-b", "sc-demo-salvage-19-c"]);
    expect(runner.findAll("docker rm -f")).toHaveLength(3);
  });

  it("never touches a container outside the naming scheme, so a concurrent smoke run survives", () => {
    const { runner, gc } = harness();
    runner.respond(
      "--filter name=sc-demo-",
      ["sc-demo-develop-17-a", "scsmoke-mk3x1", "sandcastle-smoke-mk3x1", "team-sc-demo-develop-17-a"].join("\n"),
    );
    const report = gc();
    expect(report.containers).toEqual(["sc-demo-develop-17-a"]);
    expect(runner.findAll("docker rm -f")).toHaveLength(1);
  });

  it("never lists containers by image, so it cannot reap another run's container", () => {
    const { runner, gc } = harness();
    gc();
    expect(runner.findAll(/ancestor=/)).toHaveLength(0);
  });

  it("keeps going and records the failure when docker refuses", () => {
    const { runner, gc } = harness();
    runner.respond("--filter name=sc-demo-", "sc-demo-develop-17-a");
    runner.fail("docker rm -f", new CommandFailure("docker", ["rm"], 1, "", "container in use"));
    const report = gc();
    expect(report.containers).toEqual([]);
    expect(report.failures[0]).toMatch(/container in use/);
  });

  it("survives a dead docker daemon", () => {
    const { runner, gc } = harness();
    runner.fail(/docker ps/, new CommandFailure("docker", ["ps"], 1, "", "daemon not running"));
    const report = gc();
    expect(report.failures).toHaveLength(1);
    expect(report.containers).toEqual([]);
  });
});

describe("worktree garbage collection", () => {
  it("prunes and removes only worktrees sandcastle manages, with git rather than a recursive delete", () => {
    const { runner, gc } = harness();
    runner.respond("worktree list", worktreeListing(MANAGED, FOREIGN));
    const report = gc();
    expect(report.worktrees).toEqual([MANAGED.replace(/\\/g, "/")]);
    expect(runner.lines).toContain("git worktree prune");
    expect(runner.findAll("worktree remove --force")).toHaveLength(1);
    expect(runner.findAll(/rm -rf|rimraf/)).toHaveLength(0);
  });

  it("records a removal failure instead of throwing", () => {
    const { runner, gc } = harness();
    runner.respond("worktree list", worktreeListing(MANAGED));
    runner.fail("worktree remove", new CommandFailure("git", ["worktree"], 1, "", "locked working tree"));
    const report = gc();
    expect(report.worktrees).toEqual([]);
    expect(report.failures[0]).toMatch(/locked working tree/);
  });

  it("skips a repo that is not checked out on this machine", () => {
    const runner = new RecordingCommandRunner();
    const report = collectOrphans({
      runner,
      fs: fsWith({}),
      layout: testLayout(),
      log: () => undefined,
      repos: ["api"],
    });
    expect(runner.findAll("git worktree")).toHaveLength(0);
    expect(report.failures).toEqual([]);
  });
});

describe("compose environment garbage collection", () => {
  it("removes the networks and volumes feature verify leaves behind", () => {
    const { runner, gc } = harness();
    runner.respond("network ls", "sc-demo-net-16-a1\nsc-demo-net-4-b2");
    runner.respond("volume ls", "sc-demo-vol-16-a1");
    const report = gc();
    expect(report.networks).toEqual(["sc-demo-net-16-a1", "sc-demo-net-4-b2"]);
    expect(report.volumes).toEqual(["sc-demo-vol-16-a1"]);
    expect(runner.findAll("docker network rm")).toHaveLength(2);
    expect(runner.findAll("docker volume rm")).toHaveLength(1);
  });

  it("never touches a network or volume outside the naming scheme", () => {
    const { runner, gc } = harness();
    runner.respond("network ls", "sc-demo-net-16-a1\nbridge\nsandcastle-netops\nmy-sc-demo-net-16-a1");
    runner.respond("volume ls", "sc-demo-vol-16-a1\npostgres-data");
    const report = gc();
    expect(report.networks).toEqual(["sc-demo-net-16-a1"]);
    expect(report.volumes).toEqual(["sc-demo-vol-16-a1"]);
  });

  it("anchors the docker filters, so a foreign name cannot slip in on a prefix match", () => {
    const { runner, gc } = harness();
    gc();
    expect(runner.find("network ls")?.line).toContain("name=^sc-demo-net-");
    expect(runner.find("volume ls")?.line).toContain("name=^sc-demo-vol-");
  });

  it("records a removal failure instead of throwing", () => {
    const { runner, gc } = harness();
    runner.respond("network ls", "sc-demo-net-16-a1");
    runner.fail("docker network rm", new CommandFailure("docker", ["network"], 1, "", "network has active endpoints"));
    const report = gc();
    expect(report.networks).toEqual([]);
    expect(report.failures[0]).toMatch(/active endpoints/);
  });
});
