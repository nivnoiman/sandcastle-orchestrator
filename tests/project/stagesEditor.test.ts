import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readProjectConfig } from "../../src/project/projectConfig.js";
import { parseAgentEdits, saveAgentEdits, stagesViewOf, withAgentEdits } from "../../src/project/stagesEditor.js";

let root: string;
let configPath: string;

function writeConfig(config: object): void {
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function savedConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
}

const BASE = {
  tracker: "local",
  name: "demo",
  repos: { app: { checks: "npm test" } },
  agents: { default: "claude", review: { provider: "codex", model: "gpt-5.5" } },
  stages: ["develop", "review", { name: "security", kind: "agent", prompt: ".sandcastle/prompts/security.md", provider: "codex", model: "gpt-5.5-codex" }],
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "stages-editor-"));
  mkdirSync(join(root, ".sandcastle", "prompts"), { recursive: true });
  writeFileSync(join(root, ".sandcastle", "prompts", "security.md"), "Audit {{issue}}.");
  configPath = join(root, ".sandcastle", "config.json");
  writeConfig(BASE);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("stagesViewOf", () => {
  it("lists the chain with each row's agent and the models already in use", () => {
    const view = stagesViewOf(readProjectConfig(configPath));
    expect(view.stages.map((row) => [row.name, row.hasAgent])).toEqual([
      ["develop", true],
      ["review", true],
      ["security", true],
      ["verify", false],
    ]);
    expect(view.stages[1]?.agent).toEqual({ provider: "codex", model: "gpt-5.5" });
    expect(view.stages[0]?.agent).toBeUndefined();
    expect(view.models.codex).toEqual(["gpt-5.5", "gpt-5.5-codex"]);
    expect(view.appliesTo).toBe("new runs");
  });
});

describe("saveAgentEdits", () => {
  it("writes a built-in stage to agents.<role> and keeps every other key", () => {
    saveAgentEdits(configPath, [{ name: "develop", provider: "claude", model: "opus" }]);
    const saved = savedConfig();
    expect(saved["agents"]).toMatchObject({ develop: { provider: "claude", model: "opus" }, review: { provider: "codex", model: "gpt-5.5" } });
    expect(saved["repos"]).toEqual(BASE.repos);
    expect(saved["stages"]).toEqual(BASE.stages);
  });

  it("writes a provider alone as the short form, and clears a stage back to the default", () => {
    saveAgentEdits(configPath, [
      { name: "review", provider: "cursor", model: null },
      { name: "security", provider: null, model: null },
    ]);
    const saved = savedConfig();
    expect((saved["agents"] as Record<string, unknown>)["review"]).toBe("cursor");
    expect((saved["stages"] as Record<string, unknown>[])[2]).toEqual({ name: "security", kind: "agent", prompt: ".sandcastle/prompts/security.md" });
  });

  it("sets provider and model on a custom agent stage's own entry", () => {
    saveAgentEdits(configPath, [{ name: "security", provider: "claude", model: "opus" }]);
    expect((savedConfig()["stages"] as Record<string, unknown>[])[2]).toMatchObject({ provider: "claude", model: "opus" });
  });

  it("refuses a stage that runs no agent, leaving the file untouched", () => {
    const before = readFileSync(configPath, "utf8");
    expect(() => saveAgentEdits(configPath, [{ name: "verify", provider: "claude", model: null }])).toThrow(/no agent to set/);
    expect(() => saveAgentEdits(configPath, [{ name: "nope", provider: "claude", model: null }])).toThrow(/no agent to set/);
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  it("refuses bad edits before anything is written", () => {
    const before = readFileSync(configPath, "utf8");
    expect(() => parseAgentEdits([{ name: "develop", provider: "claude", model: "bad model; rm" }])).toThrow(/plain model name/);
    expect(() => parseAgentEdits([{ name: "develop", provider: "gpt", model: null }])).toThrow(/provider must be/);
    expect(() => parseAgentEdits([])).toThrow(/non-empty/);
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  it("leaves no temp file behind", () => {
    saveAgentEdits(configPath, [{ name: "develop", provider: "claude", model: null }]);
    expect(readdirSync(join(root, ".sandcastle")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("drops an empty agents block instead of writing {}", () => {
    writeConfig({ ...BASE, agents: { review: "codex" } });
    const next = withAgentEdits(savedConfig(), [{ name: "review", provider: null, model: null }]);
    expect("agents" in next).toBe(false);
  });
});
