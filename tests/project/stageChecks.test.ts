import { describe, expect, it } from "vitest";
import { parseProjectConfig } from "../../src/project/projectConfig.js";
import { commandsForStage, commandsOfText, parseStageChecks } from "../../src/project/stageChecks.js";
import { installPrePushHookCommand, prePushHookScript } from "../../src/real/stageGate.js";

const CONFIG = "/p/.sandcastle/config.json";
const base = (repo: object, extra: object = {}) => ({ tracker: "local", name: "demo", repos: { app: { checks: "npm test", ...repo } }, ...extra });

describe("stageChecks schema", () => {
  it("is optional: a config without it parses to empty lists", () => {
    expect(parseProjectConfig(base({}), CONFIG).repos["app"]?.stageChecks).toEqual({});
  });

  it("keeps ordered lists per stage next to the default checks", () => {
    const project = parseProjectConfig(base({ stageChecks: { develop: ["pnpm typecheck", "pnpm test"], verify: ["a"] } }), CONFIG);
    expect(project.repos["app"]?.stageChecks).toEqual({ develop: ["pnpm typecheck", "pnpm test"], verify: ["a"] });
    expect(project.repos["app"]?.checks).toBe("npm test");
  });

  it.each([
    [{ develop: "pnpm test" }, /stageChecks\.develop must be a non-empty list/],
    [{ develop: [] }, /non-empty list/],
    [{ develop: ["ok", "  "] }, /stageChecks\.develop\[1\] must be a non-empty command/],
    [{ develop: [3] }, /develop\[0\]/],
    [{ ghost: ["x"] }, /repos\.app\.stageChecks\.ghost names a stage that is not in stages/],
  ])("fails fast on %j", (stageChecks, message) => {
    expect(() => parseProjectConfig(base({ stageChecks }), CONFIG)).toThrow(message);
  });

  it("refuses a list for a command stage, which already runs its own command", () => {
    const stages = ["develop", { name: "e2e", kind: "command", run: "npx playwright test" }];
    expect(() => parseProjectConfig(base({ stageChecks: { e2e: ["x"] } }, { stages }), CONFIG)).toThrow(/command stage/);
  });

  it("must be a map", () => {
    expect(() => parseStageChecks(["x"], "w")).toThrow(/must map stage names/);
  });
});

describe("commandsForStage", () => {
  it("uses the stage's own list, falls back to the default only for verify, and gates nothing else", () => {
    expect(commandsForStage({ develop: ["a", "b"] }, "develop", "dflt")).toEqual(["a", "b"]);
    expect(commandsForStage({}, "verify", "dflt")).toEqual(["dflt"]);
    expect(commandsForStage({ verify: ["v"] }, "verify", "dflt")).toEqual(["v"]);
    expect(commandsForStage({}, "develop", "dflt")).toBeUndefined();
  });

  it("splits an editor text area into commands, dropping blank lines", () => {
    expect(commandsOfText(" a \r\n\n b\n")).toEqual(["a", "b"]);
  });
});

describe("pre-push hook", () => {
  it("runs each command in order and blocks the push on the first red one", () => {
    const script = prePushHookScript(["pnpm typecheck", "echo it's"]);
    expect(script.indexOf("run 'pnpm typecheck'")).toBeLessThan(script.indexOf("run 'echo it'\\''s'"));
    expect(script).toContain("exit 1");
    expect(script).toContain("cd '/home/agent/workspace'");
  });

  it("installs through base64 so no command needs shell quoting", () => {
    const command = installPrePushHookCommand(['echo "$HOME" && `x`']);
    expect(command).toMatch(/^mkdir -p \/usr\/local\/share\/sandcastle-hooks && printf %s [A-Za-z0-9+/=]+ \| base64 -d >/);
    expect(command).not.toContain("$HOME");
  });
});
