import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { sandcastleDirFrom } from "../real/paths.js";
import { CONFIG_FILE, CONFIG_HINT, PROJECT_FOLDER, readProjectConfig, setActiveProject, type ProjectConfig } from "./projectConfig.js";
import { STATE_GITIGNORE } from "./scaffold.js";
import { messageOf } from "../messageOf.js";

const NPM_RUN_CALLER_CWD_VAR = "INIT_CWD";

/** Where the user ran the command: npm's caller dir under `npm run`, else the process cwd. */
export function invocationDir(env: NodeJS.ProcessEnv = process.env): string {
  return env[NPM_RUN_CALLER_CWD_VAR] || process.cwd();
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** A config path as given: a project root or `.sandcastle` dir maps to its `config.json`, anything else is taken as the file. */
export function configFileAt(path: string): string {
  if (!isDirectory(path)) return path;
  if (basename(path) === PROJECT_FOLDER) return join(path, CONFIG_FILE);
  return join(path, PROJECT_FOLDER, CONFIG_FILE);
}

/** The nearest `.sandcastle/config.json` at or above `start`, if any. */
export function findProjectConfig(start: string): string | undefined {
  let current = resolve(start);
  for (;;) {
    const candidate = join(current, PROJECT_FOLDER, CONFIG_FILE);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function configPathFrom(args: readonly string[], env: NodeJS.ProcessEnv = process.env, cwd = invocationDir(env)): string {
  if (args.includes("--config")) throw new Error(`--config needs a value: --config=<project root or ${CONFIG_HINT}>`);
  const flag = args.find((arg) => arg.startsWith("--config="));
  if (flag !== undefined) {
    const path = flag.slice("--config=".length);
    if (path.length === 0) throw new Error(`--config is empty — pass --config=<project root or ${CONFIG_HINT}>`);
    return configFileAt(resolve(cwd, path));
  }
  if (env["SANDCASTLE_CONFIG"]) return configFileAt(resolve(cwd, env["SANDCASTLE_CONFIG"]));
  const discovered = findProjectConfig(cwd);
  if (discovered !== undefined) return discovered;
  throw new Error(
    `no sandcastle project at or above ${cwd} — run sandcastle init in the project root, pass --config=<project root or ${CONFIG_HINT}>, or set SANDCASTLE_CONFIG`,
  );
}

function ensureStateIgnored(project: ProjectConfig, stateDir: string): void {
  if (resolve(stateDir) !== join(project.projectRoot, PROJECT_FOLDER)) return;
  const ignoreFile = join(stateDir, ".gitignore");
  if (existsSync(ignoreFile)) return;
  writeFileSync(ignoreFile, STATE_GITIGNORE);
}

export function bootProject(args: readonly string[] = process.argv.slice(2)): ProjectConfig {
  try {
    const project = readProjectConfig(configPathFrom(args));
    setActiveProject(project);
    process.env["SANDCASTLE_CONFIG"] = project.configPath;
    const stateDir = sandcastleDirFrom();
    mkdirSync(stateDir, { recursive: true });
    ensureStateIgnored(project, stateDir);
    return project;
  } catch (cause) {
    console.error(messageOf(cause));
    process.exit(2);
  }
}
