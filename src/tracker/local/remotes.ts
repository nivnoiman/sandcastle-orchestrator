import { dirname, join } from "node:path";
import type { TargetRepo } from "../../model/runModel.js";
import type { CommandRunner } from "../../real/commandRunner.js";
import type { FileSystemPort } from "../../real/fileSystem.js";
import { repoRoot, type SandcastleLayout } from "../../real/paths.js";
import { messageOf } from "../../messageOf.js";

export const REMOTES_FOLDER = "remotes";

export function localRemotePath(layout: SandcastleLayout, repo: TargetRepo): string {
  return join(layout.sandcastleDir, REMOTES_FOLDER, `${repo}.git`);
}

export interface EnsureRemoteDeps {
  runner: CommandRunner;
  fs: FileSystemPort;
  layout: SandcastleLayout;
  integrationBase: string;
  log: (message: string) => void;
}

function git(deps: EnsureRemoteDeps, cwd: string, args: readonly string[]): string {
  return deps.runner.run({ command: "git", args, cwd }).stdout;
}

function hasOrigin(deps: EnsureRemoteDeps, cwd: string): boolean {
  try {
    return git(deps, cwd, ["remote", "get-url", "origin"]).trim().length > 0;
  } catch {
    return false;
  }
}

function branchExists(deps: EnsureRemoteDeps, cwd: string, branch: string): boolean {
  return git(deps, cwd, ["branch", "--list", branch]).trim().length > 0;
}

/**
 * A code repo with no `origin` gets a bare repo under `.sandcastle/remotes/` standing in for one,
 * seeded with the integration base so every `origin/<branch>` ref the git code uses resolves.
 * Returns true when it created the remote, false when `origin` already existed.
 */
export function ensureLocalRemote(deps: EnsureRemoteDeps, repo: TargetRepo): boolean {
  const cwd = repoRoot(deps.layout, repo);
  if (!deps.fs.exists(cwd)) {
    throw new Error(`repo checkout not found at ${cwd} — set repos.${repo}.path in the project config to the local checkout`);
  }
  if (hasOrigin(deps, cwd)) return false;
  try {
    git(deps, cwd, ["rev-parse", "--verify", "HEAD"]);
  } catch (cause) {
    throw new Error(`[${repo}] ${cwd} has no commits yet — commit once so sandcastle can seed its local remote: ${messageOf(cause)}`);
  }
  const bare = localRemotePath(deps.layout, repo);
  deps.fs.makeDirectory(dirname(bare));
  if (!deps.fs.exists(bare)) git(deps, dirname(bare), ["init", "--bare", bare]);
  git(deps, cwd, ["remote", "add", "origin", bare]);
  const source = branchExists(deps, cwd, deps.integrationBase) ? deps.integrationBase : "HEAD";
  git(deps, cwd, ["push", "origin", `${source}:refs/heads/${deps.integrationBase}`]);
  git(deps, cwd, ["fetch", "origin", "--prune"]);
  deps.log(`[${repo}] no origin — using the local bare remote ${bare} (seeded with ${deps.integrationBase})`);
  return true;
}
