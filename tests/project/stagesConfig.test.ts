import { describe, expect, it } from "vitest";
import { parseProjectConfig } from "../../src/project/projectConfig.js";
import { DEFAULT_STAGES, parseStages, type StagesContext } from "../../src/project/stagesConfig.js";

const PROMPTS: Record<string, string> = {
  "/proj/.sandcastle/prompts/security.md": "Audit {{issue}} on {{branch}}.",
  "/proj/.sandcastle/prompts/bad.md": "Use {{secret}} here.",
};

const context: StagesContext = {
  projectRoot: "/proj",
  repos: ["api", "web"],
  readText: (path) => {
    const text = PROMPTS[path.replaceAll("\\", "/").replace(/^[A-Z]:/, "")];
    if (text === undefined) throw new Error("ENOENT");
    return text;
  },
};

const security = { name: "security", kind: "agent", prompt: ".sandcastle/prompts/security.md" };

describe("parseStages", () => {
  it("defaults to today's chain", () => {
    expect(parseStages(undefined, context)).toBe(DEFAULT_STAGES);
    expect(parseStages(["develop", "simplify", "review", "verify"], context)).toEqual(DEFAULT_STAGES);
  });

  it("appends verify when it is left out, and lets simplify and review go", () => {
    expect(parseStages(["develop"], context)).toEqual([
      { kind: "builtin", name: "develop" },
      { kind: "verify", name: "verify" },
    ]);
  });

  it("parses custom agent and command stages in place", () => {
    const stages = parseStages(
      [
        "develop",
        "review",
        { ...security, provider: "codex", model: "gpt-5.5-codex" },
        { name: "e2e", kind: "command", run: { web: "npx playwright test" } },
        { name: "lint", kind: "command", run: "npm run lint" },
      ],
      context,
    );
    expect(stages.map((stage) => stage.name)).toEqual(["develop", "review", "security", "e2e", "lint", "verify"]);
    expect(stages[2]).toMatchObject({
      kind: "agent",

      agent: { provider: "codex", model: "gpt-5.5-codex" },
    });
    expect(stages[2]?.kind === "agent" && stages[2].promptPath.replaceAll("\\", "/")).toMatch(/\/proj\/.sandcastle\/prompts\/security.md$/);
    expect(stages[3]).toEqual({ kind: "command", name: "e2e", run: { web: "npx playwright test" } });
    expect(stages[4]).toEqual({ kind: "command", name: "lint", run: "npm run lint" });
  });

  it("defaults a custom agent stage's agent to agents.default", () => {
    expect(parseStages(["develop", security], context)[1]).toMatchObject({ agent: undefined });
  });

  it.each([
    [[], /stages must be a non-empty list/],
    [["simplify", "develop"], /stages must start with "develop"/],
    [["develop", "verify", "review"], /"verify" must be the last stage/],
    [["develop", "review", "review"], /names "review" more than once/],
    [["develop", "lint"], /"lint" is not a built-in stage/],
    [["develop", { name: "Security", kind: "agent", prompt: "x" }], /name must be lower-case kebab/],
    [["develop", { name: "polish", kind: "command", run: "x" }], /"polish" is reserved/],
    [["develop", { name: "in-review", kind: "command", run: "x" }], /"in-review" is reserved/],
    [["develop", { name: "a".repeat(31), kind: "command", run: "x" }], /longer than 30 characters/],
    [["develop", { name: "x", kind: "script", run: "x" }], /kind must be "agent" or "command"/],
    [["develop", { name: "x", kind: "agent" }], /stages\[1\].prompt must be a non-empty string/],
    [["develop", { name: "x", kind: "agent", prompt: "missing.md" }], /stages\[1\].prompt: cannot read/],
    [["develop", { name: "x", kind: "agent", prompt: ".sandcastle/prompts/bad.md" }], /unknown placeholder \{\{secret\}\}/],
    [["develop", { ...security, model: "gpt-5" }], /model needs a "provider"/],
    [["develop", { ...security, provider: "gemini" }], /provider must be one of/],
    [["develop", { ...security, after: "review" }], /stages\[1\].after is not a setting/],
    [["develop", { name: "x", kind: "command", run: "" }], /run must not be empty/],
    [["develop", { name: "x", kind: "command", run: { mobile: "x" } }], /run.mobile names a repo that is not under repos/],
    [["develop", { name: "x", kind: "command", run: { web: 3 } }], /run.web must be a non-empty command/],
  ])("rejects %j", (raw, message) => {
    expect(() => parseStages(raw, context)).toThrow(message);
  });
});

describe("stages in the project config", () => {
  const base = {
    hubRepo: "example-org/hub",
    repos: { api: { github: "example-org/api", checks: "npm test" } },
  };

  it("defaults to the built-in chain", () => {
    expect(parseProjectConfig(base, "/proj/.sandcastle/config.json").stages).toBe(DEFAULT_STAGES);
  });

  it("parses a command stage against the config's repos", () => {
    const config = parseProjectConfig(
      { ...base, stages: ["develop", { name: "lint", kind: "command", run: { api: "npm run lint" } }] },
      "/proj/.sandcastle/config.json",
    );
    expect(config.stages.map((stage) => stage.name)).toEqual(["develop", "lint", "verify"]);
  });

  it("rejects provider settings for a custom stage under agents", () => {
    expect(() =>
      parseProjectConfig(
        { ...base, stages: ["develop", { name: "lint", kind: "command", run: "npm run lint" }], agents: { lint: "codex" } },
        "/proj/.sandcastle/config.json",
      ),
    ).toThrow(/agents.lint names a custom stage — put "provider" and "model" on its entry under stages/);
  });
});
