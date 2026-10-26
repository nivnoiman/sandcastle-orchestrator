import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VENDORED_SKILLS, updateVendor } from "../../src/skills/vendor.js";

let sandbox: string;

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

function git(args: readonly string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "sandcastle-vendor-test-"));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("skills update-vendor", () => {
  it("applies local patches to vendored files and records them in SOURCE", () => {
    const upstream = join(sandbox, "upstream");
    for (const skill of VENDORED_SKILLS) write(join(upstream, "skills", "engineering", skill, "SKILL.md"), "read `GLOSSARY.md` first");
    write(join(upstream, "LICENSE"), "MIT");
    git(["init", "--quiet"], upstream);
    git(["add", "."], upstream);
    git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "init"], upstream);

    const repoRoot = join(sandbox, "repo");
    updateVendor(repoRoot, undefined, `file://${upstream.replaceAll("\\", "/")}`);

    const vendorDir = join(repoRoot, "skills", "vendor", "mattpocock");
    expect(readFileSync(join(vendorDir, "tdd", "SKILL.md"), "utf8")).toBe("read `CONTEXT.md` first");
    expect(readFileSync(join(vendorDir, "SOURCE"), "utf8")).toContain("local patches: GLOSSARY.md → CONTEXT.md");
  }, 30_000);
});
