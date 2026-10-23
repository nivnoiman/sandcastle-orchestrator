import { join } from "node:path";
import { REWORK_LIMIT_DEFAULT } from "../../src/engine/rework.js";
import type { RunModel, WorkItem } from "../../src/model/runModel.js";
import { DEFAULT_MONGO_IMAGE } from "../../src/project/projectConfig.js";
import { DEFAULT_JEST_WORKERS, type OrchestratorConfig } from "../../src/real/env.js";
import { TEST_PROJECT } from "../setup.js";

const testRepos = Object.entries(TEST_PROJECT.repos);
export const TEST_BOOTSTRAP = Object.fromEntries(testRepos.map(([name, repo]) => [name, repo.bootstrap]));
export const TEST_CHECKS = Object.fromEntries(testRepos.map(([name, repo]) => [name, repo.checks]));
export const TEST_VERIFY_SERVICES = TEST_PROJECT.verify.strategy === "compose" ? TEST_PROJECT.verify.services : {};
import { MemoryFileSystem } from "../../src/real/fileSystem.js";
import { layoutFrom, type SandcastleLayout } from "../../src/real/paths.js";

export const HOME = join("C:", "Users", "tester");
export const SANDCASTLE_DIR = join("W:", "work", "acme", "sandcastle");

export function testLayout(): SandcastleLayout {
  return layoutFrom(SANDCASTLE_DIR, HOME);
}

export function testConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  return {
    ghToken: "gh-token",
    anthropicApiKey: undefined,
    model: "opus",
    reviewModel: "sonnet",
    imageTag: "sandcastle:demo",
    mongoImage: DEFAULT_MONGO_IMAGE,
    hubRepo: "example-org/hub",
    idleTimeoutSeconds: 600,
    claudeSyncSource: undefined,
    bootstrapCommands: { ...TEST_BOOTSTRAP },
    checkCommands: { ...TEST_CHECKS },
    jestWorkers: DEFAULT_JEST_WORKERS,
    reworkLimit: REWORK_LIMIT_DEFAULT,
    featureReworkLimit: REWORK_LIMIT_DEFAULT,
    verify: TEST_PROJECT.verify,
    verifyServices: { ...TEST_VERIFY_SERVICES },
    ...overrides,
  };
}

export function testWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    number: 17,
    title: "feat: toy slice",
    repo: "api",
    dependsOn: [],
    admission: "queued",
    extraMemories: [],
    body: "## What to build\nA toy slice.\n\n## Acceptance criteria\n- [ ] it works",
    ...overrides,
  };
}

export function testRunModel(items: WorkItem[] = [testWorkItem()]): RunModel {
  return {
    parentNumber: 16,
    title: "demo: toy feature",
    parentBody: "## What to build\nA toy feature, end to end.\n\n## Acceptance criteria\n- [ ] the toy works",
    feature: "toy-demo",
    integrationBranch: "integration/toy-demo",
    requiredReading: { api: ["CLAUDE.md", "docs/agents/sandcastle.md"] },
    loadBearingMemories: ["feedback_no_code_comments"],
    items,
  };
}

export function fsWith(files: Record<string, string>, directories: string[] = []): MemoryFileSystem {
  const fs = new MemoryFileSystem(files);
  for (const directory of directories) fs.makeDirectory(directory);
  return fs;
}

export function repoDir(repo: string): string {
  return join("W:", "work", "acme", repo);
}

export function worktreeDir(repo: string, sanitizedBranch: string): string {
  return join(SANDCASTLE_DIR, "worktrees", repo, sanitizedBranch);
}
