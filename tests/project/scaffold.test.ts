import { describe, expect, it } from "vitest";
import { parseProjectConfig } from "../../src/project/projectConfig.js";
import {
  buildInitConfig,
  detectPackageManager,
  firstFreePort,
  guessRepoCommands,
  hubFromRemote,
  NO_CHECKS,
  repoNameFrom,
  STATE_GITIGNORE,
} from "../../src/project/scaffold.js";

const ALL_SCRIPTS = { typecheck: "tsc", test: "vitest", build: "vite build", lint: "eslint" };

describe("sandcastle init scaffolding", () => {
  it("picks the package manager from the lockfile", () => {
    const has = (...files: string[]) => (name: string) => files.includes(name);
    expect(detectPackageManager(has("pnpm-lock.yaml", "package-lock.json"))).toBe("pnpm");
    expect(detectPackageManager(has("yarn.lock"))).toBe("yarn");
    expect(detectPackageManager(has("package-lock.json"))).toBe("npm");
    expect(detectPackageManager(has())).toBeUndefined();
  });

  it("guesses bootstrap and checks from the scripts that exist", () => {
    expect(guessRepoCommands("pnpm", ALL_SCRIPTS)).toEqual({
      bootstrap: "pnpm install --frozen-lockfile",
      checks: "pnpm typecheck && pnpm test && pnpm build",
    });
    expect(guessRepoCommands("npm", { test: "jest", build: "tsc" })).toEqual({ bootstrap: "npm ci", checks: "npm run test && npm run build" });
    expect(guessRepoCommands("yarn", { test: "jest" })).toEqual({ bootstrap: "yarn install --frozen-lockfile", checks: "yarn test" });
    expect(guessRepoCommands("yarn", { test: "jest" }, true).bootstrap).toBe("yarn install --immutable");
    expect(guessRepoCommands("npm", { lint: "eslint" })).toEqual({ bootstrap: "npm ci", checks: NO_CHECKS });
    expect(guessRepoCommands(undefined, ALL_SCRIPTS)).toEqual({ bootstrap: "", checks: NO_CHECKS });
  });

  it("reads owner/name from github remotes", () => {
    expect(hubFromRemote("git@github.com:acme/my-app.git")).toBe("acme/my-app");
    expect(hubFromRemote("https://github.com/acme/my-app.git\n")).toBe("acme/my-app");
    expect(hubFromRemote("https://github.com/acme/my.app")).toBe("acme/my.app");
    expect(hubFromRemote("https://gitlab.com/acme/my-app.git")).toBeUndefined();
  });

  it("builds a config the parser accepts, naming the repo in lower kebab", () => {
    expect(repoNameFrom("acme/My_App.v2")).toBe("my-app-v2");
    const raw = buildInitConfig({ hubRepo: "acme/My_App", commands: { bootstrap: "npm ci", checks: "npm test" }, port: 7781 });
    expect(raw).toEqual({
      name: "my-app",
      hubRepo: "acme/My_App",
      integrationBase: "dev",
      repos: { "my-app": { github: "acme/My_App", bootstrap: "npm ci", checks: "npm test" } },
      verify: { strategy: "command" },
      ui: { port: 7781 },
    });
    const project = parseProjectConfig(raw, "/work/app/.sandcastle/config.json");
    expect(project.ui.port).toBe(7781);
    expect(project.verify).toEqual({ strategy: "command", commands: {}, agent: true });
    expect(buildInitConfig({ hubRepo: "acme/app", commands: { bootstrap: "", checks: "x" }, port: 7777 })).not.toHaveProperty("name");
  });

  it("takes the first free port from 7777 upward", async () => {
    const busy = new Set([7777, 7778]);
    expect(await firstFreePort(async (port) => !busy.has(port))).toBe(7779);
    await expect(firstFreePort(async () => false, 65534)).rejects.toThrow(/--port/);
  });

  it("ignores everything in .sandcastle but the config", () => {
    expect(STATE_GITIGNORE.split("\n").filter(Boolean)).toEqual(["*", "!.gitignore", "!config.json"]);
  });
});
