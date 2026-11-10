import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { mountChangesRoutes, targetOf } from "../../src/ui/changesRoutes.js";
import { SampleChangesSource } from "../../src/ui/changes/sample.js";
import { GitChangesSource, type ChangesSource, type ChangeTarget } from "../../src/ui/changes/source.js";
import { uiItem, uiRun, uiState } from "./board/fixtures.js";

const state = uiState([uiRun(10, [uiItem(1, "done", { branch: "feat/one", repo: "app", pullRequestUrl: "https://github.com/acme/app/pull/7" })])]);

let server: Server | undefined;
const cleanups: string[] = [];

afterEach(() => {
  server?.close();
  server = undefined;
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function serve(source: ChangesSource): Promise<string> {
  const app = express();
  mountChangesRoutes(app, { source, state: () => state, baseBranch: () => "main" });
  server = createServer(app);
  await new Promise<void>((done) => server?.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function get(base: string, path: string): Promise<{ status: number; json: { ok: boolean; result?: any; error?: string } }> {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, json: (await response.json()) as never };
}

describe("targetOf", () => {
  it("resolves an item against its integration branch and a parent against the base branch", () => {
    expect(targetOf(state, 1, "main")).toEqual({ repo: "app", branch: "feat/one", base: "integration/p10", pullRequestUrl: "https://github.com/acme/app/pull/7" });
    expect(targetOf(state, 10, "main")).toMatchObject({ repo: "app", branch: "integration/p10", base: "main" });
    expect(targetOf(state, 99, "main")).toBeUndefined();
  });
});

describe("GET /api/changes", () => {
  it("returns parsed, flagged files for an item", async () => {
    const base = await serve(new SampleChangesSource());
    const { status, json } = await get(base, "/api/changes?item=1");
    expect(status).toBe(200);
    expect(json.result).toMatchObject({ source: "branch", branch: "feat/one", base: "integration/p10", truncated: false, generated: false });
    expect(json.result.totals.files).toBe(7);
    expect(json.result.files.find((file: { path: string }) => file.path === "package-lock.json").hunks).toEqual([]);
    const withLocks = await get(base, "/api/changes?item=1&generated=1");
    expect(withLocks.json.result.files.find((file: { path: string }) => file.path === "package-lock.json").hunks).toHaveLength(1);
  });

  it("flags a clipped source as truncated", async () => {
    const clipped: ChangesSource = { diff: () => Promise.resolve({ source: "branch", text: "", clipped: true }), file: () => Promise.reject(new Error("unused")) };
    const { json } = await get(await serve(clipped), "/api/changes?item=1");
    expect(json.result).toMatchObject({ truncated: true, clipped: true, files: [] });
  });

  it.each(["", "?item=abc", "?item=0", "?item=1;ls", "?item=-1"])("rejects a bad item %j with 400", async (query) => {
    const { status, json } = await get(await serve(new SampleChangesSource()), `/api/changes${query}`);
    expect(status).toBe(400);
    expect(json.ok).toBe(false);
  });

  it("answers 400 for an item that is not in the run and hides internal failures", async () => {
    const base = await serve({ diff: () => Promise.reject(new Error("/secret/path exploded")), file: () => Promise.reject(new Error("x")) });
    expect((await get(base, "/api/changes?item=99")).status).toBe(400);
    const failed = await get(base, "/api/changes?item=1");
    expect(failed.status).toBe(500);
    expect(failed.json.error).toBe("could not read the changes");
  });
});

describe("GET /api/changes/file", () => {
  it("serves file text and refuses traversal, absolute and option-like paths", async () => {
    const base = await serve(new SampleChangesSource());
    const ok = await get(base, `/api/changes/file?item=1&path=${encodeURIComponent("docs/billing.md")}`);
    expect(ok.json.result.text).toContain("# Billing export");
    for (const path of ["../../etc/passwd", "/etc/passwd", "-rf", "a/../../b", ""]) {
      const bad = await get(base, `/api/changes/file?item=1&path=${encodeURIComponent(path)}`);
      expect(bad.status, path).toBe(400);
    }
    expect((await get(base, "/api/changes/file?item=1")).status).toBe(400);
  });

  it("redacts secrets in served file text", async () => {
    const source: ChangesSource = { diff: () => Promise.reject(new Error("x")), file: () => Promise.resolve({ text: "k=ghp_abcdefghijklmnopqrstuvwxyz0123", clipped: false, binary: false }) };
    const { json } = await get(await serve(source), "/api/changes/file?item=1&path=a.md");
    expect(json.result.text).toBe("k=[redacted]");
  });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "ignore" });
}

describe("GitChangesSource", { timeout: 30_000 }, () => {
  function fixtureRepo(): { source: GitChangesSource; target: ChangeTarget; root: string } {
    const dir = mkdtempSync(join(tmpdir(), "changes-git-"));
    cleanups.push(dir);
    const root = join(dir, "app");
    mkdirSync(root);
    git(root, "init", "-q", "-b", "main");
    writeFileSync(join(root, "a.txt"), "one\ntwo\n");
    writeFileSync(join(root, "keep.md"), "# Keep\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "base");
    git(root, "checkout", "-q", "-b", "feat/x");
    writeFileSync(join(root, "a.txt"), "one\nTWO\n");
    writeFileSync(join(root, "new.md"), "# New\n\nbody\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "work");
    git(root, "checkout", "-q", "main");
    const layout = { sandcastleDir: dir, workspaceRoot: dir, worktreesDir: join(dir, "wt"), homeDir: dir, claudeDir: dir, memoryDir: dir, repoRoots: { app: root } };
    return { source: new GitChangesSource(layout), root, target: { repo: "app", branch: "feat/x", base: "main", pullRequestUrl: undefined } };
  }

  it("diffs the branch against its base from the repo checkout and reads a file from the branch", async () => {
    const { source, target } = fixtureRepo();
    const raw = await source.diff(target);
    expect(raw.source).toBe("branch");
    expect(raw.text).toContain("+TWO");
    expect(raw.text).toContain("new file mode");
    const file = await source.file(target, "new.md");
    expect(file).toEqual({ text: "# New\n\nbody\n", clipped: false, binary: false });
  });

  it("refuses to read through a directory link out of the worktree", async () => {
    const { source, target, root } = fixtureRepo();
    const outside = mkdtempSync(join(tmpdir(), "changes-out-"));
    cleanups.push(outside);
    writeFileSync(join(outside, "secret.md"), "TOP SECRET");
    const worktree = join(root, "..", "wt", "app", "feat-x");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, "ok.md"), "fine");
    symlinkSync(outside, join(worktree, "link"), "junction");
    expect((await source.file(target, "ok.md")).text).toBe("fine");
    await expect(source.file(target, "link/secret.md")).rejects.toThrow(/escapes the worktree/);
  });

  it("rejects option-looking refs without running git and a missing branch with a clear error", async () => {
    const { source, target } = fixtureRepo();
    await expect(source.diff({ ...target, branch: "--output=/tmp/pwn" })).rejects.toThrow(/not a plain git branch name/);
    await expect(source.diff({ ...target, base: "a;b" })).rejects.toThrow(/not a plain git branch name/);
    await expect(source.diff({ ...target, branch: "feat/gone" })).rejects.toThrow(/no local branch/);
    await expect(source.file(target, "../outside")).rejects.toThrow(/repo-relative/);
  });
});
