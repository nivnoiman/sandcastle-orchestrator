import { bootProject } from "../project/boot.js";
import { OperatorError } from "../engine/operatorError.js";
import { fetchRunSnapshot } from "../gh/snapshot.js";
import { loadRunModel } from "../model/runModel.js";
import { NodeCommandRunner } from "../real/commandRunner.js";
import { nodeFileSystem } from "../real/fileSystem.js";
import { processIsAlive } from "../real/lock.js";
import { defaultLayout } from "../real/paths.js";
import { applyReset, planReset, type ResetDeps } from "../real/reset.js";

const project = bootProject();
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const [issueArg, repoArg] = args.filter((arg) => !arg.startsWith("--"));

if (!issueArg || !/^\d+$/.test(issueArg)) {
  console.error("usage: npm run reset -- <parent-issue-number> [owner/repo] [--apply]");
  process.exit(2);
}

const hubRepo = repoArg ?? project.hubRepo;
const snapshot = await fetchRunSnapshot(hubRepo, Number(issueArg));
const result = loadRunModel(snapshot);
if (!result.ok) {
  console.error(`INVALID — #${issueArg} does not satisfy the publish contract, so reset cannot tell which items are its own:`);
  for (const error of result.errors) console.error(`  - ${error}`);
  process.exit(1);
}

const { model } = result;
const deps: ResetDeps = {
  runner: new NodeCommandRunner(),
  fs: nodeFileSystem,
  layout: defaultLayout(),
  model,
  issues: snapshot.subIssues,
  hubRepo,
  isAlive: processIsAlive,
  log: (message) => console.log(message),
};

function fail(cause: unknown): never {
  if (cause instanceof OperatorError) {
    console.error(cause.message);
    process.exit(1);
  }
  throw cause;
}

const plan = (() => {
  try {
    return planReset(deps);
  } catch (cause) {
    return fail(cause);
  }
})();

console.log(`RESET ${apply ? "(--apply)" : "(dry run — nothing is changed)"} — ${model.title} (#${model.parentNumber})`);
console.log(`  integration branch: ${model.integrationBranch}`);
console.log("");

console.log("docker + worktree debris:");
console.log(`  containers: ${plan.orphans.containers.join(", ") || "(none)"}`);
console.log(`  networks:   ${plan.orphans.networks.join(", ") || "(none)"}`);
console.log(`  volumes:    ${plan.orphans.volumes.join(", ") || "(none)"}`);
console.log(`  worktrees:  ${plan.orphans.worktrees.join(", ") || "(none)"}`);
for (const failure of plan.orphans.failures) console.log(`  [warn] ${failure}`);
console.log("");

console.log("lock:");
console.log(plan.lock.reclaim ? `  stale lock (pid ${plan.lock.pid ?? "unreadable"}) at ${plan.lock.path}` : "  no lock file");
console.log("");

console.log("labels:");
if (plan.labels.length === 0) console.log("  (nothing to revert)");
for (const label of plan.labels) {
  const parts = [
    ...label.remove.map((name) => `-${name}`),
    ...(label.swapToAgent ? ["-ready-for-human", "+ready-for-agent"] : []),
  ];
  console.log(`  #${label.itemNumber} ${parts.join(" ")}`);
}
console.log("");

console.log("item branches:");
for (const branch of plan.branches) {
  const where = [branch.localExists ? "local" : undefined, branch.remoteExists ? "origin" : undefined]
    .filter((part) => part !== undefined)
    .join("+");
  console.log(`  ${branch.removable ? "DELETE" : "keep  "} [${branch.repo}] ${branch.branch} (${where || "absent"}) — ${branch.verdict}`);
}
console.log("");

if (!apply) {
  const deletable = plan.branches.filter((branch) => branch.removable).length;
  console.log(`re-run with --apply to garbage-collect, reclaim the lock, revert ${plan.labels.length} item label set(s)` +
    ` and delete ${deletable} empty branch(es).`);
  process.exit(0);
}

const report = applyReset(deps, plan);
console.log("");
console.log(
  `applied — removed ${report.gc.containers.length} container(s), ${report.gc.networks.length} network(s),` +
    ` ${report.gc.volumes.length} volume(s), ${report.gc.worktrees.length} worktree(s);` +
    ` lock ${report.lockReclaimed ? "reclaimed" : "untouched"};` +
    ` ${report.labelled.length} item(s) relabelled; ${report.deletedBranches.length} branch(es) deleted`,
);
for (const failure of report.gc.failures) console.log(`  [gc][warn] ${failure}`);
for (const failure of report.failures) console.log(`  [warn] ${failure}`);
process.exit(report.failures.length > 0 ? 1 : 0);
