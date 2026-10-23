import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunModel } from "../../src/model/runModel.js";
import { syncClaudeHome } from "../../src/real/claudeSync.js";
import type { CommandRequest, CommandResult, CommandRunner } from "../../src/real/commandRunner.js";
import { MemoryFileSystem } from "../../src/real/fileSystem.js";
import { memoryPath } from "../../src/real/memories.js";
import { layoutFrom, memoryProjectSuffix, type SandcastleLayout } from "../../src/real/paths.js";
import { assertPreflight, runPreflight, type PreflightDeps } from "../../src/real/preflight.js";
import { hostSkillPath, REQUIRED_SKILLS } from "../../src/real/skills.js";
import { testConfig, testRunModel, HOME, SANDCASTLE_DIR } from "./support.js";

const WORKSPACE = join("W:", "work");

function layout(): SandcastleLayout {
  return layoutFrom(SANDCASTLE_DIR, HOME, { workspaceRoot: WORKSPACE });
}

function model(): RunModel {
  return { ...testRunModel(), loadBearingMemories: ["gotcha_web_tsc_b_vs_noemit"] };
}

function readyFileSystem(): MemoryFileSystem {
  const fs = new MemoryFileSystem();
  const target = layout();
  fs.writeText(join(WORKSPACE, "api", ".git", "HEAD"), "ref: refs/heads/dev");
  fs.makeDirectory(join(WORKSPACE, "api", ".git"));
  fs.writeText(join(SANDCASTLE_DIR, ".env.sandbox.api"), "MONGO_URI=mongodb://x");
  fs.writeText(join(SANDCASTLE_DIR, ".env.sandbox.web"), "VITE_API=http://x");
  fs.writeText(memoryPath(target, "gotcha_web_tsc_b_vs_noemit"), "web CI runs tsc -b");
  for (const skill of REQUIRED_SKILLS) fs.writeText(hostSkillPath(target, skill), `# ${skill}`);
  return fs;
}

function okRunner(): CommandRunner {
  return {
    run: (request: CommandRequest): CommandResult => ({
      stdout: request.args.includes("user") ? "sandcastle-bot\n" : "27.0.0\nsha",
      stderr: "",
    }),
    start: () => {
      throw new Error("preflight never starts a streaming command");
    },
  };
}

function deps(overrides: Partial<PreflightDeps> = {}): PreflightDeps {
  return {
    runner: okRunner(),
    fs: readyFileSystem(),
    layout: layout(),
    config: testConfig(),
    model: model(),
    skipVerify: false,
    probe: async () => ({ ok: true, reason: undefined, detail: undefined }),
    ...overrides,
  };
}

function failed(report: Awaited<ReturnType<typeof runPreflight>>): string[] {
  return report.failures.map((check) => check.name);
}

describe("preflight", () => {
  it("passes on a host that is genuinely ready", async () => {
    const report = await runPreflight(deps());

    expect(failed(report)).toEqual([]);
    expect(report.checks.map((check) => check.name)).toContain("agent auth");
  });

  it("names an IPv4 block between the containers and the Claude API before any stage starts", async () => {
    const blocked: CommandRunner = {
      ...okRunner(),
      run: (request: CommandRequest): CommandResult => {
        if (request.args.includes("https://api.anthropic.com/")) {
          throw new Error("docker run exited with 7:\ncurl: (7) Failed to connect to api.anthropic.com port 443: Connection refused");
        }
        return okRunner().run(request);
      },
    };
    const report = await runPreflight(deps({ runner: blocked }));

    expect(failed(report)).toEqual(["container network (IPv4)"]);
    const detail = report.failures[0]?.detail ?? "";
    expect(detail).toContain("api.anthropic.com (curl: (7) Failed to connect");
    expect(detail).not.toContain("api.github.com");
    expect(detail).toContain("over IPv4");
  });

  it("reports every failure at once instead of dying on the first", async () => {
    const fs = new MemoryFileSystem();
    const report = await runPreflight(deps({ fs }));

    expect(failed(report)).toEqual([
      "repo checkouts",
      "sandbox env files",
      "load-bearing memories",
      "agent skills",
    ]);
  });

  it("names the missing memory slug and the directory it looked in", async () => {
    const fs = readyFileSystem();
    fs.removeFile(memoryPath(layout(), "gotcha_web_tsc_b_vs_noemit"));
    const report = await runPreflight(deps({ fs }));

    const memories = report.checks.find((check) => check.name === "load-bearing memories");
    expect(memories?.detail).toContain("gotcha_web_tsc_b_vs_noemit");
    expect(memories?.detail).toContain(layout().memoryDir);
  });

  it("fails on the workspace root the launch forgot to export, naming the setting that fixes it", async () => {
    const report = await runPreflight(deps({ layout: layoutFrom(SANDCASTLE_DIR, HOME) }));

    const checkout = report.checks.find((check) => check.name === "repo checkouts");
    expect(checkout?.ok).toBe(false);
    expect(checkout?.detail).toContain("SANDCASTLE_WORKSPACE_ROOT");
  });

  it("catches dead agent credentials before a single stage container starts", async () => {
    const report = await runPreflight(
      deps({ probe: async () => ({ ok: false, reason: "auth", detail: "OAuth session expired" }) }),
    );

    expect(failed(report)).toEqual(["agent auth"]);
  });

  it("catches a closed usage window too, so a run does not start into a dead one", async () => {
    const report = await runPreflight(
      deps({ probe: async () => ({ ok: false, reason: "rate-limit", detail: "resetsAt 1757000000" }) }),
    );

    expect(report.failures[0]?.detail).toContain("rate-limit");
  });

  it("lists every failure in the error assertPreflight throws", async () => {
    await expect(assertPreflight(deps({ fs: new MemoryFileSystem() }))).rejects.toThrow(/repo checkouts.*\n.*sandbox env files/s);
  });

  it("syncs the claude home before checking what is in it", async () => {
    const fs = new MemoryFileSystem();
    const source = join("/mnt", "c", "Users", "dev", ".claude");
    fs.makeDirectory(source);
    fs.makeDirectory(join(source, memoryProjectSuffix()));
    fs.makeDirectory(join(source, "skills"));
    fs.writeText(join(source, memoryProjectSuffix(), "gotcha_web_tsc_b_vs_noemit.md"), "web CI runs tsc -b");
    for (const skill of REQUIRED_SKILLS) fs.writeText(join(source, "skills", skill, "SKILL.md"), `# ${skill}`);
    fs.writeText(join(source, ".credentials.json"), "{}");

    const report = await runPreflight(deps({ fs, config: testConfig({ claudeSyncSource: source }) }));

    expect(failed(report)).toEqual(["repo checkouts", "sandbox env files"]);
    expect(fs.exists(memoryPath(layout(), "gotcha_web_tsc_b_vs_noemit"))).toBe(true);
    expect(fs.exists(hostSkillPath(layout(), "simplify"))).toBe(true);
  });

  it("leaves the claude home alone while a sibling parent's containers hydrate from it", async () => {
    const fs = readyFileSystem();
    const source = join("/mnt", "c", "Users", "dev", ".claude");
    fs.makeDirectory(source);
    fs.writeText(join(source, ".credentials.json"), "{\"fresh\":true}");

    const report = await runPreflight(
      deps({ fs, config: testConfig({ claudeSyncSource: source }), claudeHomeInUse: true }),
    );

    expect(failed(report)).toEqual([]);
    expect(fs.exists(join(layout().claudeDir, ".credentials.json"))).toBe(false);
  });
});

describe("syncClaudeHome", () => {
  it("copies the credentials private and reports what the source did not have", () => {
    const fs = new MemoryFileSystem();
    const source = join("/mnt", "c", "claude");
    fs.makeDirectory(source);
    fs.writeText(join(source, ".credentials.json"), "{\"token\":\"x\"}");

    const report = syncClaudeHome(fs, source, join(HOME, ".claude"));

    expect(report.copied).toEqual([".credentials.json"]);
    expect(report.absent).toContain("skills");
    expect(fs.readText(join(HOME, ".claude", ".credentials.json"))).toBe("{\"token\":\"x\"}");
  });

  it("refuses a source that does not exist rather than silently syncing nothing", () => {
    expect(() => syncClaudeHome(new MemoryFileSystem(), join("/mnt", "c", "gone"), join(HOME, ".claude"))).toThrow(
      /SANDCASTLE_CLAUDE_SOURCE/,
    );
  });
});
