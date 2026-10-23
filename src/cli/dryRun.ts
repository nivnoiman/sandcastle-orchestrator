import { bootProject } from "../project/boot.js";
import { readFile } from "node:fs/promises";
import { dryRun } from "../engine/dryRunner.js";
import { fetchRunSnapshot, isRunSnapshot, type RunSnapshot } from "../gh/snapshot.js";
import { loadRunModel } from "../model/runModel.js";

const project = bootProject();
const args = process.argv.slice(2);
const capArg = args.find((arg) => arg.startsWith("--cap="));
const positional = args.filter((arg) => !arg.startsWith("--"));
const [source, repoArg] = positional;

if (!source) {
  console.error("usage: sandcastle dry-run <fixture.json | parent-issue-number> [owner/repo] [--cap=N]");
  process.exit(2);
}

const workerCap = capArg ? Number(capArg.slice("--cap=".length)) : 1;
if (!Number.isInteger(workerCap) || workerCap < 1) {
  console.error(`--cap must be a positive integer, got "${capArg}"`);
  process.exit(2);
}

async function loadSnapshot(fixtureOrIssue: string): Promise<RunSnapshot> {
  if (/^\d+$/.test(fixtureOrIssue)) {
    return fetchRunSnapshot(repoArg ?? project.hubRepo, Number(fixtureOrIssue));
  }
  const raw = await readFile(fixtureOrIssue, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!isRunSnapshot(parsed)) {
    console.error(`${fixtureOrIssue} is not a RunSnapshot fixture (expected { parent, subIssues[] })`);
    process.exit(1);
  }
  return parsed;
}

const snapshot = await loadSnapshot(source);
const result = loadRunModel(snapshot);
if (!result.ok) {
  console.error(`INVALID — ${result.errors.length} error(s):`);
  for (const error of result.errors) console.error(`  - ${error}`);
  process.exit(1);
}

const { model } = result;
console.log(`DRY RUN — ${model.title} (#${model.parentNumber}), cap ${workerCap}`);
console.log(`  feature: ${model.feature} → ${model.integrationBranch}`);
console.log(`  items: ${model.items.map((item) => `#${item.number}`).join(", ")}`);
console.log("");

const { lines, phases } = dryRun(model, workerCap);
for (const line of lines) console.log(`  ${line}`);

console.log("");
console.log("final state:");
for (const [number, phase] of [...phases].sort(([a], [b]) => a - b)) {
  console.log(`  #${number} ${phase.toUpperCase()}`);
}
