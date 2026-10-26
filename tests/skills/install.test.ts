import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkSkills, discoverEntries, installSkills, needsInstall, staleSkills } from "../../src/skills/install.js";

let sandbox: string;
let source: string;
let claude: string;

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

const options = () => ({ sourceRoot: source, claudeDir: claude });
const statesByName = () => Object.fromEntries(checkSkills(options()).map(({ entry, state }) => [entry.name, state]));

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "sandcastle-skills-test-"));
  source = join(sandbox, "repo");
  claude = join(sandbox, "claude-home");
  write(join(source, "skills", "simplify", "SKILL.md"), "simplify v1");
  write(join(source, "skills", "vendor", "acme", "tdd", "SKILL.md"), "tdd v1");
  write(join(source, "skills", "vendor", "acme", "tdd", "extra.md"), "extra");
  write(join(source, "skills", "vendor", "acme", "LICENSE"), "MIT");
  write(join(source, "commands", "review.md"), "review v1");
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("skills install", () => {
  it("finds own, vendored and command entries but not the vendor license", () => {
    const found = discoverEntries(source, claude).map((entry) => entry.key);
    expect(found).toEqual(["skills/simplify", "skills/tdd", "commands/review.md"]);
  });

  it("installs everything into a fresh home", () => {
    const result = installSkills(options());

    expect(result.installed).toHaveLength(3);
    expect(readFileSync(join(claude, "skills", "simplify", "SKILL.md"), "utf8")).toBe("simplify v1");
    expect(readFileSync(join(claude, "skills", "tdd", "extra.md"), "utf8")).toBe("extra");
    expect(readFileSync(join(claude, "commands", "review.md"), "utf8")).toBe("review v1");
    expect(statesByName()).toEqual({ simplify: "current", tdd: "current", review: "current" });
  });

  it("updates an untouched copy when the repo moves on", () => {
    installSkills(options());
    write(join(source, "skills", "simplify", "SKILL.md"), "simplify v2");

    expect(statesByName()["simplify"]).toBe("outdated");
    installSkills(options());
    expect(readFileSync(join(claude, "skills", "simplify", "SKILL.md"), "utf8")).toBe("simplify v2");
  });

  it("skips a locally modified copy", () => {
    installSkills(options());
    write(join(claude, "skills", "simplify", "SKILL.md"), "my edit");
    write(join(source, "skills", "simplify", "SKILL.md"), "simplify v2");

    const result = installSkills(options());

    expect(result.skipped.map((entry) => entry.name)).toEqual(["simplify"]);
    expect(readFileSync(join(claude, "skills", "simplify", "SKILL.md"), "utf8")).toBe("my edit");
    expect(statesByName()["simplify"]).toBe("modified");
  });

  it("treats a pre-existing differing copy as modified", () => {
    write(join(claude, "commands", "review.md"), "someone else's review");

    expect(installSkills(options()).skipped.map((entry) => entry.name)).toEqual(["review"]);
  });

  it("overwrites a modified copy with --force", () => {
    installSkills(options());
    write(join(claude, "skills", "tdd", "SKILL.md"), "my edit");
    rmSync(join(claude, "skills", "tdd", "extra.md"));

    installSkills({ ...options(), force: true });

    expect(readFileSync(join(claude, "skills", "tdd", "SKILL.md"), "utf8")).toBe("tdd v1");
    expect(existsSync(join(claude, "skills", "tdd", "extra.md"))).toBe(true);
  });

  it("is not fooled by line endings", () => {
    installSkills(options());
    write(join(source, "commands", "review.md"), "a\r\nb");
    write(join(claude, "commands", "review.md"), "a\nb");

    expect(statesByName()["review"]).toBe("current");
  });
});

describe("skills install --check", () => {
  it("flags missing and outdated, writes nothing, and ignores modified copies", () => {
    expect(staleSkills(options()).stale).toEqual(["skill simplify (missing)", "skill tdd (missing)", "command review (missing)"]);
    expect(existsSync(claude)).toBe(false);

    installSkills(options());
    expect(staleSkills(options()).stale).toEqual([]);

    write(join(claude, "skills", "tdd", "SKILL.md"), "my edit");
    write(join(source, "skills", "simplify", "SKILL.md"), "simplify v2");
    expect(checkSkills(options()).filter(needsInstall).map(({ entry }) => entry.name)).toEqual(["simplify"]);
  });
});
