import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rawArchiveArgs, seedRecheckHistoryCommand } from "../../../src/real/featureVerify/recheck.js";

const GIT_IDENTITY = ["-c", "user.name=test", "-c", "user.email=test@localhost", "-c", "commit.gpgsign=false"];

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...GIT_IDENTITY, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function bashPath(): string | undefined {
  if (process.platform !== "win32") return "bash";
  const execPath = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
  const gitBash = join(dirname(dirname(dirname(execPath))), "bin", "bash.exe");
  return existsSync(gitBash) ? gitBash : undefined;
}

function commitAll(repo: string, message: string): string {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]).trim();
}

function crlfRepo(root: string): { repo: string; base: string; head: string } {
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-q", repo]);
  git(repo, ["config", "core.autocrlf", "true"]);
  writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
  writeFileSync(join(repo, "b.txt"), "keep\n");
  writeFileSync(join(repo, "gone.txt"), "bye\n");
  const base = commitAll(repo, "base");
  writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(repo, "c.txt"), "new\n");
  rmSync(join(repo, "gone.txt"));
  const head = commitAll(repo, "head");
  for (const file of ["a.txt", "b.txt", "c.txt"]) rmSync(join(repo, file));
  git(repo, ["checkout", "--", "."]);
  return { repo, base, head };
}

function copyWorktree(repo: string, target: string): void {
  cpSync(repo, target, { recursive: true, filter: (source) => !source.split(/[\\/]/).includes(".git") });
}

const bash = bashPath();
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(bash === undefined)("recheck history under core.autocrlf=true", { timeout: 30_000 }, () => {
  function setup() {
    const root = mkdtempSync(join(tmpdir(), "sc-recheck-"));
    roots.push(root);
    const fixture = crlfRepo(root);
    expect(readFileSync(join(fixture.repo, "a.txt"), "utf8")).toBe("one\r\ntwo\r\nthree\r\n");
    return { root, ...fixture };
  }

  it("reverse-applying an LF patch onto the CRLF working copy fails in a container git", () => {
    const { root, repo, base, head } = setup();
    const copy = join(root, "copy");
    copyWorktree(repo, copy);
    writeFileSync(join(root, "lf.patch"), git(repo, ["diff", "--binary", base, head]));
    execFileSync("git", ["init", "-q", copy]);
    const reverse = spawnSync("git", ["-c", "core.autocrlf=false", "apply", "-R", "--check", join(root, "lf.patch")], { cwd: copy, encoding: "utf8" });
    expect(reverse.status).not.toBe(0);
  });

  it("seeds a clean two-commit history from raw repo archives", () => {
    const { root, repo, base, head } = setup();
    copyWorktree(repo, join(root, "src"));
    git(repo, rawArchiveArgs(base, join(root, "base.tar")));
    git(repo, rawArchiveArgs(head, join(root, "head.tar")));

    const seeded = spawnSync(bash!, ["-c", seedRecheckHistoryCommand("src", "../base.tar", "../head.tar")], { cwd: root, encoding: "utf8" });
    expect(seeded.stderr).toBe("");
    expect(seeded.status).toBe(0);

    const src = join(root, "src");
    expect(git(src, ["diff", "--name-only", "HEAD~1", "HEAD"]).trim().split("\n")).toEqual(["a.txt", "c.txt", "gone.txt"]);
    expect(git(src, ["status", "--porcelain"])).toBe("");
    expect(git(src, ["show", "HEAD~1:a.txt"])).toBe("one\ntwo\n");
    expect(readFileSync(join(src, "a.txt"), "utf8")).toBe("one\ntwo\nthree\n");
  });
});
