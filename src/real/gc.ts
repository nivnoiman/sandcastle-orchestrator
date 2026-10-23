import type { TargetRepo } from "../model/runModel.js";
import { knownRepos } from "../project/projectConfig.js";
import type { CommandRunner } from "./commandRunner.js";
import {
  containerPrefix,
  isOrchestratorContainer,
  isOrchestratorNetwork,
  isOrchestratorVolume,
  listContainersByName,
  listNetworksByPrefix,
  listVolumesByPrefix,
  networkPrefix,
  removeContainer,
  removeNetwork,
  removeVolume,
  volumePrefix,
} from "./docker.js";
import type { FileSystemPort } from "./fileSystem.js";
import { removeWorktreeTree } from "./gitOps.js";
import { repoRoot, toDockerPath, type SandcastleLayout } from "./paths.js";
import { messageOf } from "../messageOf.js";

export interface GcDeps {
  runner: CommandRunner;
  fs: FileSystemPort;
  layout: SandcastleLayout;
  log: (message: string) => void;
  repos?: readonly TargetRepo[];
  platform?: NodeJS.Platform;
}

export interface GcReport {
  containers: string[];
  networks: string[];
  volumes: string[];
  worktrees: string[];
  failures: string[];
}

export interface OrphanInventory {
  containers: string[];
  networks: string[];
  volumes: string[];
  worktrees: string[];
  failures: string[];
}

interface FailureSink {
  failures: string[];
}

function comparablePath(path: string): string {
  return toDockerPath(path).toLowerCase();
}

function shortMessageOf(cause: unknown): string {
  return messageOf(cause).slice(0, 200);
}

function orphanContainers(deps: GcDeps, sink: FailureSink): string[] {
  try {
    return listContainersByName(deps.runner, containerPrefix()).filter(isOrchestratorContainer);
  } catch (cause) {
    sink.failures.push(`docker ps by name failed: ${shortMessageOf(cause)}`);
    return [];
  }
}

function orphanNetworks(deps: GcDeps, sink: FailureSink): string[] {
  try {
    return listNetworksByPrefix(deps.runner, networkPrefix()).filter(isOrchestratorNetwork);
  } catch (cause) {
    sink.failures.push(`docker network ls failed: ${shortMessageOf(cause)}`);
    return [];
  }
}

function orphanVolumes(deps: GcDeps, sink: FailureSink): string[] {
  try {
    return listVolumesByPrefix(deps.runner, volumePrefix()).filter(isOrchestratorVolume);
  } catch (cause) {
    sink.failures.push(`docker volume ls failed: ${shortMessageOf(cause)}`);
    return [];
  }
}

function pruneWorktreeMetadata(deps: GcDeps, repo: TargetRepo, sink: FailureSink): void {
  const cwd = repoRoot(deps.layout, repo);
  if (!deps.fs.exists(cwd)) return;
  try {
    deps.runner.run({ command: "git", args: ["worktree", "prune"], cwd });
  } catch (cause) {
    sink.failures.push(`[${repo}] git worktree prune failed: ${shortMessageOf(cause)}`);
  }
}

function managedWorktrees(deps: GcDeps, repo: TargetRepo, sink: FailureSink): string[] {
  const cwd = repoRoot(deps.layout, repo);
  if (!deps.fs.exists(cwd)) return [];
  try {
    const { stdout } = deps.runner.run({ command: "git", args: ["worktree", "list", "--porcelain"], cwd });
    const managed = `${comparablePath(deps.layout.worktreesDir).replace(/\/+$/, "")}/`;
    return stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length).trim())
      .filter((path) => comparablePath(path).startsWith(managed));
  } catch (cause) {
    sink.failures.push(`[${repo}] git worktree list failed: ${shortMessageOf(cause)}`);
    return [];
  }
}

function removeManagedWorktrees(deps: GcDeps, repo: TargetRepo, report: GcReport): void {
  const cwd = repoRoot(deps.layout, repo);
  for (const path of managedWorktrees(deps, repo, report)) {
    deps.log(`[gc] removing worktree ${path}`);
    try {
      removeWorktreeTree(deps, cwd, path);
      report.worktrees.push(path);
    } catch (cause) {
      report.failures.push(`[${repo}] git worktree remove ${path} failed: ${shortMessageOf(cause)}`);
    }
  }
}

export function findOrphans(deps: GcDeps): OrphanInventory {
  const inventory: OrphanInventory = { containers: [], networks: [], volumes: [], worktrees: [], failures: [] };
  inventory.containers = orphanContainers(deps, inventory);
  inventory.networks = orphanNetworks(deps, inventory);
  inventory.volumes = orphanVolumes(deps, inventory);
  for (const repo of deps.repos ?? knownRepos()) {
    inventory.worktrees.push(...managedWorktrees(deps, repo, inventory));
  }
  return inventory;
}

export function collectOrphans(deps: GcDeps): GcReport {
  const report: GcReport = { containers: [], networks: [], volumes: [], worktrees: [], failures: [] };

  for (const name of orphanContainers(deps, report)) {
    deps.log(`[gc] removing container ${name}`);
    try {
      removeContainer(deps.runner, name);
      report.containers.push(name);
    } catch (cause) {
      report.failures.push(`docker rm -f ${name} failed: ${shortMessageOf(cause)}`);
    }
  }

  for (const name of orphanNetworks(deps, report)) {
    deps.log(`[gc] removing network ${name}`);
    try {
      removeNetwork(deps.runner, name);
      report.networks.push(name);
    } catch (cause) {
      report.failures.push(`docker network rm ${name} failed: ${shortMessageOf(cause)}`);
    }
  }

  for (const name of orphanVolumes(deps, report)) {
    deps.log(`[gc] removing volume ${name}`);
    try {
      removeVolume(deps.runner, name);
      report.volumes.push(name);
    } catch (cause) {
      report.failures.push(`docker volume rm ${name} failed: ${shortMessageOf(cause)}`);
    }
  }

  for (const repo of deps.repos ?? knownRepos()) {
    pruneWorktreeMetadata(deps, repo, report);
    removeManagedWorktrees(deps, repo, report);
  }

  return report;
}
