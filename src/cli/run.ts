import { bootProject } from "../project/boot.js";
import { dryRun } from "../engine/dryRunner.js";
import { fetchRunSnapshot } from "../gh/snapshot.js";
import { loadRunModel, type RunModel } from "../model/runModel.js";
import { startRealRun } from "../real/startRealRun.js";
import { epilogueLines, featureVerifyLines, polishLines, stallLine } from "./report.js";

const USAGE = [
  "usage: npm run start -- <parent-issue> [owner/repo] [--cap=N] [--interval=N] [--idle-timeout=N] [--skip-gc] [--skip-verify] [--dry-run]",
  "  --cap=N            concurrent workers (default 1)",
  "  --interval=N       parent-issue poll interval in seconds (default 45)",
  "  --idle-timeout=N   per-agent idle timeout in seconds (default SANDCASTLE_IDLE_TIMEOUT or 1200, clamped to [60, 7200])",
  "  --skip-gc          skip startup cleanup of orphan sandcastle containers + worktrees",
  "  --skip-verify      skip the once-per-feature Feature Verify stage (hub tooling / bootstrap only)",
  "  --dry-run          scheduling simulation with fake adapters — no docker, no git, no gh writes",
].join("\n");

const project = bootProject();
const args = process.argv.slice(2);
const positional = args.filter((arg) => !arg.startsWith("--"));
const [parentArg, repoArg] = positional;

function flagNumber(name: string, fallback: number): number {
  const found = args.find((arg) => arg.startsWith(`--${name}=`));
  if (!found) return fallback;
  const value = Number(found.slice(name.length + 3));
  if (!Number.isInteger(value) || value < 1) fail(`--${name} must be a positive integer, got "${found}"`);
  return value;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (!parentArg || !/^\d+$/.test(parentArg)) {
  console.error(USAGE);
  process.exit(2);
}

const parentNumber = Number(parentArg);
const workerCap = flagNumber("cap", 1);
const intervalSeconds = flagNumber("interval", 45);
const idleTimeoutSeconds = args.some((arg) => arg.startsWith("--idle-timeout=")) ? flagNumber("idle-timeout", 600) : undefined;
const skipGc = args.includes("--skip-gc");
const skipVerify = args.includes("--skip-verify");
const isDryRun = args.includes("--dry-run");
const hubRepo = repoArg ?? project.hubRepo;

function loadModel(snapshotRepo: string, issue: number): Promise<RunModel> {
  return fetchRunSnapshot(snapshotRepo, issue).then((snapshot) => {
    const result = loadRunModel(snapshot);
    if (result.ok) return result.model;
    throw new Error(`INVALID run model:\n  - ${result.errors.join("\n  - ")}`);
  });
}

const model = await loadModel(hubRepo, parentNumber).catch((cause: unknown) => {
  fail(cause instanceof Error ? cause.message : String(cause));
});

if (isDryRun) {
  console.log(`DRY RUN — ${model.title} (#${model.parentNumber}), cap ${workerCap}`);
  console.log(`  feature: ${model.feature} → ${model.integrationBranch}`);
  const { lines, phases } = dryRun(model, workerCap);
  for (const line of lines) console.log(`  ${line}`);
  console.log("");
  for (const [number, phase] of [...phases].sort(([a], [b]) => a - b)) console.log(`  #${number} ${phase.toUpperCase()}`);
  process.exit(0);
}

const log = (message: string) => console.log(message);

const run = await (async () => {
  try {
    return await startRealRun({
      model,
      workerCap,
      hubRepo,
      pollIntervalSeconds: intervalSeconds,
      idleTimeoutSeconds,
      skipGc,
      skipVerify,
      log,
      onSnapshotApplied: (engine) => {
        const stalled = engine.stalled();
        if (stalled) log(stallLine(stalled));
      },
    });
  } catch (cause) {
    return fail(cause instanceof Error ? cause.message : String(cause));
  }
})();

let stopping = false;
const stop = () => {
  if (stopping) process.exit(130);
  stopping = true;
  log("[stop] finishing the poll in flight, then exiting — Ctrl+C again to force");
  run.stop();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

await run.finished;

for (const line of epilogueLines(run.engine.phases())) log(line);
for (const line of featureVerifyLines(run.featureVerify())) log(line);
for (const line of polishLines(run.polish())) log(line);
