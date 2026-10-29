import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { invocationDir } from "../project/boot.js";
import { CONFIG_FILE, CONFIG_HINT, DEFAULT_TRACKER, isRepoSlug, PROJECT_FOLDER, tcpPort, type TrackerKind } from "../project/projectConfig.js";
import {
  buildInitConfig,
  buildLocalInitConfig,
  detectPackageManager,
  firstFreePort,
  guessRepoCommands,
  hubFromRemote,
  STATE_GITIGNORE,
} from "../project/scaffold.js";
import { ORCHESTRATOR_ENV_FILE } from "../real/env.js";
import { TOOL_DIR } from "../real/paths.js";
import { writeIssueTrackerDoc } from "../project/trackerDoc.js";
import { messageOf } from "../messageOf.js";
import { installSkills } from "../skills/install.js";
import { fail } from "./args.js";

const USAGE = [
  "usage: sandcastle init [--tracker=local|github] [--hub=owner/name] [--port=N]",
  `  run in the project root — creates ${PROJECT_FOLDER}/ with ${CONFIG_FILE}, .gitignore and the two env files`,
  "  --tracker=KIND     where issues live: github (hub repo issues) or local (files under .scratch/, no GitHub);",
  "                     asked interactively when omitted, github when there is no terminal",
  "  --hub=owner/name   github only: the repo holding the issues (default: gh repo view, else the origin remote)",
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

function installAgentSkills(): void {
  const claudeDir = join(homedir(), ".claude");
  try {
    const result = installSkills({ sourceRoot: TOOL_DIR, claudeDir });
    const skippedNote = result.skipped.length === 0 ? "" : `, ${result.skipped.length} skipped (modified locally — sandcastle skills install --force)`;
    console.log(`agent skills: ${result.installed.length} installed${skippedNote} in ${claudeDir}`);
  } catch (cause) {
    console.error(`[init][warn] could not install agent skills — ${messageOf(cause)}; run: sandcastle skills install`);
  }
}

async function chooseTracker(): Promise<TrackerKind> {
  const explicit = flag("tracker");
  if (explicit !== undefined) {
    if (explicit !== "github" && explicit !== "local") return fail(`--tracker must be "local" or "github", got "${explicit}"`);
    return explicit;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) return DEFAULT_TRACKER;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = (await rl.question("Where do this project's issues live? [github/local] (github): ")).trim().toLowerCase();
      if (answer === "") return DEFAULT_TRACKER;
      if (answer === "github" || answer === "local") return answer;
      console.log("  type github or local");
    }
  } finally {
    rl.close();
  }
}

const root = invocationDir();
const folder = join(root, PROJECT_FOLDER);
const configPath = join(folder, CONFIG_FILE);
if (existsSync(configPath)) fail(`${configPath} already exists — edit it instead of running init again`);

const tracker = await chooseTracker();
if (tracker === "local" && flag("hub") !== undefined) fail("--hub only applies to --tracker=github");
const hubRepo = tracker === "github" ? detectHub(root) : undefined;
const manager = detectPackageManager((name) => existsSync(join(root, name)));
const commands = guessRepoCommands(manager, packageScripts(root), existsSync(join(root, ".yarnrc.yml")));
const port = await choosePort();
const config =
  hubRepo === undefined
    ? buildLocalInitConfig({ dirName: basename(root), commands, port })
    : buildInitConfig({ hubRepo, commands, port });

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

const trackerDoc = writeIssueTrackerDoc(root, tracker, hubRepo);
if (trackerDoc.written) created.push(trackerDoc.path);

console.log(`sandcastle project initialised for ${hubRepo ?? `the local tracker (.scratch/)`} (control plane port ${port})`);
for (const path of created) console.log(`  created ${path}`);
if (!trackerDoc.written) console.log(`  kept ${trackerDoc.path} (already there)`);
console.log("");
console.log("next steps:");
console.log(
  tracker === "local"
    ? `  1. put your agent credentials (ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN) in ${join(folder, ORCHESTRATOR_ENV_FILE)} — no GH_TOKEN needed`
    : `  1. fill GH_TOKEN in ${join(folder, ORCHESTRATOR_ENV_FILE)} (or share one in ${join(TOOL_DIR, ORCHESTRATOR_ENV_FILE)})`,
);
console.log(`  2. put SAFE dev values in ${join(folder, ".env.sandbox")} (an empty file is fine)`);
console.log(`  3. review bootstrap + checks in ${CONFIG_HINT}${manager === undefined ? " — no lockfile found, checks is a placeholder that fails" : ""}`);
console.log(`  4. commit ${CONFIG_HINT}, ${PROJECT_FOLDER}/.gitignore and docs/agents/issue-tracker.md`);
console.log(
  tracker === "local"
    ? "  5. write an Orchestration Issue under .scratch/<feature>/issues/ (or add one in the Board View), then: sandcastle validate <number | slug>"
    : "  5. sandcastle validate <parent-issue>",
);

installAgentSkills();
