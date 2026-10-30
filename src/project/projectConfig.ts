import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { messageOf } from "../messageOf.js";
import { parseAgents, type AgentsConfig } from "./agentsConfig.js";
import { customStageNames, parseStages, type StageSpec } from "./stagesConfig.js";

/** The per-project folder at the project root: `config.json` (committed) and, by default, the project's state. */
export const PROJECT_FOLDER = ".sandcastle";
export const CONFIG_FILE = "config.json";
/** `.sandcastle/config.json`, for messages. */
export const CONFIG_HINT = `${PROJECT_FOLDER}/${CONFIG_FILE}`;
export const DEFAULT_UI_PORT = 7777;
const DEFAULT_INTEGRATION_BASE = "dev";
const DEFAULT_IMAGE_TAG = "sandcastle:latest";
export const DEFAULT_MONGO_IMAGE = "mongo:7";

const REPO_NAME = /^[a-z0-9][a-z0-9-]*$/;
const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** `{{name}}` or `{{name:arg}}` in a compose service's env. */
export const ENV_PLACEHOLDER = /\{\{\s*([a-zA-Z]+)(?::([a-z0-9-]+))?\s*\}\}/g;
const MONGO_PLACEHOLDERS: ReadonlySet<string> = new Set(["mongoUri", "mongoDb"]);

export interface RepoConfig {
  github: string;
  path: string;
  bootstrap: string;
  checks: string;
}

export interface VerifyService {
  build: string;
  seed: string;
  serve: string;
  port: number;
  healthPath: string;
  env: Record<string, string>;
}

export interface NoVerify {
  strategy: "none";
}

export interface CommandVerify {
  strategy: "command";
  commands: Record<string, string>;
  agent: boolean;
}

export interface ComposeVerify {
  strategy: "compose";
  mongoImage: string | undefined;
  services: Record<string, VerifyService>;
  externalProviders: string[];
}

export type VerifyStrategy = NoVerify | CommandVerify | ComposeVerify;

export interface UiConfig {
  port: number;
}

export type TrackerKind = "github" | "local";
export const DEFAULT_TRACKER: TrackerKind = "github";

export interface ProjectConfig {
  name: string;
  tracker: TrackerKind;
  configPath: string;
  projectRoot: string;
  hubRepo: string;
  integrationBase: string;
  imageTag: string;
  memoryProject: string | undefined;
  stateDir: string | undefined;
  repos: Record<string, RepoConfig>;
  verify: VerifyStrategy;
  ui: UiConfig;
  agents: AgentsConfig;
  stages: readonly StageSpec[];
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(raw: Json, key: string, where: string): string | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${where}.${key} must be a string`);
  return value;
}

function requiredString(raw: Json, key: string, where: string): string {
  const value = optionalString(raw, key, where);
  if (value === undefined || value.trim().length === 0) throw new Error(`${where}.${key} is required`);
  return value;
}

function stringMap(raw: unknown, where: string): Record<string, string> {
  if (raw === undefined) return {};
  if (!isObject(raw) || Object.values(raw).some((value) => typeof value !== "string")) {
    throw new Error(`${where} must map names to strings`);
  }
  return raw as Record<string, string>;
}

export function isRepoSlug(value: string): boolean {
  return SLUG.test(value);
}

function slug(value: string, where: string): string {
  if (!isRepoSlug(value)) throw new Error(`${where} must be "owner/name", got "${value}"`);
  return value;
}

/** The directory holding `.sandcastle/`; a config file outside a `.sandcastle` folder roots the project at its own folder. */
export function projectRootOf(configPath: string): string {
  const configDir = dirname(resolve(configPath));
  return basename(configDir) === PROJECT_FOLDER ? dirname(configDir) : configDir;
}

export function isTcpPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

/** A TCP port (1–65535), or an error naming where the bad value came from. */
export function tcpPort(value: unknown, where: string): number {
  if (!isTcpPort(value)) {
    throw new Error(`${where} must be a tcp port (1-65535), got ${JSON.stringify(value)}`);
  }
  return value;
}

/** Claude Code's per-project folder name: every non-alphanumeric character becomes "-". */
export function claudeProjectSlug(path: string): string {
  return resolve(path).replace(/[^A-Za-z0-9]/g, "-");
}

function parseRepo(name: string, raw: unknown, projectRoot: string, hubRepo: string, tracker: TrackerKind): RepoConfig {
  const where = `repos.${name}`;
  if (!REPO_NAME.test(name)) throw new Error(`${where}: repo names are lower-case kebab (they become repo:<name> labels)`);
  if (!isObject(raw)) throw new Error(`${where} must be an object`);
  const github =
    tracker === "local" && raw["github"] === undefined
      ? localRepoSlug(name)
      : slug(requiredString(raw, "github", where), `${where}.github`);
  const rawPath = optionalString(raw, "path", where) ?? (github === hubRepo ? "." : join("..", name));
  return {
    github,
    path: resolve(projectRoot, rawPath),
    bootstrap: optionalString(raw, "bootstrap", where) ?? "",
    checks: requiredString(raw, "checks", where),
  };
}

function parseService(repo: string, raw: unknown): VerifyService {
  const where = `verify.services.${repo}`;
  if (!isObject(raw)) throw new Error(`${where} must be an object`);
  const port = tcpPort(raw["port"], `${where}.port`);
  return {
    build: requiredString(raw, "build", where),
    seed: optionalString(raw, "seed", where) ?? "",
    serve: requiredString(raw, "serve", where),
    port,
    healthPath: optionalString(raw, "healthPath", where) ?? "/",
    env: stringMap(raw["env"], `${where}.env`),
  };
}

function assertPlaceholders(
  repo: string,
  env: Readonly<Record<string, string>>,
  services: Readonly<Record<string, VerifyService>>,
  mongoEnabled: boolean,
): void {
  for (const [key, value] of Object.entries(env)) {
    const where = `verify.services.${repo}.env.${key}`;
    for (const [match, name, arg] of value.matchAll(ENV_PLACEHOLDER)) {
      if (name === "port") continue;
      if (name !== undefined && MONGO_PLACEHOLDERS.has(name)) {
        if (!mongoEnabled) throw new Error(`${where} uses ${match} but verify.mongo is off — set "mongo": true or drop the key`);
        continue;
      }
      if (name === "url" && arg !== undefined) {
        if (!services[arg]) throw new Error(`${where} uses ${match} but "${arg}" has no compose service`);
        continue;
      }
      throw new Error(`${where} has unknown placeholder ${match} — use {{port}}, {{mongoUri}}, {{mongoDb}} or {{url:<repo>}}`);
    }
  }
}

/** The stand-in "owner/name" of a repo (or hub) that has no GitHub home under the local tracker. */
export function localRepoSlug(name: string): string {
  return `local/${name}`;
}

function parseTracker(raw: unknown): TrackerKind {
  if (raw === undefined) return DEFAULT_TRACKER;
  if (raw === "github" || raw === "local") return raw;
  throw new Error(`tracker must be "github" or "local", got ${JSON.stringify(raw)}`);
}

function parseVerify(raw: unknown, repos: Record<string, RepoConfig>): VerifyStrategy {
  if (raw === undefined) return { strategy: "none" };
  if (!isObject(raw)) throw new Error("verify must be an object");
  const strategy = raw["strategy"];
  if (strategy === "none") return { strategy };
  if (strategy === "command") {
    const commands = stringMap(raw["commands"], "verify.commands");
    for (const [repo, command] of Object.entries(commands)) {
      if (!repos[repo]) throw new Error(`verify.commands.${repo} names a repo that is not under repos`);
      if (command.trim().length === 0) throw new Error(`verify.commands.${repo} is empty — drop it to fall back to repos.${repo}.checks`);
    }
    const agent = raw["agent"] ?? true;
    if (typeof agent !== "boolean") throw new Error("verify.agent must be true or false");
    return { strategy, commands, agent };
  }
  if (strategy === "compose") {
    const rawServices = raw["services"];
    if (!isObject(rawServices)) throw new Error("verify.services must map every repo to its service");
    for (const repo of Object.keys(rawServices)) {
      if (!repos[repo]) throw new Error(`verify.services.${repo} names a repo that is not under repos`);
    }
    const services: Record<string, VerifyService> = {};
    for (const repo of Object.keys(repos)) {
      const service = rawServices[repo];
      if (service === undefined) throw new Error(`verify.services.${repo} is missing — compose brings up every repo`);
      services[repo] = parseService(repo, service);
    }
    const providers = raw["externalProviders"] ?? [];
    if (!Array.isArray(providers) || providers.some((entry) => typeof entry !== "string")) {
      throw new Error("verify.externalProviders must be a list of names");
    }
    const mongo = raw["mongo"];
    if (mongo !== undefined && typeof mongo !== "boolean" && typeof mongo !== "string") {
      throw new Error('verify.mongo must be true, false or an image like "mongo:7"');
    }
    const mongoImage = mongo === false || mongo === undefined ? undefined : mongo === true ? DEFAULT_MONGO_IMAGE : mongo;
    if (mongoImage !== undefined && repos["mongo"]) throw new Error('a repo named "mongo" clashes with the verify mongo container — rename it');
    for (const [repo, service] of Object.entries(services)) assertPlaceholders(repo, service.env, services, mongoImage !== undefined);
    return { strategy, mongoImage, services, externalProviders: providers as string[] };
  }
  throw new Error(`verify.strategy must be "none", "command" or "compose", got ${JSON.stringify(strategy)}`);
}

function parseUi(raw: unknown): UiConfig {
  if (raw === undefined) return { port: DEFAULT_UI_PORT };
  if (!isObject(raw)) throw new Error("ui must be an object");
  const port = raw["port"];
  return { port: port === undefined ? DEFAULT_UI_PORT : tcpPort(port, "ui.port") };
}

export function parseProjectConfig(raw: unknown, configPath: string, readText?: (path: string) => string): ProjectConfig {
  if (!isObject(raw)) throw new Error(`${configPath} must hold a JSON object`);
  const projectRoot = projectRootOf(configPath);
  const tracker = parseTracker(raw["tracker"]);
  const explicitName = optionalString(raw, "name", "config");
  const rawHubRepo = tracker === "local" ? optionalString(raw, "hubRepo", "config") : requiredString(raw, "hubRepo", "config");
  const hubRepo = rawHubRepo === undefined ? localRepoSlug(explicitName ?? repoNameOfDir(projectRoot)) : slug(rawHubRepo, "hubRepo");
  if (!isObject(raw["repos"]) || Object.keys(raw["repos"]).length === 0) {
    throw new Error("repos must name at least one repo");
  }
  const repos: Record<string, RepoConfig> = {};
  for (const [name, value] of Object.entries(raw["repos"])) repos[name] = parseRepo(name, value, projectRoot, hubRepo, tracker);
  const name = explicitName ?? hubRepo.split("/")[1]!;
  if (!REPO_NAME.test(name)) {
    const hint = explicitName === undefined ? ' (derived from hubRepo — set "name" to a lower-case kebab name)' : "";
    throw new Error(`name must be lower-case kebab, got "${name}"${hint}`);
  }
  const stateDir = optionalString(raw, "stateDir", "config");
  const stages = parseStages(raw["stages"], { projectRoot, repos: Object.keys(repos), ...(readText ? { readText } : {}) });
  assertNoStageAgents(raw["agents"], stages);
  return {
    name,
    tracker,
    configPath,
    projectRoot,
    hubRepo,
    integrationBase: optionalString(raw, "integrationBase", "config") ?? DEFAULT_INTEGRATION_BASE,
    imageTag: optionalString(raw, "imageTag", "config") ?? DEFAULT_IMAGE_TAG,
    memoryProject: optionalString(raw, "memoryProject", "config"),
    stateDir: stateDir === undefined ? undefined : resolve(projectRoot, stateDir),
    repos,
    verify: parseVerify(raw["verify"], repos),
    ui: parseUi(raw["ui"]),
    agents: parseAgents(raw["agents"]),
    stages,
  };
}

function repoNameOfDir(projectRoot: string): string {
  return basename(projectRoot).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function assertNoStageAgents(rawAgents: unknown, stages: readonly StageSpec[]): void {
  if (!isObject(rawAgents)) return;
  const custom = customStageNames(stages).find((name) => Object.hasOwn(rawAgents, name));
  if (custom) throw new Error(`agents.${custom} names a custom stage — put "provider" and "model" on its entry under stages`);
}

export function readProjectConfig(path: string): ProjectConfig {
  const absolute = resolve(path);
  let text: string;
  try {
    text = readFileSync(absolute, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`cannot read ${absolute} — ${messageOf(cause)}`, { cause });
    }
    throw new Error(`no sandcastle project config at ${absolute} — pass --config=<project root or ${CONFIG_HINT}>, set SANDCASTLE_CONFIG, or run sandcastle init in the project root`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new Error(`${absolute} is not valid JSON — ${messageOf(cause)}`);
  }
  try {
    return parseProjectConfig(raw, absolute);
  } catch (cause) {
    throw new Error(`${absolute}: ${messageOf(cause)}`);
  }
}

let active: ProjectConfig | undefined;

export function setActiveProject(project: ProjectConfig): void {
  active = project;
}

export function activeProject(): ProjectConfig {
  if (!active) throw new Error(`no sandcastle project loaded — pass --config=<project root or ${CONFIG_HINT}> or set SANDCASTLE_CONFIG`);
  return active;
}

export function knownRepos(): string[] {
  return Object.keys(activeProject().repos).sort();
}

export function isKnownRepo(value: string): boolean {
  return Object.hasOwn(activeProject().repos, value);
}

export function repoConfig(repo: string): RepoConfig {
  const found = activeProject().repos[repo];
  if (!found) throw new Error(`"${repo}" is not a repo of project ${activeProject().name} (known: ${knownRepos().join(", ")})`);
  return found;
}

export function repoSlug(repo: string): string {
  return repoConfig(repo).github;
}

export function stageChain(): readonly StageSpec[] {
  return activeProject().stages;
}

export function integrationBase(): string {
  return activeProject().integrationBase;
}
