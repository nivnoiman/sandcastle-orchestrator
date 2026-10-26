import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { createProjectLauncher, SANDCASTLE_BIN, childEnv, logFileFor } from "../dashboard/launcher.js";
import {
  dashboardFile,
  DEFAULT_DASHBOARD_PORT,
  removeDashboardRecord,
  runningDashboard,
  startDashboardServer,
  writeDashboardRecord,
} from "../dashboard/server.js";
import { messageOf } from "../messageOf.js";
import { isTcpPort } from "../project/projectConfig.js";
import { createInstanceRegistry, defaultRegistryDir, projectId } from "../registry/index.js";
import { fail } from "./args.js";

const USAGE = [
  "usage: sandcastle dashboard [--detach] [--open] [--port=N] [--run=N]",
  "  (default)   serve the multi-project dashboard in this terminal (127.0.0.1)",
  "  --detach    run in the background; a repeated call reuses the running dashboard and prints its URL",
  "  --open      open the browser; inside a Known Project it selects that project (--run=N selects a run)",
  `  --port=N    dashboard port (default ${DEFAULT_DASHBOARD_PORT})`,
].join("\n");

const DETACH_WAIT_MS = 15_000;

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}

function flagValue(name: string): string | undefined {
  const joined = args.find((arg) => arg.startsWith(`--${name}=`));
  if (joined) return joined.slice(name.length + 3);
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
}

const unknown = args.filter((arg) => arg.startsWith("-") && !/^--(detach|open|port|run)(=|$)/.test(arg));
if (unknown.length > 0) fail(`unknown option ${unknown[0]}\n${USAGE}`);

const port = (() => {
  const raw = flagValue("port");
  if (raw === undefined) return DEFAULT_DASHBOARD_PORT;
  const parsed = Number(raw);
  if (raw.trim() === "" || !isTcpPort(parsed)) return fail(`--port must be a tcp port (1-65535), got "${raw}"`);
  return parsed;
})();
const runNumber = flagValue("run");
if (runNumber !== undefined && !/^[1-9]\d*$/.test(runNumber)) fail(`--run must be a positive integer, got "${runNumber}"`);

const registry = createInstanceRegistry();
const recordFile = dashboardFile(defaultRegistryDir());

/** The Known Project whose directory holds the cwd, so `--open` lands on it. */
function currentProjectId(): string | undefined {
  const known = new Set(registry.list().map((entry) => entry.id));
  for (let dir = resolve(process.cwd()); ; dir = dirname(dir)) {
    const id = projectId(dir);
    if (known.has(id)) return id;
    if (dir === parse(dir).root) return undefined;
  }
}

function pageUrl(base: string): string {
  const query = new URLSearchParams();
  const project = currentProjectId();
  if (project) query.set("project", project);
  if (project && runNumber) query.set("run", runNumber);
  const text = query.toString();
  return text ? `${base}/?${text}` : `${base}/`;
}

function openBrowser(url: string): void {
  const [command, commandArgs] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", '""', url.replace(/&/g, "^&")]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  const child = spawn(command, commandArgs, { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", (cause) => console.error(`could not open a browser (${cause.message}) — open ${url} yourself`));
  child.unref();
}

function announce(base: string, reused: boolean): void {
  const url = pageUrl(base);
  console.log(`sandcastle dashboard${reused ? " (already running)" : ""} — ${url}`);
  if (args.includes("--open")) openBrowser(url);
}

async function detach(): Promise<void> {
  const log = logFileFor(registry, "dashboard.log");
  const child = spawn(process.execPath, [SANDCASTLE_BIN, "dashboard", `--port=${port}`], {
    detached: true,
    stdio: ["ignore", log, log],
    env: childEnv(process.env),
    windowsHide: true,
  });
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  child.unref();
  const deadline = Date.now() + DETACH_WAIT_MS;
  while (Date.now() < deadline) {
    const record = await runningDashboard(recordFile);
    if (record) return announce(`http://127.0.0.1:${record.port}`, false);
    if (exited) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  fail(`dashboard did not start — see ${join(dirname(registry.file), "dashboard.log")}`);
}

const existing = await runningDashboard(recordFile);
if (existing) {
  announce(`http://127.0.0.1:${existing.port}`, true);
  process.exit(0);
}

if (args.includes("--detach")) {
  await detach();
  process.exit(0);
}

if (!existsSync(SANDCASTLE_BIN)) fail(`${SANDCASTLE_BIN} is missing`);
const server = await startDashboardServer({ registry, startProject: createProjectLauncher({ registry }) }, port).catch((cause: unknown) =>
  fail(`dashboard could not listen on 127.0.0.1:${port} — ${messageOf(cause)}`),
);
writeDashboardRecord(recordFile, { pid: process.pid, port: server.port, startedAt: new Date().toISOString() });
announce(server.url, false);
console.log("  Ctrl+C to stop");

const stop = (): void => {
  removeDashboardRecord(recordFile, process.pid);
  void server.close().then(() => process.exit(0), () => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("exit", () => removeDashboardRecord(recordFile, process.pid));
