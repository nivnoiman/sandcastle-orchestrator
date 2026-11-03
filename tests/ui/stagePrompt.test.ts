import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readProjectConfig, setActiveProject } from "../../src/project/projectConfig.js";
import { StagePromptError, stagePromptOf } from "../../src/ui/stagePrompt.js";

let base: string;
let root: string;
let configPath: string;

const REPOS = { tracker: "local", name: "demo", repos: { app: { checks: "npm test" } } };

function write(config: object): void {
  writeFileSync(configPath, JSON.stringify(config));
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "stage-prompt-"));
  root = join(base, "project");
  mkdirSync(join(root, ".sandcastle", "prompts"), { recursive: true });
  writeFileSync(join(root, ".sandcastle", "prompts", "docs.md"), "Update docs for {{title}}");
  writeFileSync(join(base, "secret.md"), "outside the project");
  configPath = join(root, ".sandcastle", "config.json");
  write({ ...REPOS, stages: ["develop", "simplify", "review", { name: "docs", kind: "agent", prompt: ".sandcastle/prompts/docs.md" }, { name: "lint", kind: "command", run: "npm run lint" }] });
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

function prompt(name: string) {
  const project = readProjectConfig(configPath);
  setActiveProject(project);
  return stagePromptOf(project, name);
}

function refusal(name: string): StagePromptError {
  try {
    prompt(name);
  } catch (cause) {
    if (cause instanceof StagePromptError) return cause;
    throw cause;
  }
  throw new Error("expected a refusal");
}

describe("stagePromptOf", () => {
  it("returns the engine built-in prompt for develop, simplify and review, labelled built-in", () => {
    expect(prompt("develop")).toMatchObject({ source: "built-in", name: "develop" });
    expect(prompt("develop").text).toContain("Implement sub-issue");
    expect(prompt("simplify").text).toContain("Simplify the implementation");
    expect(prompt("review").text).toContain("Review the simplified implementation");
  });

  it("returns a custom stage prompt file as on disk, with a project-relative path", () => {
    expect(prompt("docs")).toMatchObject({ source: "file", text: "Update docs for {{title}}", path: ".sandcastle/prompts/docs.md" });
  });

  it("carries no credential or env value", () => {
    process.env["GH_TOKEN"] = "ghp_supersecret";
    try {
      expect(prompt("develop").text).not.toContain("ghp_supersecret");
    } finally {
      delete process.env["GH_TOKEN"];
    }
  });

  it("refuses names that are not stages, including traversal, and stages with no prompt", () => {
    expect(refusal("../../secret").status).toBe(404);
    expect(refusal("..\\secret.md").status).toBe(404);
    expect(refusal("missing").status).toBe(404);
    expect(refusal("lint").status).toBe(400);
    expect(refusal("verify").status).toBe(400);
  });

  it("refuses a prompt file that resolves outside the project root", () => {
    write({ ...REPOS, stages: ["develop", { name: "leak", kind: "agent", prompt: "../secret.md" }] });
    expect(refusal("leak")).toMatchObject({ status: 400, message: expect.stringContaining("outside the project") });
  });

  it("refuses a symlink that points outside the project", () => {
    try {
      symlinkSync(join(base, "secret.md"), join(root, ".sandcastle", "prompts", "link.md"));
    } catch {
      return;
    }
    write({ ...REPOS, stages: ["develop", { name: "link", kind: "agent", prompt: ".sandcastle/prompts/link.md" }] });
    expect(refusal("link").status).toBe(400);
  });
});
