import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertSkillsInstalled,
  containerSkillPath,
  hostSkillPath,
  missingSkillFiles,
  REQUIRED_SKILLS,
} from "../../src/real/skills.js";
import { fsWith, HOME, testLayout } from "./support.js";

const LAYOUT = testLayout();

function installed(...skills: string[]): string[] {
  return skills.map((skill) => join(HOME, ".claude", "skills", skill, "SKILL.md"));
}

describe("skill paths", () => {
  it("resolves the host copy under the host home", () => {
    expect(hostSkillPath(LAYOUT, "mat-review")).toBe(join(HOME, ".claude", "skills", "mat-review", "SKILL.md"));
  });

  it("resolves the container copy under the hydrated container home", () => {
    expect(containerSkillPath("simplify")).toBe("/home/agent/.claude/skills/simplify/SKILL.md");
  });

  it("requires exactly the skills the agent stages read", () => {
    expect([...REQUIRED_SKILLS]).toEqual(["simplify", "mat-review", "tdd"]);
  });
});

describe("launch preflight", () => {
  it("passes when both skill files are on the host", () => {
    const fs = fsWith(Object.fromEntries(installed("mat-review", "simplify", "tdd").map((path) => [path, "---"])));
    expect(missingSkillFiles(fs, LAYOUT)).toEqual([]);
    expect(() => assertSkillsInstalled(fs, LAYOUT)).not.toThrow();
  });

  it("names every missing skill file and the script that installs them", () => {
    const fs = fsWith(Object.fromEntries(installed("mat-review", "tdd").map((path) => [path, "---"])));
    expect(missingSkillFiles(fs, LAYOUT)).toEqual(installed("simplify"));
    expect(() => assertSkillsInstalled(fs, LAYOUT)).toThrow(/simplify[\\/]SKILL\.md/);
    expect(() => assertSkillsInstalled(fs, LAYOUT)).toThrow(/sandcastle skills install/);
  });

  it("refuses to start when no skill is installed", () => {
    const fs = fsWith({});
    expect(missingSkillFiles(fs, LAYOUT)).toHaveLength(3);
    expect(() => assertSkillsInstalled(fs, LAYOUT)).toThrow(/mat-review/);
  });
});
