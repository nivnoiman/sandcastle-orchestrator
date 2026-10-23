import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  clampIdleTimeout,
  loadOrchestratorConfig,
  numericSetting,
  parseEnvFile,
  readEnvFileValues,
  resolveSandboxEnvFile,
  salvageIdleTimeout,
  resolveLayout,
  sandboxEnvPreflightRepos,
  stageModel,
} from "../../src/real/env.js";
import { memoryProjectSuffix } from "../../src/real/paths.js";
import { fsWith, SANDCASTLE_DIR, testConfig, testLayout } from "./support.js";

const ENV_PATH = join(SANDCASTLE_DIR, ".env.orchestrator");

describe("parseEnvFile", () => {
  it("reads plain, quoted, exported and commented lines", () => {
    const values = parseEnvFile(
      ["# comment", "GH_TOKEN=abc123", "export MODEL='opus'", 'IMAGE="sandcastle:demo"', "", "TRAILING=x # note"].join("\n"),
    );
    expect(values).toEqual({ GH_TOKEN: "abc123", MODEL: "opus", IMAGE: "sandcastle:demo", TRAILING: "x" });
  });

  it("keeps values containing = and #-inside-quotes intact", () => {
    const values = parseEnvFile(['MONGO_URI="mongodb://u:p#x@host/db?a=1"', "CHECKS=npx tsc --noEmit && npx jest"].join("\n"));
    expect(values["MONGO_URI"]).toBe("mongodb://u:p#x@host/db?a=1");
    expect(values["CHECKS"]).toBe("npx tsc --noEmit && npx jest");
  });
});

describe("idle timeout clamping", () => {
  it("defaults to 1200 and clamps to [60, 7200]", () => {
    expect(clampIdleTimeout(undefined)).toBe(1200);
    expect(clampIdleTimeout(Number.NaN)).toBe(1200);
    expect(clampIdleTimeout(5)).toBe(60);
    expect(clampIdleTimeout(99999)).toBe(7200);
    expect(clampIdleTimeout(900)).toBe(900);
  });

  it("caps the salvage budget at 300s", () => {
    expect(salvageIdleTimeout(600)).toBe(300);
    expect(salvageIdleTimeout(120)).toBe(120);
  });

  it("refuses a salvage budget derived from a nonsensical idle timeout", () => {
    expect(() => salvageIdleTimeout(Number.NaN)).toThrow(/positive idle timeout/);
    expect(() => salvageIdleTimeout(0)).toThrow(/positive idle timeout/);
  });
});

describe("numericSetting", () => {
  it("reads a number, ignores a missing or blank value, and fails fast on garbage", () => {
    expect(numericSetting({ SANDCASTLE_IDLE_TIMEOUT: "900" }, "SANDCASTLE_IDLE_TIMEOUT")).toBe(900);
    expect(numericSetting({}, "SANDCASTLE_IDLE_TIMEOUT")).toBeUndefined();
    expect(numericSetting({ SANDCASTLE_IDLE_TIMEOUT: "  " }, "SANDCASTLE_IDLE_TIMEOUT")).toBeUndefined();
    expect(() => numericSetting({ SANDCASTLE_IDLE_TIMEOUT: "abc" }, "SANDCASTLE_IDLE_TIMEOUT")).toThrow(
      /SANDCASTLE_IDLE_TIMEOUT="abc" is not a number/,
    );
  });
});

describe("loadOrchestratorConfig", () => {
  it("refuses to start without a .env.orchestrator", () => {
    expect(() => loadOrchestratorConfig(fsWith({}), testLayout())).toThrow(/refuses to start without it/);
  });

  it("refuses to start without GH_TOKEN", () => {
    expect(() => loadOrchestratorConfig(fsWith({ [ENV_PATH]: "ANTHROPIC_API_KEY=k" }), testLayout())).toThrow(/no GH_TOKEN/);
  });

  it("applies defaults and keeps ANTHROPIC_API_KEY optional", () => {
    const config = loadOrchestratorConfig(fsWith({ [ENV_PATH]: "GH_TOKEN=t" }), testLayout());
    expect(config.ghToken).toBe("t");
    expect(config.anthropicApiKey).toBeUndefined();
    expect(config.claudeOauthToken).toBeUndefined();
    expect(config.model).toBe("opus");
    expect(config.reviewModel).toBe("sonnet");
    expect(config.imageTag).toBe("sandcastle:demo");
    expect(config.idleTimeoutSeconds).toBe(1200);
    expect(config.checkCommands.api).toContain("tsc");
  });

  it("runs jest on four workers unless the file names a count or a share", () => {
    const load = (line: string) => loadOrchestratorConfig(fsWith({ [ENV_PATH]: `GH_TOKEN=t\n${line}` }), testLayout());
    expect(load("").jestWorkers).toBe("4");
    expect(load("SANDCASTLE_JEST_WORKERS=6").jestWorkers).toBe("6");
    expect(load("SANDCASTLE_JEST_WORKERS=50%").jestWorkers).toBe("50%");
    expect(() => load("SANDCASTLE_JEST_WORKERS=0")).toThrow(/worker count like 4/);
    expect(() => load("SANDCASTLE_JEST_WORKERS=4; rm -rf /")).toThrow(/worker count like 4/);
  });

  it("gives an item three rework rounds unless the file names another count", () => {
    const load = (line: string) => loadOrchestratorConfig(fsWith({ [ENV_PATH]: `GH_TOKEN=t\n${line}` }), testLayout());
    expect(load("").reworkLimit).toBe(3);
    expect(load("SANDCASTLE_REWORK_LIMIT=0").reworkLimit).toBe(0);
    expect(load("SANDCASTLE_REWORK_LIMIT=5").reworkLimit).toBe(5);
    expect(() => load("SANDCASTLE_REWORK_LIMIT=two")).toThrow(/whole number of rework rounds/);
    expect(load("").featureReworkLimit).toBe(3);
    expect(load("SANDCASTLE_FEATURE_REWORK_LIMIT=1").featureReworkLimit).toBe(1);
    expect(() => load("SANDCASTLE_FEATURE_REWORK_LIMIT=-1")).toThrow(/SANDCASTLE_FEATURE_REWORK_LIMIT/);
  });

  it("honours per-repo bootstrap and check overrides", () => {
    const content = ["GH_TOKEN=t", "SANDCASTLE_CHECKS_API=npm run verify", "SANDCASTLE_BOOTSTRAP_WEB=npm install"].join("\n");
    const config = loadOrchestratorConfig(fsWith({ [ENV_PATH]: content }), testLayout());
    expect(config.checkCommands.api).toBe("npm run verify");
    expect(config.checkCommands.web).toBe("npx tsc -b && npm run build");
    expect(config.bootstrapCommands.web).toBe("npm install");
    expect(config.bootstrapCommands.api).toBe("npm ci");
  });

  it("lets an explicit idle-timeout option win over the file and still clamps", () => {
    const files = { [ENV_PATH]: ["GH_TOKEN=t", "SANDCASTLE_IDLE_TIMEOUT=120"].join("\n") };
    expect(loadOrchestratorConfig(fsWith(files), testLayout()).idleTimeoutSeconds).toBe(120);
    expect(loadOrchestratorConfig(fsWith(files), testLayout(), { idleTimeoutSeconds: 1 }).idleTimeoutSeconds).toBe(60);
  });

  it("refuses a non-numeric idle timeout instead of silently defaulting to 600", () => {
    const files = { [ENV_PATH]: ["GH_TOKEN=t", "SANDCASTLE_IDLE_TIMEOUT=abc"].join("\n") };
    expect(() => loadOrchestratorConfig(fsWith(files), testLayout())).toThrow(/SANDCASTLE_IDLE_TIMEOUT="abc" is not a number/);
  });

  it("defaults the web gate to what web CI runs — tsc -b then build", () => {
    const config = loadOrchestratorConfig(fsWith({ [ENV_PATH]: "GH_TOKEN=t" }), testLayout());
    expect(config.checkCommands.web).toBe("npx tsc -b && npm run build");
  });
});

describe("resolveSandboxEnvFile", () => {
  it("prefers the per-repo file over the shared one", () => {
    const perRepo = join(SANDCASTLE_DIR, ".env.sandbox.api");
    const shared = join(SANDCASTLE_DIR, ".env.sandbox");
    const fs = fsWith({ [perRepo]: "NODE_ENV=development", [shared]: "NODE_ENV=development" });
    expect(resolveSandboxEnvFile(fs, testLayout(), "api")).toBe(perRepo);
    expect(resolveSandboxEnvFile(fs, testLayout(), "web")).toBe(shared);
  });

  it("fails fast, naming both candidates, when no sanitized env exists", () => {
    expect(() => resolveSandboxEnvFile(fsWith({}), testLayout(), "api")).toThrow(/never copy the real api \.env/);
  });
});

describe("sandbox env preflight", () => {
  it("demands an env for every repo feature verify will compose, not just the ones with work", () => {
    expect(sandboxEnvPreflightRepos(["api"], false)).toEqual(["api", "web"]);
  });

  it("asks only for the repos in play when the verify stage is skipped", () => {
    expect(sandboxEnvPreflightRepos(["api"], true)).toEqual(["api"]);
  });

  it("never asks twice for the same repo", () => {
    expect(sandboxEnvPreflightRepos(["api", "web"], false)).toEqual(["api", "web"]);
  });
});

describe("feature verify services", () => {
  it("defaults to a mongo:7 database and one served build per repo", () => {
    const config = loadOrchestratorConfig(fsWith({ [ENV_PATH]: "GH_TOKEN=t" }), testLayout());
    expect(config.mongoImage).toBe("mongo:7");
    expect(config.verifyServices.api).toEqual({
      build: "npm ci && npm run build",
      seed: "npm run migrations:run",
      serve: "npm start",
      port: 5000,
      healthPath: "/api/health",
      env: { MONGO_URI: "{{mongoUri}}", MONGO_DB: "{{mongoDb}}", BASE_URL: "{{url:api}}" },
    });
    expect(config.verifyServices.web!.port).toBe(4173);
    expect(config.verifyServices.web!.seed).toBe("");
  });

  it("honours per-repo verify overrides, including an emptied seed step", () => {
    const content = [
      "GH_TOKEN=t",
      "SANDCASTLE_VERIFY_MONGO_IMAGE=mongo:8",
      "SANDCASTLE_VERIFY_SEED_API=",
      "SANDCASTLE_VERIFY_PORT_WEB=5173",
      "SANDCASTLE_VERIFY_HEALTH_API=/healthz",
    ].join("\n");
    const config = loadOrchestratorConfig(fsWith({ [ENV_PATH]: content }), testLayout());
    expect(config.mongoImage).toBe("mongo:8");
    expect(config.verifyServices.api!.seed).toBe("");
    expect(config.verifyServices.api!.healthPath).toBe("/healthz");
    expect(config.verifyServices.web!.port).toBe(5173);
  });

  it("refuses a port that is not a port", () => {
    const files = { [ENV_PATH]: ["GH_TOKEN=t", "SANDCASTLE_VERIFY_PORT_API=99999"].join("\n") };
    expect(() => loadOrchestratorConfig(fsWith(files), testLayout())).toThrow(/not a tcp port/);
  });
});

describe("resolveLayout", () => {
  it("reads layout settings from the tool-wide .env too, with the project .env winning", () => {
    const toolDir = "/tool";
    const files = {
      [join(toolDir, ".env.orchestrator")]: ["SANDCASTLE_CLAUDE_HOME=/shared/.claude", "SANDCASTLE_WORKTREE_DIR=/shared/wt"].join("\n"),
      [ENV_PATH]: "SANDCASTLE_WORKTREE_DIR=/project/wt",
    };
    expect(readEnvFileValues(fsWith(files), SANDCASTLE_DIR, toolDir)).toEqual({
      SANDCASTLE_CLAUDE_HOME: "/shared/.claude",
      SANDCASTLE_WORKTREE_DIR: "/project/wt",
    });
  });

  it("takes the workspace root from the project .env, so a launch that never sourced ~/.bashrc still finds the repos", () => {
    const files = { [ENV_PATH]: ["GH_TOKEN=t", "SANDCASTLE_WORKSPACE_ROOT=/home/dev/work"].join("\n") };
    const layout = resolveLayout(fsWith(files), { SANDCASTLE_DIR });

    expect(layout.workspaceRoot).toBe("/home/dev/work");
  });

  it("lets the process env win over the file, and points memories at the claude home it was given", () => {
    const files = { [ENV_PATH]: ["GH_TOKEN=t", "SANDCASTLE_WORKSPACE_ROOT=/home/dev/work"].join("\n") };
    const layout = resolveLayout(fsWith(files), {
      SANDCASTLE_DIR,
      SANDCASTLE_WORKSPACE_ROOT: "/tmp/other",
      SANDCASTLE_CLAUDE_HOME: "/mnt/c/Users/dev/.claude",
    });

    expect(layout.workspaceRoot).toBe("/tmp/other");
    expect(layout.memoryDir).toBe(join("/mnt/c/Users/dev/.claude", memoryProjectSuffix()));
  });

  it("falls back to the sandcastle parent and ~/.claude when nothing overrides them", () => {
    const layout = resolveLayout(fsWith({}), { SANDCASTLE_DIR });

    expect(layout.workspaceRoot).toBe(join("W:", "work", "acme"));
    expect(layout.claudeDir).toContain(".claude");
  });
});

describe("stageModel", () => {
  it("runs develop on the main model and fresh-eyes stages on the review model", () => {
    const config = testConfig({ model: "opus", reviewModel: "sonnet" });
    expect(stageModel(config, "develop")).toBe("opus");
    expect(stageModel(config, "simplify")).toBe("sonnet");
    expect(stageModel(config, "review")).toBe("sonnet");
  });

  it("reads SANDCASTLE_REVIEW_MODEL from .env.orchestrator", () => {
    const config = loadOrchestratorConfig(fsWith({ [ENV_PATH]: "GH_TOKEN=t\nSANDCASTLE_REVIEW_MODEL=haiku" }), testLayout());
    expect(config.reviewModel).toBe("haiku");
  });
});
