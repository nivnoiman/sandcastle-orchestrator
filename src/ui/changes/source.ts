import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { hostGitEnv } from "../../real/gitGuard.js";
import { repoRoot, worktreePath, type SandcastleLayout } from "../../real/paths.js";

/** What the Changes tab compares: the item (or feature integration) branch against its base. */
export interface ChangeTarget {
  repo: string;
  branch: string;
  base: string;
  pullRequestUrl: string | undefined;
}

export type ChangeSource = "worktree" | "branch" | "pull-request";

export interface RawDiff {
  source: ChangeSource;
  text: string;
  /** Output hit the byte cap and was cut. */
  clipped: boolean;
}

export interface FileText {
  text: string;
  clipped: boolean;
  binary: boolean;
}

/** Seam over git/gh so routes are testable without a repository. */
export interface ChangesSource {
  diff(target: ChangeTarget): Promise<RawDiff>;
  file(target: ChangeTarget, path: string): Promise<FileText>;
}

export const MAX_DIFF_BYTES = 4 * 1024 * 1024;
export const MAX_FILE_BYTES = 512 * 1024;
const TIMEOUT_MS = 20_000;

const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const PR_URL = /^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/\d+$/;

export class ChangesError extends Error {}

export function assertRef(ref: string, what: string): string {
  const bad = !SAFE_REF.test(ref) || ref.includes("..") || ref.endsWith("/") || ref.endsWith(".lock") || ref.includes("//");
  if (bad) throw new ChangesError(`${what} "${ref.slice(0, 80)}" is not a plain git branch name`);
  return ref;
}

/** A repo-relative file path: no traversal, no absolute or option-looking paths. */
export function assertRelativePath(path: string): string {
  const parts = path.split(/[\\/]/);
  const bad =
    path.length === 0 ||
    path.length > 1024 ||
    /[\0-\x1f:]/.test(path) ||
    path.startsWith("-") ||
    /^[A-Za-z]:/.test(path) ||
    path.startsWith("/") ||
    path.startsWith("\\") ||
    parts.some((part) => part === ".." || part === "" || /^\.git[. ]*$/i.test(part));
  if (bad) throw new ChangesError(`"${path.slice(0, 80)}" is not a repo-relative file path`);
  return path;
}

interface Captured {
  stdout: Buffer;
  clipped: boolean;
  code: number | null;
}

function capture(command: string, args: readonly string[], cwd: string, limit: number, env: NodeJS.ProcessEnv): Promise<Captured> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let clipped = false;
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      if (clipped) return;
      const room = limit - size;
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room));
        size = limit;
        clipped = true;
        child.kill();
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });
    child.stderr.resume();
    child.on("error", (cause) => {
      clearTimeout(timer);
      reject(cause);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ stdout: Buffer.concat(chunks), clipped, code });
    });
  });
}

const GIT_ARGS = ["--no-optional-locks", "-c", "core.quotepath=off", "-c", "core.fsmonitor=false"];
const DIFF_ARGS = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M", "--unified=3"];

function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, ...hostGitEnv(), GIT_TERMINAL_PROMPT: "0" };
}

async function git(cwd: string, args: readonly string[], limit = MAX_DIFF_BYTES): Promise<Captured> {
  return capture("git", [...GIT_ARGS, ...args], cwd, limit, gitEnv());
}

async function okText(cwd: string, args: readonly string[]): Promise<string | undefined> {
  const result = await git(cwd, args, 4096).catch(() => undefined);
  if (!result || result.code !== 0) return undefined;
  return result.stdout.toString("utf8").trim() || undefined;
}

async function firstRef(cwd: string, candidates: readonly string[]): Promise<string | undefined> {
  for (const ref of candidates) {
    if (await okText(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])) return ref;
  }
  return undefined;
}

function readCapped(file: string): Buffer {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    return buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0));
  } finally {
    closeSync(fd);
  }
}

function resolveSymlinksStayingInsideWorktreeOutsideGit(worktree: string, full: string): string {
  const real = realpathSync(full);
  const rel = relative(realpathSync(worktree), real);
  const outside = rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || /^\.git([\\/]|$)/i.test(rel);
  if (outside) throw new ChangesError("path escapes the worktree");
  if (!statSync(real).isFile()) throw new ChangesError("not a regular file");
  return real;
}

function textOf(bytes: Buffer): FileText {
  const clipped = bytes.length > MAX_FILE_BYTES;
  const body = clipped ? bytes.subarray(0, MAX_FILE_BYTES) : bytes;
  if (body.includes(0)) return { text: "", clipped: false, binary: true };
  return { text: body.toString("utf8"), clipped, binary: false };
}

export class GitChangesSource implements ChangesSource {
  constructor(private readonly layout: SandcastleLayout) {}

  private dirs(target: ChangeTarget): { root: string; worktree: string | undefined } {
    const root = repoRoot(this.layout, target.repo);
    const worktree = worktreePath(this.layout, target.repo, assertRef(target.branch, "branch"));
    return { root, worktree: existsSync(worktree) ? worktree : undefined };
  }

  async diff(target: ChangeTarget): Promise<RawDiff> {
    assertRef(target.branch, "branch");
    assertRef(target.base, "base branch");
    const { root, worktree } = this.dirs(target);
    if (worktree) {
      const base = await firstRef(worktree, [`origin/${target.base}`, target.base]);
      const mergeBase = base ? await okText(worktree, ["merge-base", base, "HEAD"]) : undefined;
      if (mergeBase) return this.run("worktree", worktree, [...DIFF_ARGS, mergeBase, "--"]);
    }
    if (existsSync(root)) {
      const base = await firstRef(root, [`origin/${target.base}`, target.base]);
      const head = await firstRef(root, [`origin/${target.branch}`, target.branch]);
      if (base && head) return this.run("branch", root, [...DIFF_ARGS, `${base}...${head}`, "--"]);
    }
    return this.pullRequest(target, root);
  }

  private async run(source: ChangeSource, cwd: string, args: readonly string[]): Promise<RawDiff> {
    const result = await git(cwd, args);
    if (result.code !== 0 && !result.clipped) throw new ChangesError("git diff failed; the branch may have been removed");
    return { source, text: result.stdout.toString("utf8"), clipped: result.clipped };
  }

  private async pullRequest(target: ChangeTarget, root: string): Promise<RawDiff> {
    const url = target.pullRequestUrl;
    if (!url || !PR_URL.test(url)) throw new ChangesError(`no local branch ${target.branch} and no pull request to read the changes from`);
    const cwd = existsSync(root) ? root : process.cwd();
    const result = await capture("gh", ["pr", "diff", url, "--color", "never"], cwd, MAX_DIFF_BYTES, process.env);
    if (result.code !== 0 && !result.clipped) throw new ChangesError("gh pr diff failed");
    return { source: "pull-request", text: result.stdout.toString("utf8"), clipped: result.clipped };
  }

  async file(target: ChangeTarget, path: string): Promise<FileText> {
    assertRelativePath(path);
    const { root, worktree } = this.dirs(target);
    if (worktree) {
      const full = resolve(worktree, path);
      if (!full.startsWith(resolve(worktree) + sep)) throw new ChangesError("path escapes the worktree");
      if (existsSync(full)) return textOf(readCapped(resolveSymlinksStayingInsideWorktreeOutsideGit(worktree, full)));
    }
    const ref = await firstRef(root, [`origin/${target.branch}`, target.branch]);
    if (!ref) throw new ChangesError("file is not available: the branch is gone");
    const result = await git(root, ["show", `${ref}:${path}`], MAX_FILE_BYTES + 1);
    if (result.code !== 0 && !result.clipped) throw new ChangesError("file not found on the branch");
    return textOf(result.stdout);
  }
}
