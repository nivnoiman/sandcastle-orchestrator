import { basename, dirname, join, win32 } from "node:path";
import { RebaseConflictError, type GitOps } from "../engine/adapters.js";
import type { TargetRepo } from "../model/runModel.js";
import { integrationBase } from "../project/projectConfig.js";
import type { CommandRunner } from "./commandRunner.js";
import { resolveSandboxEnvFile } from "./env.js";
import type { FileSystemPort } from "./fileSystem.js";
import { repoRoot, worktreePath, type SandcastleLayout } from "./paths.js";

export type GitBranchOps = Omit<GitOps, "runChecks">;

export interface VerifyWorktrees {
  createDetachedWorktree(repo: TargetRepo, ref: string, slug: string): string;
  dropWorktree(repo: TargetRepo, target: string): void;
  remoteRefExists(repo: TargetRepo, branch: string): boolean;
}

export const MAX_CONFLICT_FILES = 40;

const UNMERGED_STATUS = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

export function unmergedPaths(porcelain: string): string[] {
  return porcelain
    .split(/\r?\n/)
    .filter((line) => UNMERGED_STATUS.has(line.slice(0, 2)))
    .map((line) => line.slice(3).trim())
    .filter((path) => path.length > 0)
    .slice(0, MAX_CONFLICT_FILES);
}

export function extendedLengthPath(target: string): string {
  return `\\\\?\\${win32.resolve(target)}`;
}

export function removeWorktreeTree(
  deps: { runner: CommandRunner; fs: FileSystemPort; platform?: NodeJS.Platform | undefined },
  cwd: string,
  target: string,
): void {
  try {
    deps.runner.run({ command: "git", args: ["worktree", "remove", "--force", target], cwd });
    return;
  } catch (cause) {
    if ((deps.platform ?? process.platform) !== "win32") throw cause;
  }
  deps.runner.run({ command: "cmd", args: ["/d", "/c", "rmdir", "/s", "/q", extendedLengthPath(target)], cwd });
  deps.runner.run({ command: "git", args: ["worktree", "prune"], cwd });
  if (deps.fs.exists(target)) throw new Error(`${target} survived both git worktree remove and rmdir /s`);
}

export interface ItemBranchRefs {
  branch: string;
  baseBranch: string;
  remoteExists: boolean;
  localExists: boolean;
}

export function itemBranchWorktreeArgs(refs: ItemBranchRefs, target: string): string[] {
  const { branch, baseBranch, remoteExists, localExists } = refs;
  if (remoteExists) return ["worktree", "add", "--force", "-B", branch, target, `origin/${branch}`];
  const keepWhateverTheKilledRunCommitted = branch;
  if (localExists) return ["worktree", "add", "--force", "-B", branch, target, keepWhateverTheKilledRunCommitted];
  return ["worktree", "add", "--force", "-b", branch, target, `origin/${baseBranch}`];
}

export interface GitOpsDeps {
  runner: CommandRunner;
  fs: FileSystemPort;
  layout: SandcastleLayout;
  log: (message: string) => void;
  now?: () => number;
  platform?: NodeJS.Platform;
}

export function leftoverPatchPath(layout: SandcastleLayout, repo: TargetRepo, worktree: string, stamp: number): string {
  return join(layout.sandcastleDir, "logs", "leftovers", `${repo}-${basename(worktree)}-${stamp}.patch`);
}

export function resolveGitDir(runner: CommandRunner, worktree: string): string {
  const { stdout } = runner.run({ command: "git", args: ["rev-parse", "--absolute-git-dir"], cwd: worktree });
  const gitDir = stdout.trim();
  if (!gitDir) throw new Error(`git rev-parse --absolute-git-dir returned nothing for ${worktree}`);
  return gitDir;
}

export function countCommitsAhead(
  runner: CommandRunner,
  worktree: string,
  integrationBranch: string,
): number {
  const { stdout } = runner.run({
    command: "git",
    args: ["log", `origin/${integrationBranch}..HEAD`, "--format=%h"],
    cwd: worktree,
  });
  return stdout.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

export function isRebasedOnto(runner: CommandRunner, worktree: string, integrationBranch: string): boolean {
  try {
    runner.run({ command: "git", args: ["fetch", "origin", "--prune"], cwd: worktree });
    runner.run({
      command: "git",
      args: ["merge-base", "--is-ancestor", `origin/${integrationBranch}`, "HEAD"],
      cwd: worktree,
    });
    return true;
  } catch {
    return false;
  }
}

export function commitSubjectsAhead(
  runner: CommandRunner,
  worktree: string,
  integrationBranch: string,
): string[] {
  const { stdout } = runner.run({
    command: "git",
    args: ["log", `origin/${integrationBranch}..HEAD`, "--format=%s"],
    cwd: worktree,
  });
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export class RealGitOps implements GitBranchOps {
  constructor(private readonly deps: GitOpsDeps) {}

  createIntegrationBranch(repo: TargetRepo, branch: string): void {
    const cwd = this.repoDir(repo);
    this.git(cwd, ["fetch", "origin", "--prune"]);
    if (this.remoteBranchExists(cwd, branch)) {
      this.deps.log(`[${repo}] integration branch ${branch} already on origin`);
      return;
    }
    this.deps.log(`[${repo}] pushing integration branch ${branch} from origin/${integrationBase()}`);
    this.git(cwd, ["push", "origin", `origin/${integrationBase()}:refs/heads/${branch}`]);
  }

  createItemBranch(repo: TargetRepo, branch: string, baseBranch: string): void {
    const cwd = this.repoDir(repo);
    const target = worktreePath(this.deps.layout, repo, branch);
    this.git(cwd, ["fetch", "origin", "--prune"]);
    this.removeWorktree(cwd, target);
    this.deps.fs.makeDirectory(dirname(target));

    const remoteExists = this.remoteBranchExists(cwd, branch);
    const localExists = remoteExists ? false : this.localBranchExists(cwd, branch);
    if (localExists) this.deps.log(`[${repo}] reusing local ${branch} left behind by an earlier run — its commits are kept`);
    this.git(cwd, itemBranchWorktreeArgs({ branch, baseBranch, remoteExists, localExists }, target));
    this.deps.log(`[${repo}] worktree ${target} on ${branch}`);
    this.installSandboxEnv(repo, target);
  }

  createDetachedWorktree(repo: TargetRepo, ref: string, slug: string): string {
    const cwd = this.repoDir(repo);
    const target = worktreePath(this.deps.layout, repo, slug);
    this.git(cwd, ["fetch", "origin", "--prune"]);
    this.removeWorktree(cwd, target);
    this.deps.fs.makeDirectory(dirname(target));
    this.git(cwd, ["worktree", "add", "--force", "--detach", target, ref]);
    this.deps.log(`[${repo}] detached worktree ${target} at ${ref}`);
    return target;
  }

  dropWorktree(repo: TargetRepo, target: string): void {
    this.removeWorktree(this.repoDir(repo), target);
  }

  remoteRefExists(repo: TargetRepo, branch: string): boolean {
    return this.remoteBranchExists(this.repoDir(repo), branch);
  }

  rebaseOntoIntegration(repo: TargetRepo, branch: string, integrationBranch: string): void {
    const target = worktreePath(this.deps.layout, repo, branch);
    if (!this.deps.fs.exists(target)) {
      throw new Error(`[${repo}] cannot rebase ${branch}: worktree ${target} is gone`);
    }
    this.git(target, ["fetch", "origin", "--prune"]);
    this.discardLeftovers(repo, branch, target);
    try {
      this.git(target, ["rebase", `origin/${integrationBranch}`]);
    } catch (cause) {
      const files = this.conflictedPaths(target);
      this.abortRebase(target);
      const reason = cause instanceof Error ? cause.message : String(cause);
      if (files.length > 0) throw new RebaseConflictError(repo, branch, integrationBranch, files, reason);
      throw new Error(`[${repo}] ${branch} does not rebase cleanly onto ${integrationBranch}: ${reason}`);
    }
    this.git(target, ["push", "--force-with-lease", "origin", branch]);
  }

  syncWithIntegration(repo: TargetRepo, branch: string, integrationBranch: string): string[] {
    try {
      this.rebaseOntoIntegration(repo, branch, integrationBranch);
      return [];
    } catch (cause) {
      if (!(cause instanceof RebaseConflictError)) throw cause;
      this.deps.log(
        `[${repo}] ${branch} no longer rebases onto ${integrationBranch} (${cause.files.join(", ")}) —` +
          " handing the conflict to this stage's agent",
      );
      return [...cause.files];
    }
  }

  worktreeFor(repo: TargetRepo, branch: string): string {
    return worktreePath(this.deps.layout, repo, branch);
  }

  private installSandboxEnv(repo: TargetRepo, target: string): void {
    const source = resolveSandboxEnvFile(this.deps.fs, this.deps.layout, repo);
    this.deps.fs.copyFile(source, join(target, ".env"));
  }

  private removeWorktree(cwd: string, target: string): void {
    if (!this.deps.fs.exists(target)) return;
    this.deps.log(`[gc] removing stale worktree ${target}`);
    try {
      removeWorktreeTree(this.deps, cwd, target);
    } catch (cause) {
      throw new Error(
        `stale worktree ${target} could not be removed by git (${cause instanceof Error ? cause.message : String(cause)}). ` +
          `Remove it with "git worktree remove --force" from ${cwd} — never delete it with rm -rf: it can contain a node_modules junction.`,
      );
    }
  }

  private discardLeftovers(repo: TargetRepo, branch: string, target: string): void {
    const status = this.git(target, ["status", "--porcelain"]).stdout.trim();
    if (status.length === 0) return;
    this.git(target, ["add", "--all"]);
    const patch = this.git(target, ["diff", "--cached", "--binary", "HEAD"]).stdout;
    const saved = leftoverPatchPath(this.deps.layout, repo, target, (this.deps.now ?? Date.now)());
    this.deps.fs.makeDirectory(dirname(saved));
    this.deps.fs.writeText(saved, patch);
    this.git(target, ["reset", "--hard", "HEAD"]);
    this.git(target, ["clean", "-fd"]);
    this.deps.log(`[${repo}] ${branch} had uncommitted leftovers from a killed stage — saved to ${saved} and discarded before rebasing`);
  }

  private conflictedPaths(cwd: string): string[] {
    try {
      return unmergedPaths(this.git(cwd, ["status", "--porcelain"]).stdout);
    } catch (cause) {
      this.deps.log(`[warn] could not list conflicting files in ${cwd}: ${cause instanceof Error ? cause.message : String(cause)}`);
      return [];
    }
  }

  private abortRebase(cwd: string): void {
    try {
      this.git(cwd, ["rebase", "--abort"]);
    } catch {
      this.deps.log(`[warn] rebase --abort failed in ${cwd}; the worktree may need manual cleanup`);
    }
  }

  private remoteBranchExists(cwd: string, branch: string): boolean {
    const { stdout } = this.git(cwd, ["ls-remote", "--heads", "origin", branch]);
    return stdout.trim().length > 0;
  }

  private localBranchExists(cwd: string, branch: string): boolean {
    const { stdout } = this.git(cwd, ["branch", "--list", branch]);
    return stdout.trim().length > 0;
  }

  private repoDir(repo: TargetRepo): string {
    const dir = repoRoot(this.deps.layout, repo);
    if (!this.deps.fs.exists(dir)) {
      throw new Error(`repo checkout not found at ${dir} — set repos.<name>.path in the project config (or SANDCASTLE_WORKSPACE_ROOT) to the local checkout`);
    }
    return dir;
  }

  private git(cwd: string, args: readonly string[]): { stdout: string } {
    return this.deps.runner.run({ command: "git", args, cwd });
  }
}
