import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readProjectConfig } from "../../src/project/projectConfig.js";
import { parseStageEdits, saveStageEdits, stagesViewOf, type StageEdit } from "../../src/project/stagesEditor.js";

let root: string;
let configPath: string;

function writeConfig(config: object): void {
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function savedConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
}

function promptFile(name: string): string {
  return readFileSync(join(root, ".sandcastle", "prompts", `${name}.md`), "utf8");
}

const BASE = {
  tracker: "local",
  name: "demo",
  repos: { app: { checks: "npm test" } },
  agents: { default: "claude", review: { provider: "codex", model: "gpt-5.5" } },
  stages: ["develop", "review", { name: "security", kind: "agent", prompt: ".sandcastle/prompts/security.md", provider: "codex", model: "gpt-5.5-codex" }],
};

const develop: StageEdit = { kind: "builtin", name: "develop", provider: null, model: null };
const review: StageEdit = { kind: "builtin", name: "review", provider: "codex", model: "gpt-5.5" };
const security: StageEdit = { kind: "agent", name: "security", prompt: "Audit {{issue}}.", provider: "codex", model: "gpt-5.5-codex" };
const verify: StageEdit = { kind: "verify", name: "verify" };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "stages-editor-"));
  mkdirSync(join(root, ".sandcastle", "prompts"), { recursive: true });
  writeFileSync(join(root, ".sandcastle", "prompts", "security.md"), "Audit {{issue}}.");
  configPath = join(root, ".sandcastle", "config.json");
  writeConfig(BASE);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("stagesViewOf", () => {
  it("lists the chain with agents, prompt text, missing built-ins and the models already in use", () => {
    const view = stagesViewOf(readProjectConfig(configPath));
    expect(view.stages.map((row) => [row.name, row.hasAgent])).toEqual([
      ["develop", true],
      ["review", true],
      ["security", true],
      ["verify", false],
    ]);
    expect(view.stages[1]?.agent).toEqual({ provider: "codex", model: "gpt-5.5" });
    expect(view.stages[2]).toMatchObject({ promptText: "Audit {{issue}}.", promptPath: ".sandcastle/prompts/security.md" });
    expect(view.missingBuiltins).toEqual(["simplify"]);
    expect(view.models.codex).toEqual(["gpt-5.5", "gpt-5.5-codex"]);
    expect(view.appliesTo).toBe("new runs");
  });
});

describe("saveStageEdits", () => {
  it("changes a built-in's model through agents.<role> and keeps every other key", () => {
    saveStageEdits(configPath, [{ ...develop, provider: "claude", model: "opus" }, review, security, verify]);
    const saved = savedConfig();
    expect(saved["agents"]).toMatchObject({ develop: { provider: "claude", model: "opus" }, review: { provider: "codex", model: "gpt-5.5" } });
    expect(saved["repos"]).toEqual(BASE.repos);
    expect(saved["stages"]).toEqual([...BASE.stages, "verify"]);
  });

  it("adds an agent stage with its prompt file, a command stage, and orders them as sent", () => {
    saveStageEdits(configPath, [
      develop,
      { kind: "agent", name: "docs", prompt: "Update docs for {{title}}", provider: "claude", model: "opus" },
      review,
      { kind: "command", name: "lint", run: "npm run lint" },
      verify,
    ]);
    const saved = savedConfig();
    expect(saved["stages"]).toEqual([
      "develop",
      { name: "docs", kind: "agent", prompt: ".sandcastle/prompts/docs.md", provider: "claude", model: "opus" },
      "review",
      { name: "lint", kind: "command", run: "npm run lint" },
      "verify",
    ]);
    expect(promptFile("docs")).toBe("Update docs for {{title}}");
  });

  it("edits an existing prompt in place and drops a removed stage, leaving its file", () => {
    saveStageEdits(configPath, [develop, { ...security, prompt: "New method for {{branch}}" }, verify]);
    expect(promptFile("security")).toBe("New method for {{branch}}");
    saveStageEdits(configPath, [develop, verify]);
    expect(savedConfig()["stages"]).toEqual(["develop", "verify"]);
    expect(promptFile("security")).toBe("New method for {{branch}}");
  });

  it("removes a built-in such as review", () => {
    saveStageEdits(configPath, [develop, verify]);
    expect(savedConfig()["stages"]).toEqual(["develop", "verify"]);
  });

  it("clears a stage's agent back to the default", () => {
    saveStageEdits(configPath, [develop, { ...review, provider: null, model: null }, { ...security, provider: null, model: null }, verify]);
    const saved = savedConfig();
    expect(saved["agents"]).toEqual({ default: "claude" });
    expect((saved["stages"] as Record<string, unknown>[])[2]).toEqual({ name: "security", kind: "agent", prompt: ".sandcastle/prompts/security.md" });
  });

  it("keeps a per-repo command map as it was", () => {
    saveStageEdits(configPath, [develop, { kind: "command", name: "e2e", run: { app: "npx playwright test" } }, verify]);
    expect((savedConfig()["stages"] as unknown[])[1]).toEqual({ name: "e2e", kind: "command", run: { app: "npx playwright test" } });
  });

  it.each([
    ["develop not first", () => [review, develop, verify], /must start with "develop"/],
    ["no develop", () => [review, verify], /must start with "develop"/],
    ["verify not last", () => [develop, verify, review], /"verify" must be the last stage/],
    ["a duplicate name", () => [develop, review, review, verify], /more than once/],
    ["a reserved name", () => [develop, { kind: "command" as const, name: "merged", run: "x" }, verify], /reserved/],
    ["a bad name", () => [develop, { kind: "command" as const, name: "Bad Name", run: "x" }, verify], /lower-case kebab/],
    ["an unknown placeholder", () => [develop, { ...security, prompt: "Use {{secret}}" }, verify], /unknown placeholder/],
    ["a command for an unknown repo", () => [develop, { kind: "command" as const, name: "e2e", run: { nope: "x" } }, verify], /not under repos/],
  ])("refuses %s with the parser's message and writes nothing", (_label, edits, message) => {
    const before = readFileSync(configPath, "utf8");
    const promptBefore = promptFile("security");
    expect(() => saveStageEdits(configPath, edits())).toThrow(message);
    expect(readFileSync(configPath, "utf8")).toBe(before);
    expect(promptFile("security")).toBe(promptBefore);
    expect(readdirSync(join(root, ".sandcastle", "prompts"))).toEqual(["security.md"]);
  });

  it("refuses to rewrite a prompt that lives outside the project", () => {
    writeConfig({ ...BASE, stages: ["develop", { name: "security", kind: "agent", prompt: "../outside.md" }] });
    writeFileSync(join(root, "outside.md"), "old");
    expect(() => saveStageEdits(configPath, [develop, { ...security, prompt: "changed" }, verify])).toThrow(/outside the project/);
    expect(readFileSync(join(root, "outside.md"), "utf8")).toBe("old");
  });

  it("leaves no temp file behind", () => {
    saveStageEdits(configPath, [develop, security, verify]);
    expect(readdirSync(join(root, ".sandcastle")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("parseStageEdits", () => {
  it("refuses malformed rows before anything is read from disk", () => {
    expect(() => parseStageEdits([])).toThrow(/non-empty/);
    expect(() => parseStageEdits([{ kind: "builtin", name: "ship" }])).toThrow(/not a built-in/);
    expect(() => parseStageEdits([{ kind: "builtin", name: "develop", provider: "claude", model: "bad model; rm" }])).toThrow(/plain model name/);
    expect(() => parseStageEdits([{ kind: "builtin", name: "develop", provider: "gpt" }])).toThrow(/provider must be/);
    expect(() => parseStageEdits([{ kind: "agent", name: "x", prompt: "   " }])).toThrow(/prompt must not be empty/);
    expect(() => parseStageEdits([{ kind: "agent", name: "x", prompt: "a".repeat(70000) }])).toThrow(/longer than/);
    expect(() => parseStageEdits([{ kind: "ship", name: "x" }])).toThrow(/kind must be/);
  });
});
