import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRunModel } from "../../src/model/runModel.js";
import { configPathFrom } from "../../src/project/boot.js";
import {
  claudeProjectSlug,
  integrationBase,
  knownRepos,
  parseProjectConfig,
  repoSlug,
  setActiveProject,
} from "../../src/project/projectConfig.js";
import { containerPrefix, isOrchestratorContainer, stageContainerName } from "../../src/real/docker.js";
import { memoryProjectSuffix } from "../../src/real/paths.js";
import { TEST_PROJECT } from "../setup.js";

const CONFIG_PATH = resolve("/work/myapp/sandcastle.config.json");

const SINGLE_REPO = {
  hubRepo: "acme/myapp",
  repos: { myapp: { github: "acme/myapp", bootstrap: "pnpm install --frozen-lockfile", checks: "pnpm test" } },
  verify: { strategy: "command", commands: { myapp: "pnpm test && pnpm zip" } },
};

afterEach(() => setActiveProject(TEST_PROJECT));

describe("parseProjectConfig", () => {
  it("defaults a single-repo project to the config's own folder, dev as base and the hub's name", () => {
    const project = parseProjectConfig(SINGLE_REPO, CONFIG_PATH);
    expect(project.name).toBe("myapp");
    expect(project.integrationBase).toBe("dev");
    expect(project.imageTag).toBe("sandcastle:latest");
    expect(project.repos["myapp"]?.path).toBe(dirname(CONFIG_PATH));
    expect(project.verify).toEqual({ strategy: "command", commands: { myapp: "pnpm test && pnpm zip" }, agent: true });
  });

  it("puts a separate service repo next to the hub checkout unless a path is given", () => {
    const project = parseProjectConfig(
      { hubRepo: "acme/hub", repos: { api: { github: "acme/api", checks: "npm test" }, web: { github: "acme/web", path: "/src/web", checks: "npm test" } } },
      CONFIG_PATH,
    );
    expect(project.repos["api"]?.path).toBe(resolve("/work/api"));
    expect(project.repos["web"]?.path).toBe(resolve("/src/web"));
    expect(project.verify).toEqual({ strategy: "none" });
  });

  it("fails fast on a config that cannot work", () => {
    expect(() => parseProjectConfig({ hubRepo: "nope", repos: {} }, CONFIG_PATH)).toThrow(/owner\/name/);
    expect(() => parseProjectConfig({ hubRepo: "a/b", repos: {} }, CONFIG_PATH)).toThrow(/at least one repo/);
    expect(() => parseProjectConfig({ hubRepo: "a/b", repos: { Api: { github: "a/api", checks: "x" } } }, CONFIG_PATH)).toThrow(/kebab/);
    expect(() => parseProjectConfig({ hubRepo: "a/b", repos: { api: { github: "a/api" } } }, CONFIG_PATH)).toThrow(/checks is required/);
    expect(() =>
      parseProjectConfig({ ...SINGLE_REPO, verify: { strategy: "command", commands: { other: "x" } } }, CONFIG_PATH),
    ).toThrow(/not under repos/);
    expect(() => parseProjectConfig({ ...SINGLE_REPO, verify: { strategy: "compose", services: {} } }, CONFIG_PATH)).toThrow(
      /verify.services.myapp is missing/,
    );
    expect(() => parseProjectConfig({ ...SINGLE_REPO, verify: { strategy: "magic" } }, CONFIG_PATH)).toThrow(/verify.strategy/);
    expect(() => parseProjectConfig({ ...SINGLE_REPO, verify: { strategy: "command", commands: { myapp: " " } } }, CONFIG_PATH)).toThrow(
      /verify.commands.myapp is empty/,
    );
    expect(() => parseProjectConfig({ hubRepo: "acme/My.App", repos: SINGLE_REPO.repos }, CONFIG_PATH)).toThrow(/set "name"/);
  });

  it("rejects compose env placeholders that cannot resolve", () => {
    const compose = (env: Record<string, string>, extra: Record<string, unknown> = {}) => ({
      ...SINGLE_REPO,
      verify: { strategy: "compose", services: { myapp: { build: "b", serve: "s", port: 3000, env } }, ...extra },
    });
    expect(() => parseProjectConfig(compose({ DB: "{{mongoUri}}" }), CONFIG_PATH)).toThrow(/verify.mongo is off/);
    expect(() => parseProjectConfig(compose({ API: "{{url:api}}" }), CONFIG_PATH)).toThrow(/"api" has no compose service/);
    expect(() => parseProjectConfig(compose({ X: "{{host}}" }), CONFIG_PATH)).toThrow(/unknown placeholder/);
    expect(() => parseProjectConfig(compose({}, { services: { myapp: {}, api: {} } }), CONFIG_PATH)).toThrow(/api names a repo/);
    expect(parseProjectConfig(compose({ DB: "{{mongoUri}}", P: "{{port}}" }, { mongo: true }), CONFIG_PATH).verify.strategy).toBe("compose");
  });

  it("reads compose services with their env templates and an optional mongo", () => {
    const project = parseProjectConfig(
      {
        ...SINGLE_REPO,
        verify: { strategy: "compose", mongo: true, services: { myapp: { build: "b", serve: "s", port: 3000, env: { API: "{{url:myapp}}" } } } },
      },
      CONFIG_PATH,
    );
    expect(project.verify).toEqual({
      strategy: "compose",
      mongoImage: "mongo:7",
      externalProviders: [],
      services: { myapp: { build: "b", seed: "", serve: "s", port: 3000, healthPath: "/", env: { API: "{{url:myapp}}" } } },
    });
  });
});

describe("the active project", () => {
  it("drives repo names, slugs, and the integration base", () => {
    setActiveProject(parseProjectConfig({ ...SINGLE_REPO, integrationBase: "main" }, CONFIG_PATH));
    expect(knownRepos()).toEqual(["myapp"]);
    expect(repoSlug("myapp")).toBe("acme/myapp");
    expect(integrationBase()).toBe("main");
    expect(() => repoSlug("api")).toThrow(/not a repo of project myapp/);
  });

  it("accepts work items labelled with the project's repos and rejects the rest", () => {
    setActiveProject(parseProjectConfig(SINGLE_REPO, CONFIG_PATH));
    const snapshot = {
      repo: "acme/myapp",
      parent: {
        number: 1,
        title: "Spec",
        body: "```yaml\nsandcastle: v1\nfeature: myapp-v1\n```",
        labels: ["sandcastle"],
        state: "OPEN" as const,
      },
      subIssues: [
        { number: 2, title: "a", body: "", labels: ["repo:myapp", "ready-for-agent"], state: "OPEN" as const, blockedBy: [] },
        { number: 3, title: "b", body: "", labels: ["repo:myapp", "ready-for-human"], state: "OPEN" as const, blockedBy: [2] },
      ],
    };
    const result = loadRunModel(snapshot);
    expect(result.ok && result.model.items.map((item) => [item.number, item.admission])).toEqual([
      [2, "queued"],
      [3, "held"],
    ]);

    const foreign = { ...snapshot, subIssues: [{ ...snapshot.subIssues[0]!, labels: ["repo:api", "ready-for-agent"] }] };
    const rejected = loadRunModel(foreign);
    expect(rejected.ok).toBe(false);
    expect(!rejected.ok && rejected.errors[0]).toMatch(/unknown target repo "api" \(known: myapp\)/);
  });

  it("namespaces docker objects by project so two projects never collect each other's containers", () => {
    expect(containerPrefix()).toBe("sc-demo-");
    expect(isOrchestratorContainer(stageContainerName("develop", 17, "abc"))).toBe(true);
    setActiveProject(parseProjectConfig(SINGLE_REPO, CONFIG_PATH));
    expect(isOrchestratorContainer("sc-demo-develop-17-abc")).toBe(false);
    expect(isOrchestratorContainer("sandcastle-develop-17-abc")).toBe(false);
    expect(stageContainerName("develop", 17, "abc")).toBe("sc-myapp-develop-17-abc");
  });

  it("derives the memory folder Claude Code uses for the project folder, unless one is named", () => {
    setActiveProject(parseProjectConfig(SINGLE_REPO, CONFIG_PATH));
    expect(memoryProjectSuffix()).toBe(join("projects", claudeProjectSlug(dirname(CONFIG_PATH)), "memory"));
    if (process.platform === "win32") expect(claudeProjectSlug("C:\\src\\my-app")).toBe("C--src-my-app");
    else expect(claudeProjectSlug("/src/my-app")).toBe("-src-my-app");
    setActiveProject(TEST_PROJECT);
    expect(memoryProjectSuffix()).toBe(join("projects", "demo-project", "memory"));
  });
});

describe("configPathFrom", () => {
  it("prefers --config, then SANDCASTLE_CONFIG", () => {
    expect(configPathFrom(["1", "--config=/x/sandcastle.config.json"], { SANDCASTLE_CONFIG: "/y" })).toBe(resolve("/x/sandcastle.config.json"));
    expect(configPathFrom(["1"], { SANDCASTLE_CONFIG: "/y" })).toBe(resolve("/y"));
    expect(() => configPathFrom([], {}, "/nowhere-at-all")).toThrow(/--config/);
  });

  it("resolves a relative path against where npm was invoked and rejects --config without a value", () => {
    expect(configPathFrom(["--config=app/sandcastle.config.json"], { INIT_CWD: resolve("/home/me") })).toBe(
      resolve("/home/me/app/sandcastle.config.json"),
    );
    expect(() => configPathFrom(["--config", "x.json"], {})).toThrow(/needs a value/);
    expect(() => configPathFrom(["--config="], {})).toThrow(/empty/);
  });
});
