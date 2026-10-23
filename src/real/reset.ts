import { STAGE_LABELS, type StageLabel } from "../engine/adapters.js";
import { itemBranch } from "../engine/engine.js";
import { OperatorError } from "../engine/operatorError.js";
import type { RunModel, TargetRepo } from "../model/runModel.js";
import type { CommandRunner } from "./commandRunner.js";
import type { FileSystemPort } from "./fileSystem.js";
import { collectOrphans, findOrphans, type GcReport, type OrphanInventory } from "./gc.js";
import { parentLogsDir } from "./attemptLog.js";
import { lockPath } from "./lock.js";
import { repoRoot, type SandcastleLayout } from "./paths.js";
import { messageOf } from "../messageOf.js";

export const ORCHESTRATOR_LABELS: readonly StageLabel[] = STAGE_LABELS;

export interface ResetIssue {
  number: number;
  state: "OPEN" | "CLOSED";
  labels: readonly string[];
}

export interface ResetDeps {
  runner: CommandRunner;
  fs: FileSystemPort;
  layout: SandcastleLayout;
  model: RunModel;
  issues: readonly ResetIssue[];
  hubRepo: string;
  isAlive: (pid: number) => boolean;
  log: (message: string) => void;
}

export interface LockPlan {
  path: string;
  reclaim: boolean;
  pid: number | undefined;
}

export interface LabelPlan {
  itemNumber: number;
  remove: StageLabel[];
  swapToAgent: boolean;
}

export interface BranchPlan {
  repo: TargetRepo;
  branch: string;
  localExists: boolean;
  remoteExists: boolean;
  commitsAhead: number | undefined;
  removable: boolean;
  verdict: string;
}

export interface ResetPlan {
  lock: LockPlan;
  labels: LabelPlan[];
  branches: BranchPlan[];
  orphans: OrphanInventory;
}

export interface ResetReport {
  gc: GcReport;
  lockReclaimed: boolean;
  labelled: number[];
  deletedBranches: string[];
  removedLogs?: string;
  failures: string[];
}

function shortMessageOf(cause: unknown): string {
  return messageOf(cause).slice(0, 300);
}

function involvedRepos(model: RunModel): TargetRepo[] {
  return [...new Set(model.items.map((item) => item.repo))];
}

function parsePid(raw: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const { pid } = parsed as Record<string, unknown>;
    return typeof pid === "number" ? pid : undefined;
  } catch {
    return undefined;
  }
}

function planLock(deps: ResetDeps): LockPlan {
  const path = lockPath(deps.layout);
  const raw = deps.fs.readText(path);
  if (raw === undefined) return { path, reclaim: false, pid: undefined };
  const pid = parsePid(raw);
  if (pid !== undefined && deps.isAlive(pid)) {
    throw new OperatorError(
      `a sandcastle orchestrator is still running (pid ${pid}) — stop it before resetting, or reset would garbage-collect its containers`,
    );
  }
  return { path, reclaim: true, pid };
}

function planLabels(deps: ResetDeps): LabelPlan[] {
  const plans: LabelPlan[] = [];
  const inRun = new Set(deps.model.items.map((item) => item.number));
  for (const issue of deps.issues) {
    if (!inRun.has(issue.number)) continue;
    if (issue.state === "CLOSED") continue;
    if (issue.labels.includes("sc:done")) continue;
    const remove = ORCHESTRATOR_LABELS.filter((label) => issue.labels.includes(label));
    const swapToAgent = issue.labels.includes("sc:needs-human") && issue.labels.includes("ready-for-human");
    if (remove.length === 0 && !swapToAgent) continue;
    plans.push({ itemNumber: issue.number, remove, swapToAgent });
  }
  return plans;
}

function countAhead(deps: ResetDeps, cwd: string, tip: string, base: string): number | undefined {
  try {
    const { stdout } = deps.runner.run({ command: "git", args: ["rev-list", "--count", `${base}..${tip}`], cwd });
    const printed = stdout.trim();
    if (printed.length === 0) return undefined;
    const count = Number(printed);
    return Number.isInteger(count) && count >= 0 ? count : undefined;
  } catch {
    return undefined;
  }
}

function refExists(deps: ResetDeps, cwd: string, ref: string): boolean {
  try {
    const { stdout } = deps.runner.run({ command: "git", args: ["rev-parse", "--verify", "--quiet", ref], cwd });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

function planBranch(deps: ResetDeps, repo: TargetRepo, cwd: string, branch: string): BranchPlan {
  const base = `origin/${deps.model.integrationBranch}`;
  const localExists = refExists(deps, cwd, `refs/heads/${branch}`);
  const remoteExists = refExists(deps, cwd, `refs/remotes/origin/${branch}`);
  const plan: BranchPlan = {
    repo,
    branch,
    localExists,
    remoteExists,
    commitsAhead: undefined,
    removable: false,
    verdict: "",
  };
  if (!localExists && !remoteExists) return { ...plan, verdict: "no branch" };
  if (!refExists(deps, cwd, base)) {
    return { ...plan, verdict: `${base} is missing — cannot tell whether the branch carries work, keeping it` };
  }
  const counts = [
    localExists ? countAhead(deps, cwd, branch, base) : 0,
    remoteExists ? countAhead(deps, cwd, `origin/${branch}`, base) : 0,
  ];
  const counted = counts.filter((count): count is number => count !== undefined);
  if (counted.length !== counts.length) {
    return { ...plan, verdict: "git could not count its commits, keeping it" };
  }
  const commitsAhead = Math.max(...counted);
  if (commitsAhead > 0) {
    return { ...plan, commitsAhead, verdict: `${commitsAhead} commit(s) beyond ${base} — somebody's work, keeping it` };
  }
  return { ...plan, commitsAhead, removable: true, verdict: `empty beyond ${base}` };
}

function uninspectableBranch(repo: TargetRepo, branch: string, cwd: string): BranchPlan {
  return {
    repo,
    branch,
    localExists: false,
    remoteExists: false,
    commitsAhead: undefined,
    removable: false,
    verdict: `no checkout at ${cwd} — reset cannot see this repo's branches`,
  };
}

function itemsOf(deps: ResetDeps, repo: TargetRepo): string[] {
  return deps.model.items.filter((item) => item.repo === repo).map((item) => itemBranch(item));
}

function planBranches(deps: ResetDeps): BranchPlan[] {
  const plans: BranchPlan[] = [];
  for (const repo of involvedRepos(deps.model)) {
    const cwd = repoRoot(deps.layout, repo);
    if (!deps.fs.exists(cwd)) {
      plans.push(...itemsOf(deps, repo).map((branch) => uninspectableBranch(repo, branch, cwd)));
      continue;
    }
    try {
      deps.runner.run({ command: "git", args: ["fetch", "origin", "--prune"], cwd });
    } catch (cause) {
      deps.log(`[reset][warn] [${repo}] fetch failed, working off the local view: ${shortMessageOf(cause)}`);
    }
    for (const branch of itemsOf(deps, repo)) plans.push(planBranch(deps, repo, cwd, branch));
  }
  return plans;
}

export function planReset(deps: ResetDeps): ResetPlan {
  const lock = planLock(deps);
  const orphans = findOrphans({ runner: deps.runner, fs: deps.fs, layout: deps.layout, log: () => undefined, repos: involvedRepos(deps.model) });
  return { lock, labels: planLabels(deps), branches: planBranches(deps), orphans };
}

function applyLabels(deps: ResetDeps, plans: readonly LabelPlan[], report: ResetReport): void {
  for (const plan of plans) {
    const args = ["issue", "edit", String(plan.itemNumber), "--repo", deps.hubRepo];
    for (const label of plan.remove) args.push("--remove-label", label);
    if (plan.swapToAgent) args.push("--remove-label", "ready-for-human", "--add-label", "ready-for-agent");
    try {
      deps.runner.run({ command: "gh", args });
      report.labelled.push(plan.itemNumber);
      deps.log(`[reset] #${plan.itemNumber} labels reverted`);
    } catch (cause) {
      report.failures.push(`gh issue edit #${plan.itemNumber} failed: ${shortMessageOf(cause)}`);
    }
  }
}

function applyBranches(deps: ResetDeps, plans: readonly BranchPlan[], report: ResetReport): void {
  for (const plan of plans) {
    if (!plan.removable) continue;
    const cwd = repoRoot(deps.layout, plan.repo);
    let deleted = false;
    if (plan.localExists) {
      try {
        deps.runner.run({ command: "git", args: ["branch", "-D", plan.branch], cwd });
        deleted = true;
      } catch (cause) {
        report.failures.push(`[${plan.repo}] git branch -D ${plan.branch} failed: ${shortMessageOf(cause)}`);
        continue;
      }
    }
    if (plan.remoteExists) {
      try {
        deps.runner.run({ command: "git", args: ["push", "origin", "--delete", plan.branch], cwd });
        deleted = true;
      } catch (cause) {
        report.failures.push(`[${plan.repo}] git push origin --delete ${plan.branch} failed: ${shortMessageOf(cause)}`);
      }
    }
    if (!deleted) continue;
    report.deletedBranches.push(`[${plan.repo}] ${plan.branch}`);
    deps.log(`[reset] deleted empty branch [${plan.repo}] ${plan.branch}`);
  }
}

export function applyReset(deps: ResetDeps, plan: ResetPlan): ResetReport {
  const report: ResetReport = {
    gc: { containers: [], networks: [], volumes: [], worktrees: [], failures: [] },
    lockReclaimed: false,
    labelled: [],
    deletedBranches: [],
    failures: [],
  };

  report.gc = collectOrphans({
    runner: deps.runner,
    fs: deps.fs,
    layout: deps.layout,
    log: deps.log,
    repos: involvedRepos(deps.model),
  });

  if (plan.lock.reclaim) {
    try {
      deps.fs.removeFile(plan.lock.path);
      report.lockReclaimed = true;
      deps.log(`[reset] reclaimed the stale lock at ${plan.lock.path}`);
    } catch (cause) {
      report.failures.push(`could not remove ${plan.lock.path}: ${shortMessageOf(cause)}`);
    }
  }

  applyLabels(deps, plan.labels, report);
  applyBranches(deps, plan.branches, report);
  removeAttemptLogs(deps, report);
  return report;
}

function removeAttemptLogs(deps: ResetDeps, report: ResetReport): void {
  const directory = parentLogsDir(deps.layout, deps.model.parentNumber);
  if (!deps.fs.exists(directory)) return;
  try {
    deps.fs.removeDirectory(directory);
    report.removedLogs = directory;
    deps.log(`[reset] removed the agent transcripts under ${directory}`);
  } catch (cause) {
    report.failures.push(`could not remove ${directory}: ${shortMessageOf(cause)}`);
  }
}
