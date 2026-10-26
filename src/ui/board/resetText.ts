import type { ResetPlan, ResetReport } from "../../real/reset.js";

const none = (values: readonly string[]): string => (values.length === 0 ? "(none)" : values.join(", "));

/** Dry plan of a reset, as the operator reads it before applying. */
export function planLines(plan: ResetPlan): string {
  const lines = [
    "docker + worktrees",
    `  containers: ${none(plan.orphans.containers)}`,
    `  networks:   ${none(plan.orphans.networks)}`,
    `  volumes:    ${none(plan.orphans.volumes)}`,
    `  worktrees:  ${none(plan.orphans.worktrees)}`,
    ...plan.orphans.failures.map((failure) => `  [warn] ${failure} — this inventory is incomplete`),
    "",
    "lock",
    plan.lock.reclaim ? `  stale lock (pid ${plan.lock.pid ?? "unreadable"})` : "  no lock file",
    "",
    "labels",
  ];
  if (plan.labels.length === 0) lines.push("  (nothing to revert)");
  for (const label of plan.labels) {
    const parts = label.remove.map((name) => `-${name}`);
    if (label.swapToAgent) parts.push("-ready-for-human", "+ready-for-agent");
    lines.push(`  #${label.itemNumber} ${parts.join(" ")}`);
  }
  lines.push("", "item branches");
  for (const branch of plan.branches) {
    lines.push(`  ${branch.removable ? "DELETE" : "keep  "} [${branch.repo}] ${branch.branch} — ${branch.verdict}`);
  }
  return lines.join("\n");
}

export function reportLines(report: ResetReport): string {
  const { gc } = report;
  const lines = [
    `removed ${gc.containers.length} container(s), ${gc.networks.length} network(s), ${gc.volumes.length} volume(s), ${gc.worktrees.length} worktree(s)`,
    `lock ${report.lockReclaimed ? "reclaimed" : "untouched"}`,
    `${report.labelled.length} item(s) relabelled: ${report.labelled.length === 0 ? "(none)" : report.labelled.join(", ")}`,
    `${report.deletedBranches.length} branch(es) deleted: ${none(report.deletedBranches)}`,
    ...gc.failures.map((failure) => `[gc][warn] ${failure}`),
    ...report.failures.map((failure) => `[warn] ${failure}`),
  ];
  return lines.join("\n");
}
