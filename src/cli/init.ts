import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { invocationDir } from "../project/boot.js";
import { CONFIG_FILE, CONFIG_HINT, isRepoSlug, PROJECT_FOLDER, tcpPort } from "../project/projectConfig.js";
import {
  buildInitConfig,
  detectPackageManager,
  firstFreePort,
  guessRepoCommands,
  hubFromRemote,
  STATE_GITIGNORE,
} from "../project/scaffold.js";
import { ORCHESTRATOR_ENV_FILE } from "../real/env.js";
import { TOOL_DIR } from "../real/paths.js";
import { messageOf } from "../messageOf.js";
import { fail } from "./args.js";

const USAGE = [
  "usage: sandcastle init [--hub=owner/name] [--port=N]",
  `  run in the project root — creates ${PROJECT_FOLDER}/ with ${CONFIG_FILE}, .gitignore and the two env files`,
  "  --hub=owner/name   the repo holding the issues (default: gh repo view, else the origin remote)",
  "  --port=N           control plane port (default: the first free port from 7777)",
].join("\n");

const SECRET_FILES: readonly { target: string; example: string }[] = [
  { target: ORCHESTRATOR_ENV_FILE, example: ".env.orchestrator.example" },
  { target: ".env.sandbox", example: ".env.sandbox.example" },
];

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function capture(command: string, commandArgs: readonly string[], cwd: string): string | undefined {
  try {
    const output = execFileSync(command, commandArgs, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return output.length > 0 ? output : undefined;
  } catch {
    return undefined;
  }
}

function detectHub(root: string): string {
  const explicit = flag("hub");
  if (explicit !== undefined) {
    if (!isRepoSlug(explicit)) fail(`--hub must be "owner/name", got "${explicit}"`);
    return explicit;
  }
  const fromGh = capture("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], root);
  if (fromGh !== undefined && isRepoSlug(fromGh)) return fromGh;
  const remote = capture("git", ["remote", "get-url", "origin"], root);
  const fromRemote = remote === undefined ? undefined : hubFromRemote(remote);
  if (fromRemote !== undefined && isRepoSlug(fromRemote)) return fromRemote;
  return fail("cannot tell which GitHub repo holds the issues (gh repo view and the origin remote both failed) — pass --hub=owner/name");
}

function packageScripts(root: string): Record<string, unknown> {
  const path = join(root, "package.json");
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const scripts = typeof parsed === "object" && parsed !== null ? (parsed as { scripts?: unknown }).scripts : undefined;
    return typeof scripts === "object" && scripts !== null ? (scripts as Record<string, unknown>) : {};
  } catch (cause) {
    return fail(`${path} is not valid JSON — ${messageOf(cause)}`);
  }
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

async function choosePort(): Promise<number> {
  const explicit = flag("port");
  try {
    if (explicit === undefined) return await firstFreePort(portIsFree);
    return tcpPort(Number(explicit), "--port");
  } catch (cause) {
    return fail(messageOf(cause));
  }
}

const OWNER_ONLY_MODE = 0o600;
const CREATE_ONLY_NEVER_OVERWRITE_FLAG = "wx";

function writeOwnerOnlySecretIfStillAbsent(path: string, content: string): void {
  writeFileSync(path, content, { mode: OWNER_ONLY_MODE, flag: CREATE_ONLY_NEVER_OVERWRITE_FLAG });
  try {
    chmodSync(path, OWNER_ONLY_MODE);
  } catch (cause) {
    console.error(`[init][warn] could not restrict ${path} to the owner — ${messageOf(cause)}`);
  }
}

const root = invocationDir();
const folder = join(root, PROJECT_FOLDER);
const configPath = join(folder, CONFIG_FILE);
if (existsSync(configPath)) fail(`${configPath} already exists — edit it instead of running init again`);

const hubRepo = detectHub(root);
const manager = detectPackageManager((name) => existsSync(join(root, name)));
const commands = guessRepoCommands(manager, packageScripts(root), existsSync(join(root, ".yarnrc.yml")));
const port = await choosePort();
const config = buildInitConfig({ hubRepo, commands, port });

mkdirSync(folder, { recursive: true });
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
const ignorePath = join(folder, ".gitignore");
writeFileSync(ignorePath, STATE_GITIGNORE);
const created = [configPath, ignorePath];
for (const secret of SECRET_FILES) {
  const target = join(folder, secret.target);
  if (existsSync(target)) continue;
  const example = join(TOOL_DIR, secret.example);
  writeOwnerOnlySecretIfStillAbsent(target, existsSync(example) ? readFileSync(example, "utf8") : "");
  created.push(target);
}

console.log(`sandcastle project initialised for ${hubRepo} (control plane port ${port})`);
for (const path of created) console.log(`  created ${path}`);
console.log("");
console.log("next steps:");
console.log(`  1. fill GH_TOKEN in ${join(folder, ORCHESTRATOR_ENV_FILE)} (or share one in ${join(TOOL_DIR, ORCHESTRATOR_ENV_FILE)})`);
console.log(`  2. put SAFE dev values in ${join(folder, ".env.sandbox")} (an empty file is fine)`);
console.log(`  3. review bootstrap + checks in ${CONFIG_HINT}${manager === undefined ? " — no lockfile found, checks is a placeholder that fails" : ""}`);
console.log(`  4. commit ${CONFIG_HINT} and ${PROJECT_FOLDER}/.gitignore`);
console.log("  5. sandcastle validate <parent-issue>");
