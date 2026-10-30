import { mkdirSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activeProject, readProjectConfig, setActiveProject } from "../../src/project/projectConfig.js";
import { UiController } from "../../src/ui/controller.js";
import { dryRunSession } from "../../src/ui/sessions.js";
import { startUiServer, type UiServer } from "../../src/ui/server.js";
import { defaultStagesRouteDeps } from "../../src/ui/stagesRoutes.js";
import { snapshot } from "../fixtures.js";

let server: UiServer | undefined;
let root: string;
let configPath: string;

const DEVELOP = { kind: "builtin", name: "develop", provider: null, model: null };
const SIMPLIFY = { kind: "builtin", name: "simplify", provider: null, model: null };
const VERIFY = { kind: "verify", name: "verify" };
const BASE = { tracker: "local", name: "demo", repos: { app: { checks: "npm test" } } };

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "stages-routes-"));
  mkdirSync(join(root, ".sandcastle"));
  configPath = join(root, ".sandcastle", "config.json");
  writeFileSync(configPath, JSON.stringify(BASE));
  setActiveProject(readProjectConfig(configPath));
  const controller = new UiController({
    mode: "dry",
    hubRepo: "example-org/hub",
    startCap: 1,
    listParents: () => Promise.resolve([]),
    loadSnapshot: () => Promise.resolve(snapshot()),
    startSession: (request) => dryRunSession(request, { now: () => 0, delayMs: () => 1000 }),
    now: () => new Date("2026-08-15T09:00:00.000Z"),
  });
  server = await startUiServer(controller, 0, undefined, undefined, undefined, defaultStagesRouteDeps(configPath));
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  rmSync(root, { recursive: true, force: true });
});

interface Reply {
  status: number;
  json: { ok: boolean; result?: { stages: { name: string; agent?: unknown }[] }; error?: string };
}

async function call(method: string, path: string, body?: unknown): Promise<Reply> {
  const response = await fetch(`${server?.url}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-sandcastle": "1" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: (await response.json()) as Reply["json"] };
}

describe("/api/stages", () => {
  it("reads the chain from the file", async () => {
    const { status, json } = await call("GET", "/api/stages");
    expect(status).toBe(200);
    expect(json.result?.stages.map((row) => row.name)).toEqual(["develop", "simplify", "review", "verify"]);
  });

  it("saves an edit, activates it for new runs and shows it on the next read", async () => {
    const saved = await call("PUT", "/api/stages", { stages: [DEVELOP, SIMPLIFY, { kind: "builtin", name: "review", provider: "codex", model: "gpt-5.5" }, VERIFY] });
    expect(saved.status).toBe(200);
    expect(activeProject().agents.roles.review).toEqual({ provider: "codex", model: "gpt-5.5" });
    const read = await call("GET", "/api/stages");
    expect(read.json.result?.stages.find((row) => row.name === "review")?.agent).toEqual({ provider: "codex", model: "gpt-5.5" });
  });

  it("answers 400 with the validation message and changes nothing", async () => {
    const refused = await call("PUT", "/api/stages", { stages: [DEVELOP, { kind: "agent", name: "docs", prompt: "Use {{secret}}" }, VERIFY] });
    expect(refused.status).toBe(400);
    expect(refused.json.error).toMatch(/unknown placeholder/);
    expect(activeProject().agents.roles).toEqual({});
  });

  it("adds an agent stage with its prompt file and activates it for new runs", async () => {
    const saved = await call("PUT", "/api/stages", { stages: [DEVELOP, { kind: "agent", name: "docs", prompt: "Update docs for {{title}}", provider: "claude", model: "opus" }, VERIFY] });
    expect(saved.status).toBe(200);
    expect(activeProject().stages.map((stage) => stage.name)).toEqual(["develop", "docs", "verify"]);
    expect(readFileSync(join(root, ".sandcastle", "prompts", "docs.md"), "utf8")).toBe("Update docs for {{title}}");
  });

  it("refuses a write without the sandcastle header", async () => {
    const response = await fetch(`${server?.url}/api/stages/agents`, { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" });
    expect(response.status).toBe(403);
  });

  it("reload picks up a hand edit of the file for new runs", async () => {
    writeFileSync(configPath, JSON.stringify({ ...BASE, stages: ["develop"] }));
    const reloaded = await call("POST", "/api/stages/reload");
    expect(reloaded.json.result?.stages.map((row) => row.name)).toEqual(["develop", "verify"]);
    expect(activeProject().stages.map((stage) => stage.name)).toEqual(["develop", "verify"]);
  });

  it("reload leaves everything but agents and stages as the running server booted with", async () => {
    writeFileSync(configPath, JSON.stringify({ ...BASE, integrationBase: "elsewhere", stages: ["develop"] }));
    await call("POST", "/api/stages/reload");
    expect(activeProject().integrationBase).toBe("dev");
  });
});
