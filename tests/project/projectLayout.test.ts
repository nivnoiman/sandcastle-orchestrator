import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { configPathFrom, findProjectConfig } from "../../src/project/boot.js";
import { parseProjectConfig, projectRootOf, setActiveProject } from "../../src/project/projectConfig.js";
import { layoutFrom, sandcastleDirFrom } from "../../src/real/paths.js";
import { resolveUiPort } from "../../src/ui/server.js";
import { TEST_PROJECT } from "../setup.js";

const SINGLE_REPO = { hubRepo: "acme/myapp", repos: { myapp: { github: "acme/myapp", checks: "pnpm test" } } };
const ROOT = resolve("/work/myapp");
const CONFIG_PATH = join(ROOT, ".sandcastle", "config.json");

const scratch = mkdtempSync(join(tmpdir(), "sandcastle-layout-"));
const projectDir = join(scratch, "app");
const nestedDir = join(projectDir, "packages", "core", "src");
const configFile = join(projectDir, ".sandcastle", "config.json");
mkdirSync(join(projectDir, ".sandcastle"), { recursive: true });
mkdirSync(nestedDir, { recursive: true });
writeFileSync(configFile, JSON.stringify(SINGLE_REPO));

afterEach(() => setActiveProject(TEST_PROJECT));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("project discovery", () => {
  it("walks up from the invocation dir to the nearest .sandcastle/config.json", () => {
    expect(findProjectConfig(nestedDir)).toBe(configFile);
    expect(findProjectConfig(projectDir)).toBe(configFile);
    expect(configPathFrom([], {}, nestedDir)).toBe(configFile);
    expect(configPathFrom([], { INIT_CWD: nestedDir })).toBe(configFile);
    expect(findProjectConfig(scratch)).toBeUndefined();
  });

  it("accepts --config and SANDCASTLE_CONFIG pointing at the project root or its .sandcastle dir", () => {
    expect(configPathFrom([`--config=${projectDir}`], {}, scratch)).toBe(configFile);
    expect(configPathFrom(["--config=app"], {}, scratch)).toBe(configFile);
    expect(configPathFrom(["--config=app/.sandcastle"], {}, scratch)).toBe(configFile);
    expect(configPathFrom([], { SANDCASTLE_CONFIG: projectDir }, scratch)).toBe(configFile);
    expect(() => configPathFrom([], {}, scratch)).toThrow(/sandcastle init/);
  });
});

describe("project root", () => {
  it("is the folder holding .sandcastle, or the config's own folder outside one", () => {
    expect(projectRootOf(CONFIG_PATH)).toBe(ROOT);
    expect(projectRootOf(resolve("/work/other/custom.json"))).toBe(resolve("/work/other"));
  });

  it("resolves repo paths and stateDir against the project root, not the .sandcastle folder", () => {
    const project = parseProjectConfig(
      {
        hubRepo: "acme/hub",
        stateDir: "../state/hub",
        repos: {
          hub: { github: "acme/hub", checks: "x" },
          api: { github: "acme/api", checks: "x" },
          web: { github: "acme/web", path: "clients/web", checks: "x" },
        },
      },
      CONFIG_PATH,
    );
    expect(project.repos["hub"]?.path).toBe(ROOT);
    expect(project.repos["api"]?.path).toBe(resolve("/work/api"));
    expect(project.repos["web"]?.path).toBe(join(ROOT, "clients", "web"));
    expect(project.stateDir).toBe(resolve("/work/state/hub"));
  });
});

describe("state and worktree defaults", () => {
  it("keeps state in <root>/.sandcastle unless SANDCASTLE_DIR or stateDir say otherwise", () => {
    setActiveProject(parseProjectConfig(SINGLE_REPO, CONFIG_PATH));
    expect(sandcastleDirFrom({})).toBe(join(ROOT, ".sandcastle"));
    expect(sandcastleDirFrom({ SANDCASTLE_DIR: resolve("/elsewhere") })).toBe(resolve("/elsewhere"));
    setActiveProject(parseProjectConfig({ ...SINGLE_REPO, stateDir: "state" }, CONFIG_PATH));
    expect(sandcastleDirFrom({})).toBe(join(ROOT, "state"));
  });

  it("puts agent worktrees under ~/.sandcastle/worktrees/<project>, outside every repo", () => {
    setActiveProject(parseProjectConfig(SINGLE_REPO, CONFIG_PATH));
    const home = resolve("/home/me");
    const layout = layoutFrom(join(ROOT, ".sandcastle"), home);
    expect(layout.worktreesDir).toBe(join(home, ".sandcastle", "worktrees", "myapp"));
    expect(layoutFrom(join(ROOT, ".sandcastle"), home, { worktreesDir: resolve("/wt") }).worktreesDir).toBe(resolve("/wt"));
  });
});

describe("ui.port", () => {
  it("defaults to 7777 and rejects anything that is not a tcp port", () => {
    expect(parseProjectConfig(SINGLE_REPO, CONFIG_PATH).ui).toEqual({ port: 7777 });
    expect(parseProjectConfig({ ...SINGLE_REPO, ui: { port: 7801 } }, CONFIG_PATH).ui).toEqual({ port: 7801 });
    expect(parseProjectConfig({ ...SINGLE_REPO, ui: {} }, CONFIG_PATH).ui).toEqual({ port: 7777 });
    for (const port of [0, 65536, 77.5, "7777"]) {
      expect(() => parseProjectConfig({ ...SINGLE_REPO, ui: { port } }, CONFIG_PATH)).toThrow(/ui.port must be a tcp port/);
    }
    expect(() => parseProjectConfig({ ...SINGLE_REPO, ui: 7777 }, CONFIG_PATH)).toThrow(/ui must be an object/);
  });

  it("takes --port, then SANDCASTLE_UI_PORT, then the config, then 7777", () => {
    expect(resolveUiPort(["1", "--port=8001"], { SANDCASTLE_UI_PORT: "8002" }, 8003)).toBe(8001);
    expect(resolveUiPort(["1"], { SANDCASTLE_UI_PORT: "8002" }, 8003)).toBe(8002);
    expect(resolveUiPort(["1"], { SANDCASTLE_UI_PORT: " " }, 8003)).toBe(8003);
    expect(resolveUiPort([], {})).toBe(7777);
    expect(() => resolveUiPort(["--port=abc"], {}, 8003)).toThrow(/--port="abc" is not a tcp port/);
    expect(() => resolveUiPort([], { SANDCASTLE_UI_PORT: "99999" }, 8003)).toThrow(/SANDCASTLE_UI_PORT/);
  });
});
