import { CONFIG_FILE, CONFIG_HINT, DEFAULT_UI_PORT } from "./projectConfig.js";

/** `.sandcastle/.gitignore`: only the config is committed — env files, logs, lock and queue stay local. */
export const STATE_GITIGNORE = ["*", "!.gitignore", `!${CONFIG_FILE}`, ""].join("\n");

export const NO_CHECKS = `echo set checks in ${CONFIG_HINT} && exit 1`;

const CHECK_SCRIPTS = ["typecheck", "test", "build"] as const;
const GITHUB_REMOTE = /github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

export type PackageManager = "pnpm" | "yarn" | "npm";

export interface RepoCommands {
  bootstrap: string;
  checks: string;
}

export interface InitConfigInput {
  hubRepo: string;
  commands: RepoCommands;
  port: number;
}

/** Picks the package manager from the lockfile present in the project root (pnpm, then yarn, then npm). */
export function detectPackageManager(hasFile: (name: string) => boolean): PackageManager | undefined {
  if (hasFile("pnpm-lock.yaml")) return "pnpm";
  if (hasFile("yarn.lock")) return "yarn";
  if (hasFile("package-lock.json")) return "npm";
  return undefined;
}

function installCommand(manager: PackageManager, yarnBerry: boolean): string {
  if (manager === "pnpm") return "pnpm install --frozen-lockfile";
  if (manager === "npm") return "npm ci";
  return yarnBerry ? "yarn install --immutable" : "yarn install --frozen-lockfile";
}

function runScript(manager: PackageManager, script: string): string {
  return manager === "npm" ? `npm run ${script}` : `${manager} ${script}`;
}

/** Bootstrap + checks guessed from the package manager and the package.json scripts that exist among typecheck, test, build. */
export function guessRepoCommands(
  manager: PackageManager | undefined,
  scripts: Readonly<Record<string, unknown>>,
  yarnBerry = false,
): RepoCommands {
  if (manager === undefined) return { bootstrap: "", checks: NO_CHECKS };
  const present = CHECK_SCRIPTS.filter((script) => Object.hasOwn(scripts, script));
  return {
    bootstrap: installCommand(manager, yarnBerry),
    checks: present.length > 0 ? present.map((script) => runScript(manager, script)).join(" && ") : NO_CHECKS,
  };
}

const RECHECK_BASE = "$SANDCASTLE_RECHECK_BASE";
const JEST_SCRIPT = /^jest(\s|$)/;
const VITEST_SCRIPT = /^vitest(\s+run)?(\s|$)/;

function execPrefix(manager: PackageManager): string {
  if (manager === "pnpm") return "pnpm exec";
  if (manager === "yarn") return "yarn";
  return "npx";
}

function changedTestsCommand(manager: PackageManager, testScript: string): string | undefined {
  const script = testScript.trim();
  if (JEST_SCRIPT.test(script)) return `${execPrefix(manager)} ${script} --changedSince=${RECHECK_BASE}`;
  if (VITEST_SCRIPT.test(script)) {
    const rest = script.replace(VITEST_SCRIPT, " ").trim();
    return [execPrefix(manager), "vitest run", rest, `--changed=${RECHECK_BASE}`].filter((part) => part.length > 0).join(" ");
  }
  return undefined;
}

export function suggestRecheck(manager: PackageManager | undefined, scripts: Readonly<Record<string, unknown>>): string | undefined {
  const testScript = scripts["test"];
  if (manager === undefined || typeof testScript !== "string") return undefined;
  const changedTests = changedTestsCommand(manager, testScript);
  if (changedTests === undefined) return undefined;
  const typecheck = Object.hasOwn(scripts, "typecheck") ? [runScript(manager, "typecheck")] : [];
  return [...typecheck, changedTests].join(" && ");
}

export function recheckSuggestionLines(repoName: string, suggestion: string | undefined): string[] {
  const example = suggestion ?? `<a cheaper command, e.g. your tests limited to files changed since ${RECHECK_BASE}>`;
  return [
    `  optional: add verify.recheck to ${CONFIG_HINT} so a Feature Verify re-run after a fix round only checks what changed:`,
    `    "verify": { "strategy": "command", "recheck": { ${JSON.stringify(repoName)}: ${JSON.stringify(example)} } }`,
  ];
}

/** `owner/name` from a GitHub remote URL (https or ssh), or undefined for anything else. */
export function hubFromRemote(url: string): string | undefined {
  const match = GITHUB_REMOTE.exec(url.trim());
  if (!match) return undefined;
  return `${match[1]}/${match[2]}`;
}

/** The lower-kebab repo name the config uses for the hub's code (the `repo:<name>` label). */
export function repoNameFrom(hubRepo: string): string {
  const name = (hubRepo.split("/")[1] ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return name.length > 0 ? name : "app";
}

export interface LocalInitConfigInput {
  /** The project directory's name; it becomes the project and repo name, lower kebab. */
  dirName: string;
  commands: RepoCommands;
  port: number;
}

/** The `.sandcastle/config.json` object `sandcastle init --tracker=local` writes: no hubRepo, no GitHub slugs. */
export function buildLocalInitConfig(input: LocalInitConfigInput): Record<string, unknown> {
  const name = repoNameFrom(`local/${input.dirName}`);
  return {
    name,
    tracker: "local",
    integrationBase: "dev",
    repos: { [name]: { bootstrap: input.commands.bootstrap, checks: input.commands.checks } },
    verify: { strategy: "command" },
    ui: { port: input.port },
  };
}

/** The `.sandcastle/config.json` object `sandcastle init` writes for a single-repo project. */
export function buildInitConfig(input: InitConfigInput): Record<string, unknown> {
  const repoName = repoNameFrom(input.hubRepo);
  const hubName = input.hubRepo.split("/")[1];
  return {
    ...(hubName === repoName ? {} : { name: repoName }),
    hubRepo: input.hubRepo,
    integrationBase: "dev",
    repos: {
      [repoName]: { github: input.hubRepo, bootstrap: input.commands.bootstrap, checks: input.commands.checks },
    },
    verify: { strategy: "command" },
    ui: { port: input.port },
  };
}

/** The first port from `start` upward that `isFree` accepts. */
export async function firstFreePort(isFree: (port: number) => Promise<boolean>, start = DEFAULT_UI_PORT, end = 65535): Promise<number> {
  for (let port = start; port <= end; port += 1) {
    if (await isFree(port)) return port;
  }
  throw new Error(`no free tcp port between ${start} and ${end} on 127.0.0.1 — pass --port=N`);
}
