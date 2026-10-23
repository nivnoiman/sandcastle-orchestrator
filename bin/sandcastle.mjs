#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { constants } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BRAIN = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX_CLI = join(BRAIN, "node_modules", "tsx", "dist", "cli.mjs");
const OPS_SCRIPT = "scripts/ops.ts";

const SCRIPTS = {
  init: "src/cli/init.ts",
  validate: "src/cli/validate.ts",
  "dry-run": "src/cli/dryRun.ts",
  preflight: "src/cli/preflight.ts",
  ui: "src/cli/ui.ts",
  start: "src/cli/run.ts",
  reset: "src/cli/reset.ts",
  smoke: "scripts/smoke.ts",
  "sync-claude": "scripts/syncClaude.ts",
};

const OPS_COMMANDS = new Set([
  "launch",
  "enqueue",
  "dequeue",
  "queue-mode",
  "queue-resume",
  "queue-clear",
  "cap",
  "pause",
  "resume",
  "stop",
  "status",
  "queue",
  "resume-parked",
  "resolve-conflict",
  "logs",
  "finish",
]);

const USAGE = `usage: sandcastle <command> [args] [--config=<project root | .sandcastle/config.json>]

project
  init [--hub=owner/name] [--port=N]   create .sandcastle/ in the current directory
  validate <parent>                    parse + print the run model, or every violation
  dry-run <parent | fixture.json>      simulate scheduling with fake adapters (no tokens)
  preflight <parent>                   every start-time check, no lock, no tokens
  ui <parent | fixture.json>           control plane in the browser
  start <parent>                       headless real run (spends tokens)
  reset <parent> [--apply]             clear a killed run's containers, worktrees and labels
  smoke [repo]                         non-billed container + git plumbing check
  sync-claude <source ~/.claude>       copy skills, memories and credentials into the agent home

operating a run (JSON out; also: sandcastle ops <command>)
  launch <parent>... [--cap=N] [--parallel=N | --sequential] [--global-cap=N]
  enqueue | dequeue | queue-mode | queue-resume | queue-clear | queue
  cap <N> | pause | resume | stop <parent> | status | resume-parked | resolve-conflict <item>
  logs <item> [stage] | finish

The project is --config, else SANDCASTLE_CONFIG, else the nearest .sandcastle/config.json at or above the cwd
(init ignores --config: it always targets the cwd). Inside a project, run any command without arguments for its own usage.`;

/** Maps argv (flags may come before the command) to the brain script and its arguments, or undefined for an unknown command. */
function route(argv, commandIndex) {
  const command = argv[commandIndex];
  const rest = argv.filter((_, index) => index !== commandIndex);
  if (command === "ops") return { script: OPS_SCRIPT, args: rest };
  if (OPS_COMMANDS.has(command)) return { script: OPS_SCRIPT, args: argv };
  if (Object.hasOwn(SCRIPTS, command)) return { script: SCRIPTS[command], args: rest };
  return undefined;
}

const argv = process.argv.slice(2);
const commandIndex = argv.findIndex((arg) => !arg.startsWith("-"));
const command = commandIndex === -1 ? undefined : argv[commandIndex];

if (command === undefined || command === "help") {
  console.log(USAGE);
  process.exit(0);
}

const target = route(argv, commandIndex);
if (target === undefined) {
  console.error(`sandcastle: unknown command "${command}"\n\n${USAGE}`);
  process.exit(2);
}

if (!existsSync(TSX_CLI)) {
  console.error(`sandcastle: ${TSX_CLI} is missing — run npm ci in ${BRAIN}`);
  process.exit(1);
}

const child = spawn(process.execPath, [TSX_CLI, join(BRAIN, target.script), ...target.args], {
  cwd: process.cwd(),
  stdio: "inherit",
  env: { ...process.env, INIT_CWD: process.cwd() },
});

/**
 * Ctrl+C already reaches the child (same terminal process group / console), so SIGINT is only held here — forwarding it
 * too would read as a second Ctrl+C and force-stop a run. Every other signal is relayed.
 */
const RELAYED = process.platform === "win32" ? ["SIGTERM", "SIGBREAK"] : ["SIGTERM", "SIGHUP", "SIGQUIT"];
process.on("SIGINT", () => {});
for (const signal of RELAYED) {
  process.on(signal, () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  });
}

child.on("error", (cause) => {
  console.error(`sandcastle: could not start ${target.script} — ${cause.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (code !== null) process.exit(code);
  process.exit(128 + (constants.signals[signal] ?? 0));
});
