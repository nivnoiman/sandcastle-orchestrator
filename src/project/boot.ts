import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { sandcastleDirFrom } from "../real/paths.js";
import { CONFIG_FILE, readProjectConfig, setActiveProject, type ProjectConfig } from "./projectConfig.js";

/** `npm run` switches cwd to the tool folder; INIT_CWD is where the user actually ran it. */
function invocationDir(env: NodeJS.ProcessEnv): string {
  return env["INIT_CWD"] || process.cwd();
}

export function configPathFrom(args: readonly string[], env: NodeJS.ProcessEnv = process.env, cwd = invocationDir(env)): string {
  if (args.includes("--config")) throw new Error(`--config needs a value: --config=<path to ${CONFIG_FILE}>`);
  const flag = args.find((arg) => arg.startsWith("--config="));
  if (flag !== undefined) {
    const path = flag.slice("--config=".length);
    if (path.length === 0) throw new Error(`--config is empty — pass --config=<path to ${CONFIG_FILE}>`);
    return resolve(cwd, path);
  }
  if (env["SANDCASTLE_CONFIG"]) return resolve(cwd, env["SANDCASTLE_CONFIG"]);
  const local = join(cwd, CONFIG_FILE);
  if (existsSync(local)) return local;
  throw new Error(`no sandcastle project — pass --config=<path to ${CONFIG_FILE}>, set SANDCASTLE_CONFIG, or run from the project root`);
}

export function bootProject(args: readonly string[] = process.argv.slice(2)): ProjectConfig {
  try {
    const project = readProjectConfig(configPathFrom(args));
    setActiveProject(project);
    process.env["SANDCASTLE_CONFIG"] = project.configPath;
    mkdirSync(sandcastleDirFrom(), { recursive: true });
    return project;
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(2);
  }
}
