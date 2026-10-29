import { bootProject } from "../project/boot.js";
import { createRunReader } from "../tracker/index.js";
import { loadRunModel } from "../model/runModel.js";
import { parentFromArgs } from "./parentArg.js";

const project = bootProject();
const [issueArg, repoArg] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const parentNumber = parentFromArgs(project, issueArg, "usage: sandcastle validate <parent-issue-number | slug | path> [owner/repo]");

const snapshot = await createRunReader(project, repoArg).fetchRunSnapshot(parentNumber);
const result = loadRunModel(snapshot);

if (!result.ok) {
  console.error(`INVALID — ${result.errors.length} error(s):`);
  for (const error of result.errors) console.error(`  - ${error}`);
  process.exit(1);
}

const { model } = result;
console.log(`VALID — ${model.title} (#${model.parentNumber})`);
console.log(`  feature:            ${model.feature}`);
console.log(`  integration branch: ${model.integrationBranch}`);
console.log(`  memories:           ${model.loadBearingMemories.join(", ") || "(none)"}`);
for (const [targetRepo, paths] of Object.entries(model.requiredReading)) {
  console.log(`  reading (${targetRepo}):  ${(paths ?? []).join(", ")}`);
}
console.log(`  work items (${model.items.length}):`);
for (const item of model.items) {
  const deps = item.dependsOn.length > 0 ? ` ← blocked by ${item.dependsOn.map((dep) => `#${dep}`).join(", ")}` : "";
  console.log(`    #${item.number} [${item.repo}] ${item.admission.toUpperCase().padEnd(6)} ${item.title}${deps}`);
}
