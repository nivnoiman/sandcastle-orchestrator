import { bootProject } from "../project/boot.js";
import { readFile } from "node:fs/promises";
import type { StageName } from "../engine/adapters.js";
import { stageNames } from "../engine/stageChain.js";
import type { PendingStage } from "../engine/fakes.js";
import { OperatorError } from "../engine/operatorError.js";
import { fetchSandcastleParents, type ParentSummary } from "../gh/parents.js";
import { fetchRunSnapshot, isRunSnapshot, type RunSnapshot } from "../gh/snapshot.js";
import { loadRunModel } from "../model/runModel.js";
import { NodeCommandRunner } from "../real/commandRunner.js";
import { controlPlaneHost } from "../real/controlPlane.js";
import { clampIdleTimeout, resolveLayout } from "../real/env.js";
import { nodeFileSystem } from "../real/fileSystem.js";
import { processIsAlive } from "../real/lock.js";
import { defaultLayout } from "../real/paths.js";
import { applyReset, planReset, type ResetDeps } from "../real/reset.js";
import { parentList, UiController, type ResetOps, type StartSessionRequest } from "../ui/controller.js";
import { resolveUiPort, startUiServer } from "../ui/server.js";
import { loadQueueFile, queueFilePath, saveQueueFile } from "../ui/queueStore.js";
import { RunQueue } from "../ui/runQueue.js";
import { dryRunSession, realSession } from "../ui/sessions.js";
import type { RunMode } from "../ui/state.js";
import { messageOf } from "../messageOf.js";
import { fail, flagNumber, optionalFlagNumber } from "./args.js";

const TICK_MS = 250;

const USAGE = [
  "usage: sandcastle ui <fixture.json | parent-issue> [owner/repo] [--cap=N] [--parallel=N | --sequential] [--global-cap=N] [--port=N] [--dry] [--interval=N] [--idle-timeout=N] [--skip-gc] [--skip-verify] [--fail=<item>:<stage>]",
  "  <fixture.json>     paced dry run — no docker, no gh writes, no tokens",
  "  <parent-issue>     real run against the hub (add --dry for a paced simulation of that parent)",
  "  --cap=N            worker cap per run: how many tasks of one parent run at once (default 1)",
  "  --parallel=N       queue runs up to N parents at once (overrides the saved queue mode)",
  "  --sequential       queue runs one parent at a time (overrides the saved queue mode)",
  "  --global-cap=N     workers across every parent (default --cap, or the saved global cap)",
  "  --port=N           ui port (default SANDCASTLE_UI_PORT, then ui.port in the project config, then 7777)",
  "  --fail=17:review   dry mode only — fail that item's stage once, so park/retry is demoable",
].join("\n");

const project = bootProject();
const args = process.argv.slice(2);
const positional = args.filter((arg) => !arg.startsWith("--"));
const [source, repoArg] = positional;

const chainNames = stageNames(project.stages);

function isStageName(value: string): value is StageName {
  return chainNames.includes(value);
}

function injectedFailures(): Set<string> {
  const keys = new Set<string>();
  for (const arg of args) {
    if (!arg.startsWith("--fail=")) continue;
    const [itemPart, stagePart] = arg.slice("--fail=".length).split(":");
    if (!itemPart || !stagePart || !/^\d+$/.test(itemPart) || !isStageName(stagePart)) {
      fail(`--fail must be <item-number>:<${chainNames.join("|")}>, got "${arg}"`);
    }
    keys.add(`${itemPart}:${stagePart}`);
  }
  return keys;
}

if (!source) {
  console.error(USAGE);
  process.exit(2);
}

const hubRepo = repoArg ?? project.hubRepo;
const fixture = /^\d+$/.test(source) ? undefined : source;
const namedParent = fixture ? undefined : Number(source);
const mode: RunMode = fixture || args.includes("--dry") ? "dry" : "real";
const cap = flagNumber(args, "cap", 1);
const parallelLimit = optionalFlagNumber(args, "parallel");
const sequential = args.includes("--sequential");
const globalCapFlag = optionalFlagNumber(args, "global-cap");

if (args.includes("--parallel")) fail("--parallel needs a count: --parallel=N");
if (parallelLimit !== undefined && sequential) fail("--parallel and --sequential cannot both be set");
const port = (() => {
  try {
    return resolveUiPort(args, process.env, project.ui.port);
  } catch (cause) {
    return fail(messageOf(cause));
  }
})();
const pollIntervalSeconds = flagNumber(args, "interval", 45);
const idleTimeoutSeconds = optionalFlagNumber(args, "idle-timeout");
const skipGc = args.includes("--skip-gc");
const skipVerify = args.includes("--skip-verify");
const pendingFailures = injectedFailures();

if (pendingFailures.size > 0 && mode !== "dry") fail("--fail only applies to a dry run (add --dry or pass a fixture)");

async function readFixture(path: string): Promise<RunSnapshot> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRunSnapshot(parsed)) throw new Error(`${path} is not a RunSnapshot fixture (expected { parent, subIssues[] })`);
  return parsed;
}

async function loadSnapshot(parentNumber: number): Promise<RunSnapshot> {
  if (!fixture) return fetchRunSnapshot(hubRepo, parentNumber);
  const snapshot = await readFixture(fixture);
  if (snapshot.parent.number !== parentNumber) {
    throw new Error(`fixture ${fixture} publishes parent #${snapshot.parent.number}, not #${parentNumber}`);
  }
  return snapshot;
}

async function listParents(): Promise<ParentSummary[]> {
  if (!fixture) return fetchSandcastleParents(hubRepo);
  const snapshot = await readFixture(fixture);
  return [
    {
      number: snapshot.parent.number,
      title: snapshot.parent.title,
      subIssues: snapshot.subIssues.length,
      completedSubIssues: snapshot.subIssues.filter((sub) => sub.state === "CLOSED").length,
    },
  ];
}

function failStage(pending: PendingStage): string | undefined {
  const key = `${pending.itemNumber}:${pending.stage}`;
  if (!pendingFailures.delete(key)) return undefined;
  return `injected failure — the ui was started with --fail=${key}`;
}

function envNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const log = (message: string): void => console.log(message);

function loadQueue(): RunQueue {
  const defaults = { globalCap: cap, parentCap: cap };
  if (mode === "dry") return new RunQueue(undefined, defaults, () => undefined);
  const path = queueFilePath(resolveLayout(nodeFileSystem));
  const restored = loadQueueFile(nodeFileSystem, path, (message) => console.error(`[queue][warn] ${message}`));
  return new RunQueue(restored, defaults, (file) => saveQueueFile(nodeFileSystem, path, file));
}

function buildQueue(): RunQueue {
  const queue = loadQueue();
  if (parallelLimit !== undefined) queue.setMode("parallel", parallelLimit);
  if (sequential) queue.setMode("sequential");
  if (globalCapFlag !== undefined) queue.setGlobalCap(globalCapFlag);
  return queue;
}

const queue = buildQueue();

const host =
  mode === "real"
    ? controlPlaneHost({ hubRepo, idleTimeoutSeconds, skipGc, globalCap: queue.settings().globalCap, log })
    : undefined;

function startSession(request: StartSessionRequest) {
  if (!host) return dryRunSession(request, { now: () => Date.now(), failStage });
  return realSession(request, {
    host,
    pollIntervalSeconds,
    skipVerify,
    log,
  });
}

async function resetDeps(parentNumber: number): Promise<ResetDeps> {
  const snapshot = await loadSnapshot(parentNumber);
  const result = loadRunModel(snapshot);
  if (!result.ok) {
    throw new OperatorError(
      `#${parentNumber} does not satisfy the publish contract, so reset cannot tell which items are its own:\n- ${result.errors.join("\n- ")}`,
    );
  }
  return {
    runner: new NodeCommandRunner(),
    fs: nodeFileSystem,
    layout: defaultLayout(),
    model: result.model,
    issues: snapshot.subIssues,
    hubRepo,
    isAlive: processIsAlive,
    log: (message: string) => console.log(message),
  };
}

const reset: ResetOps | undefined =
  mode === "real"
    ? {
        plan: async (parentNumber: number) => planReset(await resetDeps(parentNumber)),
        apply: async (parentNumber: number) => {
          const deps = await resetDeps(parentNumber);
          return applyReset(deps, planReset(deps));
        },
      }
    : undefined;

const controller = new UiController({
  mode,
  hubRepo,
  startCap: cap,
  preselectedParent: namedParent,
  listParents,
  loadSnapshot,
  startSession,
  queue,
  globalCap: host ? { get: () => host.globalCap(), set: (value: number) => host.setGlobalCap(value) } : undefined,
  reset,
  now: () => new Date(),
  idleTimeoutSeconds: clampIdleTimeout(idleTimeoutSeconds ?? envNumber(process.env["SANDCASTLE_IDLE_TIMEOUT"])),
});

const server = await startUiServer(controller, port).catch((cause: unknown) => {
  return fail(messageOf(cause));
});

const ticker = setInterval(() => controller.tick(), TICK_MS);

console.log(`sandcastle ui (${mode}) — ${server.url}`);
console.log(`  hub: ${hubRepo}${fixture ? `, fixture: ${fixture}` : ""}`);

if (mode === "dry") {
  const parents = await listParents();
  const target = namedParent ?? parents[0]?.number;
  const summary = parents.find((parent) => parent.number === target);
  if (target === undefined) console.error("  nothing to simulate — no sandcastle parent to start");
  else {
    await controller.startRun({ parent: target, cap }).catch((cause: unknown) => {
      console.error(messageOf(cause));
    });
    console.log(`  paced dry run started — #${target} ${summary?.title ?? ""}, cap ${cap}`);
  }
} else {
  console.log(`  real mode — press start in the browser to spend tokens on #${namedParent ?? ""}`);
  const restored = queue.parents();
  if (restored.length > 0) {
    console.log(`  restored queue ${parentList(restored)} — paused until resumed`);
  }
}

const stop = (): void => {
  clearInterval(ticker);
  controller.stop();
  void server.close().then(() => process.exit(0), () => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
