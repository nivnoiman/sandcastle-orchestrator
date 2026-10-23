import { bootProject } from "../project/boot.js";
import { fetchRunSnapshot } from "../gh/snapshot.js";
import { loadRunModel } from "../model/runModel.js";
import { NodeCommandRunner } from "../real/commandRunner.js";
import { loadOrchestratorConfig, resolveLayout } from "../real/env.js";
import { nodeFileSystem } from "../real/fileSystem.js";
import { runPreflight } from "../real/preflight.js";
import { messageOf } from "../messageOf.js";

const USAGE = [
  "usage: sandcastle preflight <parent-issue> [owner/repo] [--skip-verify]",
  "  runs every start-time check without taking the lock or spending tokens on a run",
].join("\n");

const project = bootProject();
const args = process.argv.slice(2);
const positional = args.filter((arg) => !arg.startsWith("--"));
const [parentArg, repoArg] = positional;

if (!parentArg || !/^\d+$/.test(parentArg)) {
  console.error(USAGE);
  process.exit(2);
}

const hubRepo = repoArg ?? project.hubRepo;
const fs = nodeFileSystem;
const layout = resolveLayout(fs);
const runner = new NodeCommandRunner();
const config = (() => {
  try {
    return loadOrchestratorConfig(fs, layout, { hubRepo });
  } catch (cause) {
    console.error(`preflight RED — ${messageOf(cause)}`);
    process.exit(1);
  }
})();

const snapshot = await fetchRunSnapshot(hubRepo, Number(parentArg));
const result = loadRunModel(snapshot);
if (!result.ok) {
  console.error(`#${parentArg} does not satisfy the publish contract:\n  - ${result.errors.join("\n  - ")}`);
  process.exit(1);
}

const report = await runPreflight({
  runner,
  fs,
  layout,
  config,
  model: result.model,
  skipVerify: args.includes("--skip-verify"),
  log: (message: string) => console.log(message),
});

console.log(`\n${report.failures.length === 0 ? "preflight green" : `preflight RED — ${report.failures.length} failure(s)`}`);
process.exit(report.failures.length === 0 ? 0 : 1);
