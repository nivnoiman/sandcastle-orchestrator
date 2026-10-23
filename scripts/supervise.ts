import { spawn } from "node:child_process";
import { join } from "node:path";
import { decideAfterExit, type UiExit } from "../src/real/supervisor.js";

const [parentArg, hubRepo, capArg, portArg] = process.argv.slice(2);
if (!parentArg || !hubRepo || !capArg || !portArg) {
  console.error("usage: tsx scripts/supervise.ts <parent> <owner/repo> <cap> <port>");
  process.exit(2);
}
const parent = Number(parentArg);
const cap = Number(capArg);
if (![parent, cap, Number(portArg)].every((value) => Number.isSafeInteger(value) && value > 0)) {
  console.error(`parent, cap and port must be positive integers, got ${parentArg} ${capArg} ${portArg}`);
  process.exit(2);
}
const base = `http://127.0.0.1:${portArg}`;
const sandcastleDir = join(import.meta.dirname, "..");
const restarts: number[] = [];

function log(message: string): void {
  console.log(`[supervisor ${new Date().toISOString()}] ${message}`);
}

function runUi(): Promise<UiExit> {
  const child = spawn(
    process.execPath,
    [join(sandcastleDir, "node_modules", "tsx", "dist", "cli.mjs"), join(sandcastleDir, "src", "cli", "ui.ts"),
      parentArg!, hubRepo!, `--cap=${cap}`, `--port=${portArg}`],
    { cwd: sandcastleDir, stdio: "inherit" },
  );
  log(`ui started (pid ${child.pid})`);
  return new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
}

async function restartRun(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const state = (await (await fetch(`${base}/api/state`)).json()) as { canStart?: boolean };
      if (!state.canStart) return;
      const response = await fetch(`${base}/api/run`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-sandcastle": "1" },
        body: JSON.stringify({ parent, cap }),
      });
      log(`re-started #${parent} at cap ${cap} (${response.status}) — items resume from their labels and pull requests`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  log("the restarted ui never answered — run `sandcastle launch` by hand");
}

for (;;) {
  const exited = runUi();
  if (restarts.length > 0) void restartRun();
  const exit = await exited;
  const decision = decideAfterExit(exit, restarts, Date.now());
  if (decision.kind === "stop") {
    log(`${decision.reason} — supervisor exiting`);
    process.exit(0);
  }
  log(`${decision.reason} — restarting in ${decision.delayMs / 1000}s`);
  await new Promise((resolve) => setTimeout(resolve, decision.delayMs));
  restarts.push(Date.now());
}
