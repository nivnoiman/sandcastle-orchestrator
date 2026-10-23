import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { fetchRunSnapshot } from "../src/gh/snapshot.js";
import { loadRunModel, type RunModel } from "../src/model/runModel.js";
import { NodeCommandRunner } from "../src/real/commandRunner.js";
import { bootProject } from "../src/project/boot.js";
import { loadOrchestratorConfig, resolveLayout } from "../src/real/env.js";
import { TOOL_DIR } from "../src/real/paths.js";
import { nodeFileSystem } from "../src/real/fileSystem.js";
import { findItem, finishReport, launchPlan, parkedToRetry, queueReport, statusReport, waitingItems } from "../src/real/ops.js";
import { runPreflight, type PreflightReport } from "../src/real/preflight.js";
import { resolveUiPort } from "../src/ui/server.js";
import type { UiState } from "../src/ui/state.js";
import { messageOf } from "../src/messageOf.js";

const USAGE = [
  "usage: sandcastle <command> [args]   (or: sandcastle ops <command>, npm run ops -- <command>)",
  "",
  "  preflight <parent>                 every start-time check, without taking the lock",
  "  launch <parent>... [--cap=N] [--parallel=N | --sequential] [--global-cap=N]",
  "                                     bring the control plane up if it is down, apply the queue settings, start the first parent",
  "                                     the control plane can take and queue the rest",
  "  enqueue <parent>... [--cap=N]      queue parents behind the runs in flight",
  "  dequeue <parent>                   drop a parent from the queue",
  "  queue-mode sequential|parallel [--max=N]  one parent at a time, or up to N at once (features in parallel)",
  "  queue-resume | queue-clear         resume a paused queue, or empty it",
  "  cap <N> [--parent=N]               tasks in parallel: one run's worker cap with --parent, else the global cap across runs",
  "  pause | resume [--parent=N]        hold or release new stage starts (every run without --parent)",
  "  stop <parent>                      no new stages start for that run",
  "  status [--parent=N] [--items]      one run: phases, holds, waiting reasons, parks, its feed and the queue",
  "  status --summary                   queue, global slots and one line per run (also what status prints when it cannot pick one run)",
  "  queue                              queue settings, the queued parents and the runs on the control plane",
  "  resume-parked [--parent=N] [--only=<text>]  retry every parked item whose reason contains <text> (default: all)",
  "  resolve-conflict <item> [--parent=N]        retry one parked item — the gate re-runs and may resolve it with an agent",
  "  logs <item> [stage] [--bytes=N]    tail the newest recorded attempt for that item",
  "  finish [--parent=N]                assert the run is complete and print its integration → base pull requests",
  "",
  "  --parent=N picks the run; it may be left out while only one run exists or only one parent is live",
  "  --config=path (default SANDCASTLE_CONFIG, else the nearest .sandcastle/config.json at or above the cwd),",
  "  --port=N (default SANDCASTLE_UI_PORT, then ui.port in the project config, then 7777),",
  "  --repo=owner/name (default the project's hubRepo)",
  "Every command prints one JSON object and exits 0 on success, 1 on failure.",
].join("\n");

const args = process.argv.slice(2);
const positional = args.filter((arg) => !arg.startsWith("--"));
const [command, ...rest] = positional;

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function flagNumber(name: string, fallback: number): number {
  const raw = flag(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer, got "${raw}"`);
  return value;
}

function issueNumber(raw: string | undefined): number | undefined {
  return raw !== undefined && /^#?\d+$/.test(raw) ? Number(raw.replace("#", "")) : undefined;
}

function parentFlag(): number | undefined {
  const raw = flag("parent");
  if (raw === undefined) return undefined;
  const parent = issueNumber(raw);
  if (parent === undefined) throw new Error(`--parent must be a parent issue number, got "${raw}"`);
  return parent;
}

if (!command) {
  console.error(USAGE);
  process.exit(2);
}

const project = bootProject();
const port = (() => {
  try {
    return resolveUiPort(args, process.env, project.ui.port);
  } catch (cause) {
    return die(messageOf(cause));
  }
})();
const hubRepo = flag("repo") ?? project.hubRepo;
const base = `http://127.0.0.1:${port}`;

function print(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function die(message: string, extra: Record<string, unknown> = {}): never {
  print({ ok: false, error: message, ...extra });
  process.exit(1);
}

async function fetchOrExplain(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (cause) {
    throw new Error(
      `no control plane is answering on ${base} (${messageOf(cause)}) —` +
        " start one with: sandcastle launch <parent> --cap=N",
    );
  }
}

async function api<T>(path: string, init?: { method: "POST" | "PUT" | "DELETE"; body?: unknown }): Promise<T> {
  const response = await fetchOrExplain(`${base}${path}`, {
    method: init?.method ?? "GET",
    headers: init ? { "content-type": "application/json", "x-sandcastle": "1" } : {},
    body: init ? JSON.stringify(init.body ?? {}) : undefined,
  });
  const text = await response.text();
  const payload: unknown = text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text;
  if (!response.ok) {
    const message = typeof payload === "object" && payload !== null ? String((payload as { error?: string }).error) : text;
    throw new Error(`${path} failed (${response.status}): ${message}`);
  }
  return payload as T;
}

async function controlPlaneUp(): Promise<boolean> {
  try {
    await api<UiState>("/api/state");
    return true;
  } catch {
    return false;
  }
}

function requiredNumber(what: string): number {
  return issueNumber(rest[0]) ?? die(`this command needs a ${what} number\n${USAGE}`);
}

function requiredNumbers(what: string): number[] {
  if (rest.length === 0) die(`this command needs at least one ${what} number\n${USAGE}`);
  return rest.map((raw) => issueNumber(raw) ?? die(`"${raw}" is not a ${what} number\n${USAGE}`));
}

async function applyQueueFlags(): Promise<Record<string, unknown>> {
  if (args.includes("--parallel")) die("--parallel needs a count: --parallel=N");
  if (flag("parallel") !== undefined && args.includes("--sequential")) die("--parallel and --sequential cannot both be set");
  const applied: Record<string, unknown> = {};
  if (flag("parallel") !== undefined) {
    const maxParallel = flagNumber("parallel", 2);
    await api("/api/queue/mode", { method: "PUT", body: { mode: "parallel", maxParallel } });
    applied["mode"] = { mode: "parallel", maxParallel };
  } else if (args.includes("--sequential")) {
    await api("/api/queue/mode", { method: "PUT", body: { mode: "sequential" } });
    applied["mode"] = { mode: "sequential" };
  }
  if (flag("global-cap") !== undefined) {
    const globalCap = flagNumber("global-cap", 1);
    await api("/api/cap", { method: "POST", body: { value: globalCap } });
    applied["globalCap"] = globalCap;
  }
  return applied;
}

async function runModelOf(parentNumber: number): Promise<RunModel> {
  const result = loadRunModel(await fetchRunSnapshot(hubRepo, parentNumber));
  if (!result.ok) die(`#${parentNumber} does not satisfy the publish contract`, { errors: result.errors });
  return result.model;
}

async function preflight(): Promise<void> {
  const parentNumber = requiredNumber("parent issue");
  const fs = nodeFileSystem;
  const layout = resolveLayout(fs);
  const report: PreflightReport = await runPreflight({
    runner: new NodeCommandRunner(),
    fs,
    layout,
    config: loadOrchestratorConfig(fs, layout, { hubRepo }),
    model: await runModelOf(parentNumber),
    skipVerify: args.includes("--skip-verify"),
  });
  print({ ok: report.failures.length === 0, parent: parentNumber, checks: report.checks });
  if (report.failures.length > 0) process.exit(1);
}

function spawnControlPlane(parentNumber: number, cap: number): string {
  const layout = resolveLayout(nodeFileSystem);
  const logFile = join(layout.sandcastleDir, `ui-${parentNumber}.log`);
  const handle = openSync(logFile, "a");
  const child = spawn(
    process.execPath,
    [join(TOOL_DIR, "node_modules", "tsx", "dist", "cli.mjs"), join(TOOL_DIR, "scripts", "supervise.ts"),
      String(parentNumber), hubRepo, String(cap), String(port)],
    { cwd: TOOL_DIR, detached: true, stdio: ["ignore", handle, handle] },
  );
  child.unref();
  closeSync(handle);
  return logFile;
}

async function waitForControlPlane(seconds: number): Promise<boolean> {
  for (let attempt = 0; attempt < seconds * 2; attempt += 1) {
    if (await controlPlaneUp()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function launch(): Promise<void> {
  const parents = requiredNumbers("parent issue");
  let logFile: string | undefined;
  if (!(await controlPlaneUp())) {
    logFile = spawnControlPlane(parents[0]!, flagNumber("cap", 1));
    if (!(await waitForControlPlane(30))) die(`the control plane did not answer on ${base} within 30s`, { logFile });
  }
  const settings = await applyQueueFlags();
  const current = await api<UiState>("/api/state");
  const cap = flagNumber("cap", current.queueSettings.parentCap);
  const plan = launchPlan(current, parents);
  if (plan.start !== undefined) await api("/api/run", { method: "POST", body: { parent: plan.start, cap } });
  if (plan.queue.length > 0) await api("/api/queue", { method: "POST", body: { parents: plan.queue, cap } });
  const after = await api<UiState>("/api/state");
  print({
    ok: true,
    started: plan.start ?? null,
    queued: after.queue,
    alreadyRunning: plan.alreadyRunning,
    alreadyQueued: plan.alreadyQueued,
    cap,
    settings,
    queueSettings: after.queueSettings,
    note: after.queueSettings.paused && after.queue.length > 0 ? "the queue is paused, sandcastle queue-resume starts it" : undefined,
    url: base,
    logFile,
  });
}

async function enqueue(): Promise<void> {
  const parents = requiredNumbers("parent issue");
  const current = await api<UiState>("/api/state");
  await api("/api/queue", { method: "POST", body: { parents, cap: flagNumber("cap", current.queueSettings.parentCap) } });
  await queue();
}

async function dequeue(): Promise<void> {
  await api(`/api/queue/${requiredNumber("parent issue")}`, { method: "DELETE" });
  await queue();
}

async function queueMode(): Promise<void> {
  const mode = rest[0];
  if (mode !== "sequential" && mode !== "parallel") die(`queue-mode needs sequential or parallel\n${USAGE}`);
  const body = mode === "parallel" && flag("max") !== undefined ? { mode, maxParallel: flagNumber("max", 2) } : { mode };
  await api("/api/queue/mode", { method: "PUT", body });
  await queue();
}

async function queueAction(path: string): Promise<void> {
  await api(path, { method: "POST" });
  await queue();
}

async function cap(): Promise<void> {
  const value = requiredNumber("cap");
  const parent = parentFlag();
  if (parent === undefined) await api("/api/cap", { method: "POST", body: { value } });
  else await api(`/api/runs/${parent}/cap`, { method: "POST", body: { cap: value } });
  print({ ok: true, cap: value, parent: parent ?? null, scope: parent === undefined ? "global" : "run" });
}

async function holdStarts(action: "pause" | "resume"): Promise<void> {
  const parent = parentFlag();
  await api(parent === undefined ? `/api/${action}` : `/api/runs/${parent}/${action}`, { method: "POST" });
  print({ ok: true, [action === "pause" ? "paused" : "resumed"]: parent ?? "every run" });
}

async function stop(): Promise<void> {
  const parent = requiredNumber("parent issue");
  await api(`/api/runs/${parent}/stop`, { method: "POST" });
  print({ ok: true, stopped: parent });
}

async function status(): Promise<void> {
  const options = { items: args.includes("--items"), parent: parentFlag(), summary: args.includes("--summary") };
  print(statusReport(await api<UiState>("/api/state"), options));
}

async function queue(): Promise<void> {
  print(queueReport(await api<UiState>("/api/state")));
}

async function resumeParked(): Promise<void> {
  const state = await api<UiState>("/api/state");
  const parent = parentFlag();
  const parked = parkedToRetry(state, flag("only"), parent);
  const retried: number[] = [];
  const failures: { item: number; error: string }[] = [];
  for (const item of parked) {
    try {
      await api(`/api/items/${item}/retry`, { method: "POST" });
      retried.push(item);
    } catch (cause) {
      failures.push({ item, error: messageOf(cause) });
    }
  }
  print({ ok: failures.length === 0, retried, waiting: waitingItems(state, parent), failures });
  if (failures.length > 0) process.exit(1);
}

async function resolveConflict(): Promise<void> {
  const item = requiredNumber("sub-issue");
  const state = await api<UiState>("/api/state");
  const found = findItem(state, item, parentFlag());
  if (found.phase !== "parked") die(`#${item} is ${found.phase}, not parked — only a parked item can be retried`);
  await api(`/api/items/${item}/retry`, { method: "POST" });
  print({
    ok: true,
    retried: item,
    parkReason: found.parkReason,
    note: "the verify gate re-runs; a fresh conflict gets one constrained resolve agent before it parks again",
  });
}

async function logs(): Promise<void> {
  const item = requiredNumber("sub-issue");
  const stage = rest[1];
  const bytes = flagNumber("bytes", 4000);
  const attempts = await api<{ result: { id: string; stage: string; outcome?: string; endedAt?: string; bytes: number }[] }>(
    `/api/items/${item}/attempts`,
  );
  const matching = attempts.result.filter((attempt) => !stage || attempt.stage === stage);
  const latest = matching[matching.length - 1];
  if (!latest) {
    print({ ok: true, item, attempts: attempts.result, tail: "", note: "no attempt recorded yet" });
    return;
  }
  const from = Math.max(0, latest.bytes - bytes);
  const log = await api<{ result: { chunk: string; running: boolean } }>(`/api/attempts/${latest.id}/log?from=${from}`);
  print({
    ok: true,
    item,
    attempt: latest.id,
    outcome: latest.outcome ?? null,
    running: log.result.running,
    attempts: matching.map((attempt) => attempt.id),
    tail: log.result.chunk,
  });
}

async function finish(): Promise<void> {
  const report = finishReport(await api<UiState>("/api/state"), parentFlag());
  print(report);
  if (!report.ok) process.exit(1);
}

const COMMANDS: Record<string, () => Promise<void>> = {
  preflight,
  launch,
  status,
  queue,
  enqueue,
  dequeue,
  "queue-mode": queueMode,
  "queue-resume": () => queueAction("/api/queue/resume"),
  "queue-clear": () => queueAction("/api/queue/clear"),
  cap,
  pause: () => holdStarts("pause"),
  resume: () => holdStarts("resume"),
  stop,
  "resume-parked": resumeParked,
  "resolve-conflict": resolveConflict,
  logs,
  finish,
};

const chosen = command ? COMMANDS[command] : undefined;
if (!chosen) {
  console.error(USAGE);
  process.exit(2);
}

await chosen().catch((cause: unknown) => {
  die(messageOf(cause));
});
