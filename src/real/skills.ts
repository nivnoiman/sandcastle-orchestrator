import { join } from "node:path";
import type { FileSystemPort } from "./fileSystem.js";
import { CONTAINER_HOME, type SandcastleLayout } from "./paths.js";

export const REQUIRED_SKILLS = ["simplify", "mat-review", "tdd"] as const;
export type RequiredSkill = (typeof REQUIRED_SKILLS)[number];

export function containerSkillPath(skill: RequiredSkill): string {
  return `${CONTAINER_HOME}/.claude/skills/${skill}/SKILL.md`;
}

export function hostSkillPath(layout: SandcastleLayout, skill: RequiredSkill): string {
  return join(layout.claudeDir, "skills", skill, "SKILL.md");
}

export function missingSkillFiles(fs: FileSystemPort, layout: SandcastleLayout): string[] {
  return REQUIRED_SKILLS.map((skill) => hostSkillPath(layout, skill)).filter((path) => !fs.exists(path));
}

export function assertSkillsInstalled(fs: FileSystemPort, layout: SandcastleLayout): void {
  const missing = missingSkillFiles(fs, layout);
  if (missing.length === 0) return;
  throw new Error(
    `missing agent skill file(s) — the develop, simplify and review stages read them from the mounted home, so sandcastle refuses to start:\n  - ${missing.join(
      "\n  - ",
    )}\nInstall them into your ~/.claude (see README → Agent skills), then start sandcastle again.`,
  );
}

/** GNU tar exits 1 for non-fatal warnings (file changed as we read it, cannot stat); only 2+ is a real failure. */
export function tarCopyCommand(fromDir: string, entries: readonly string[], toDir: string): string {
  const sources = entries.map((entry) => `./${entry}`).join(" ");
  return `{ tar -C ${fromDir} --ignore-failed-read -cf - ${sources} | tar -C ${toDir} -xf -; [ $? -le 1 ]; }`;
}
