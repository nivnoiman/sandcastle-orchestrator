import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { messageOf } from "../messageOf.js";

export const CONFIG_FILE = "sandcastle.config.json";
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

export interface ProjectConfig {
  name: string;
  configPath: string;
  hubRepo: string;
  integrationBase: string;
  imageTag: string;
  memoryProject: string | undefined;
  stateDir: string | undefined;
  repos: Record<string, RepoConfig>;
  verify: VerifyStrategy;
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

function slug(value: string, where: string): string {
  if (!SLUG.test(value)) throw new Error(`${where} must be "owner/name", got "${value}"`);
  return value;
}

/** Claude Code's per-project folder name: every non-alphanumeric character becomes "-". */
export function claudeProjectSlug(path: string): string {
  return resolve(path).replace(/[^A-Za-z0-9]/g, "-");
}

function parseRepo(name: string, raw: unknown, configDir: string, hubRepo: string): RepoConfig {
  const where = `repos.${name}`;
  if (!REPO_NAME.test(name)) throw new Error(`${where}: repo names are lower-case kebab (they become repo:<name> labels)`);
  if (!isObject(raw)) throw new Error(`${where} must be an object`);
  const github = slug(requiredString(raw, "github", where), `${where}.github`);
  const rawPath = optionalString(raw, "path", where) ?? (github === hubRepo ? "." : join("..", name));
  return {
    github,
    path: resolve(configDir, rawPath),
    bootstrap: optionalString(raw, "bootstrap", where) ?? "",
    checks: requiredString(raw, "checks", where),
  };
}

function parseService(repo: string, raw: unknown): VerifyService {
  const where = `verify.services.${repo}`;
  if (!isObject(raw)) throw new Error(`${where} must be an object`);
  const port = raw["port"];
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${where}.port must be a tcp port`);
  }
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

export function parseProjectConfig(raw: unknown, configPath: string): ProjectConfig {
  if (!isObject(raw)) throw new Error(`${configPath} must hold a JSON object`);
  const configDir = dirname(configPath);
  const hubRepo = slug(requiredString(raw, "hubRepo", "config"), "hubRepo");
  if (!isObject(raw["repos"]) || Object.keys(raw["repos"]).length === 0) {
    throw new Error("repos must name at least one repo");
  }
  const repos: Record<string, RepoConfig> = {};
  for (const [name, value] of Object.entries(raw["repos"])) repos[name] = parseRepo(name, value, configDir, hubRepo);
  const explicitName = optionalString(raw, "name", "config");
  const name = explicitName ?? hubRepo.split("/")[1]!;
  if (!REPO_NAME.test(name)) {
    const hint = explicitName === undefined ? ' (derived from hubRepo — set "name" to a lower-case kebab name)' : "";
    throw new Error(`name must be lower-case kebab, got "${name}"${hint}`);
  }
  const stateDir = optionalString(raw, "stateDir", "config");
  return {
    name,
    configPath,
    hubRepo,
    integrationBase: optionalString(raw, "integrationBase", "config") ?? DEFAULT_INTEGRATION_BASE,
    imageTag: optionalString(raw, "imageTag", "config") ?? DEFAULT_IMAGE_TAG,
    memoryProject: optionalString(raw, "memoryProject", "config"),
    stateDir: stateDir === undefined ? undefined : resolve(configDir, stateDir),
    repos,
    verify: parseVerify(raw["verify"], repos),
  };
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
    throw new Error(`no sandcastle project config at ${absolute} — pass --config=<path to ${CONFIG_FILE}> or set SANDCASTLE_CONFIG`);
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
  if (!active) throw new Error(`no sandcastle project loaded — pass --config=<path to ${CONFIG_FILE}> or set SANDCASTLE_CONFIG`);
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

export function integrationBase(): string {
  return activeProject().integrationBase;
}
