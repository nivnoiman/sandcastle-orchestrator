import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { TargetRepo } from "../model/runModel.js";
import { activeProject, claudeProjectSlug } from "../project/projectConfig.js";

export interface SandcastleLayout {
  sandcastleDir: string;
  workspaceRoot: string;
  worktreesDir: string;
  homeDir: string;
  claudeDir: string;
  memoryDir: string;
  repoRoots?: Readonly<Record<TargetRepo, string>>;
}

export const CONTAINER_HOME = "/home/agent";

export const TOOL_DIR = resolve(import.meta.dirname, "..", "..");

export const LAYOUT_SETTINGS = [
  "SANDCASTLE_WORKSPACE_ROOT",
  "SANDCASTLE_WORKTREE_DIR",
  "SANDCASTLE_MEMORY_DIR",
  "SANDCASTLE_CLAUDE_HOME",
] as const;

/** Where Claude Code keeps this project's memories, relative to ~/.claude. */
export function memoryProjectSuffix(): string {
  const project = activeProject();
  return join("projects", project.memoryProject ?? claudeProjectSlug(dirname(project.configPath)), "memory");
}

export function layoutFrom(sandcastleDir: string, home: string, overrides: Partial<SandcastleLayout> = {}): SandcastleLayout {
  const claudeDir = overrides.claudeDir ?? join(home, ".claude");
  const layout: SandcastleLayout = {
    sandcastleDir,
    workspaceRoot: overrides.workspaceRoot ?? dirname(sandcastleDir),
    worktreesDir: overrides.worktreesDir ?? join(sandcastleDir, "worktrees"),
    homeDir: overrides.homeDir ?? home,
    claudeDir,
    memoryDir: overrides.memoryDir ?? join(claudeDir, memoryProjectSuffix()),
  };
  if (overrides.repoRoots) layout.repoRoots = overrides.repoRoots;
  return layout;
}

/** Per-project state (env files, worktrees, logs, lock, queue) — never inside a repo the agents work on. */
export function sandcastleDirFrom(env: NodeJS.ProcessEnv = process.env): string {
  return env["SANDCASTLE_DIR"] ?? activeProject().stateDir ?? join(TOOL_DIR, "projects", activeProject().name);
}

export function claudeJsonPath(layout: SandcastleLayout): string {
  return join(dirname(layout.claudeDir), ".claude.json");
}

export function projectRepoRoots(): Record<TargetRepo, string> {
  return Object.fromEntries(Object.entries(activeProject().repos).map(([name, repo]) => [name, repo.path]));
}

export function defaultLayout(
  env: NodeJS.ProcessEnv = process.env,
  fileValues: Readonly<Record<string, string>> = {},
): SandcastleLayout {
  const setting = (key: (typeof LAYOUT_SETTINGS)[number]): string | undefined => env[key] || fileValues[key] || undefined;
  const overrides: Partial<SandcastleLayout> = {};
  const worktreeOverride = setting("SANDCASTLE_WORKTREE_DIR");
  if (worktreeOverride) overrides.worktreesDir = worktreeOverride;
  const memoryOverride = setting("SANDCASTLE_MEMORY_DIR");
  if (memoryOverride) overrides.memoryDir = memoryOverride;
  const rootOverride = setting("SANDCASTLE_WORKSPACE_ROOT");
  if (rootOverride) overrides.workspaceRoot = rootOverride;
  else overrides.repoRoots = projectRepoRoots();
  const claudeOverride = setting("SANDCASTLE_CLAUDE_HOME");
  if (claudeOverride) overrides.claudeDir = claudeOverride;
  return layoutFrom(sandcastleDirFrom(env), homedir(), overrides);
}

export function repoRoot(layout: SandcastleLayout, repo: TargetRepo): string {
  return layout.repoRoots?.[repo] ?? join(layout.workspaceRoot, repo);
}

export function sanitizeBranch(branch: string): string {
  return branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

export function worktreePath(layout: SandcastleLayout, repo: TargetRepo, branch: string): string {
  return join(layout.worktreesDir, repo, sanitizeBranch(branch));
}

export function toDockerPath(path: string): string {
  return path.replace(/\\/g, "/");
}
