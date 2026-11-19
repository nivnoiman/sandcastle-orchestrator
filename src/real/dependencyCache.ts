import { createHash } from "node:crypto";
import { join } from "node:path";
import type { TargetRepo } from "../model/runModel.js";
import type { CommandRunner } from "./commandRunner.js";
import { containerPrefix, execAsRoot, listVolumesByPrefix, nonEmptyLines, removeVolume, type VolumeMount } from "./docker.js";
import type { FileSystemPort } from "./fileSystem.js";
import { CONTAINER_HOME } from "./paths.js";
import { messageOf, shortMessageOf } from "../messageOf.js";

const DEPENDENCY_CACHE_KEEP = 2;
const DEPENDENCY_CACHE_ROOT = `${CONTAINER_HOME}/dependency-cache`;
const CACHED_DIRECTORY = "node_modules";
const CACHE_COMPLETE_MARKER = ".sandcastle-complete";
const CACHEABLE_INSTALL = "npm ci";
const NPM_LOCKFILES = ["npm-shrinkwrap.json", "package-lock.json"] as const;
const ROOT_INSTALL_SCRIPTS = ["preinstall", "install", "postinstall", "prepare"] as const;
const MANIFEST_DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "overrides"] as const;
const KEY_LENGTH = 12;

export interface DependencyCacheKeyInput {
  imageId: string;
  install: string;
  manifestDependencies: string;
  lockfile: string;
}

export interface DependencyCachePlan {
  repo: TargetRepo;
  key: string;
  volume: string;
  mountPath: string;
  remainder: string;
}

export type DependencyCacheDecision = { kind: "cache"; plan: DependencyCachePlan } | { kind: "skip"; reason: string };

export interface PlanInput {
  fs: FileSystemPort;
  repo: TargetRepo;
  worktree: string;
  bootstrap: string;
  imageId: string;
  setting: boolean | undefined;
}

export interface CachedVolume {
  name: string;
  createdAt: string;
}

type Manifest = Record<string, unknown>;

export function bootstrapAfterInstall(bootstrap: string): string | undefined {
  const [first, ...rest] = bootstrap.split("&&");
  if (first?.trim() !== CACHEABLE_INSTALL) return undefined;
  return rest.join("&&").trim();
}

export function dependencyCacheKey(input: DependencyCacheKeyInput): string {
  return createHash("sha256")
    .update(JSON.stringify([input.imageId, input.install, input.manifestDependencies, input.lockfile]))
    .digest("hex")
    .slice(0, KEY_LENGTH);
}

function dependencyCachePrefix(): string {
  return `${containerPrefix()}deps-`;
}

function dependencyCacheVolumeName(repo: TargetRepo, key: string): string {
  return `${dependencyCachePrefix()}${repo}-${key}`;
}

function dependencyCacheRepo(name: string): TargetRepo | undefined {
  const match = new RegExp(`^${dependencyCachePrefix()}([a-z0-9][a-z0-9-]*)-[0-9a-f]{${KEY_LENGTH}}$`).exec(name);
  return match?.[1];
}

function skip(reason: string): DependencyCacheDecision {
  return { kind: "skip", reason };
}

function readManifest(fs: FileSystemPort, worktree: string): Manifest | undefined {
  const text = fs.readText(join(worktree, "package.json"));
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Manifest) : undefined;
  } catch {
    return undefined;
  }
}

function rootInstallScripts(manifest: Manifest): string[] {
  const scripts = manifest["scripts"];
  if (typeof scripts !== "object" || scripts === null) return [];
  return ROOT_INSTALL_SCRIPTS.filter((name) => name in scripts);
}

function manifestDependencies(manifest: Manifest): string {
  return JSON.stringify(MANIFEST_DEPENDENCY_FIELDS.map((field) => manifest[field] ?? null));
}

function readLockfile(fs: FileSystemPort, worktree: string): string | undefined {
  for (const name of NPM_LOCKFILES) {
    const text = fs.readText(join(worktree, name));
    if (text !== undefined) return text;
  }
  return undefined;
}

export function planDependencyCache(input: PlanInput): DependencyCacheDecision {
  if (input.setting === false) return skip("cacheDependencies is false");
  const remainder = bootstrapAfterInstall(input.bootstrap);
  if (remainder === undefined) return skip(`bootstrap does not start with exactly "${CACHEABLE_INSTALL}"`);
  if (input.imageId.length === 0) return skip("the image id is unknown");
  const manifest = readManifest(input.fs, input.worktree);
  if (!manifest) return skip("no readable package.json");
  if (manifest["workspaces"] !== undefined) return skip("npm workspaces keep node_modules per package");
  const scripts = rootInstallScripts(manifest);
  if (scripts.length > 0 && input.setting !== true) {
    return skip(`package.json runs ${scripts.join(", ")} on install; set cacheDependencies: true if they only touch node_modules`);
  }
  const lockfile = readLockfile(input.fs, input.worktree);
  if (lockfile === undefined) return skip(`no ${NPM_LOCKFILES.join(" or ")}`);
  const key = dependencyCacheKey({
    imageId: input.imageId,
    install: CACHEABLE_INSTALL,
    manifestDependencies: manifestDependencies(manifest),
    lockfile,
  });
  return {
    kind: "cache",
    plan: {
      repo: input.repo,
      key,
      volume: dependencyCacheVolumeName(input.repo, key),
      mountPath: `${DEPENDENCY_CACHE_ROOT}/${input.repo}`,
      remainder,
    },
  };
}

function restoreCommand(plan: DependencyCachePlan, sourcePath: string): string {
  return `rm -rf ${sourcePath}/${CACHED_DIRECTORY} && cp -a ${plan.mountPath}/${CACHED_DIRECTORY} ${sourcePath}/${CACHED_DIRECTORY}`;
}

function saveCommand(plan: DependencyCachePlan, sourcePath: string): string {
  const cache = plan.mountPath;
  const staging = `${cache}/.staging-$(hostname)`;
  return [
    `if [ -f ${cache}/${CACHE_COMPLETE_MARKER} ]; then exit 0; fi`,
    `rm -rf ${staging}`,
    `cp -a ${sourcePath}/${CACHED_DIRECTORY} ${staging}`,
    `rm -rf ${cache}/${CACHED_DIRECTORY}`,
    `mv ${staging} ${cache}/${CACHED_DIRECTORY}`,
    `touch ${cache}/${CACHE_COMPLETE_MARKER}`,
  ].join(" && ");
}

function claimCacheMountsCommand(plans: readonly DependencyCachePlan[]): string {
  const paths = plans.map((plan) => plan.mountPath).join(" ");
  return `mkdir -p ${paths} && chown agent:agent ${paths}`;
}

function imageIdOf(runner: CommandRunner, image: string): string {
  return runner.run({ command: "docker", args: ["image", "inspect", "--format", "{{.Id}}", image] }).stdout.trim();
}

function cacheIsComplete(runner: CommandRunner, container: string, plan: DependencyCachePlan): boolean {
  try {
    runner.run({ command: "docker", args: ["exec", container, "test", "-f", `${plan.mountPath}/${CACHE_COMPLETE_MARKER}`] });
    return true;
  } catch {
    return false;
  }
}

function createdAtMillis(volume: CachedVolume): number {
  const parsed = Date.parse(volume.createdAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function staleDependencyCaches(volumes: readonly CachedVolume[], keep = DEPENDENCY_CACHE_KEEP): string[] {
  const byRepo = new Map<TargetRepo, CachedVolume[]>();
  for (const volume of volumes) {
    const repo = dependencyCacheRepo(volume.name);
    if (repo === undefined) continue;
    const entries = byRepo.get(repo) ?? [];
    entries.push(volume);
    byRepo.set(repo, entries);
  }
  return [...byRepo.values()].flatMap((entries) =>
    entries
      .sort((left, right) => createdAtMillis(right) - createdAtMillis(left))
      .slice(keep)
      .map((entry) => entry.name),
  );
}

function inspectCreatedAt(runner: CommandRunner, names: readonly string[]): CachedVolume[] {
  if (names.length === 0) return [];
  const { stdout } = runner.run({
    command: "docker",
    args: ["volume", "inspect", "--format", "{{.Name}} {{.CreatedAt}}", ...names],
  });
  return nonEmptyLines(stdout).map((line) => {
    const [name = "", ...rest] = line.split(" ");
    return { name, createdAt: rest.join(" ") };
  });
}

export interface PruneReport {
  removed: string[];
  failures: string[];
}

export function pruneDependencyCaches(runner: CommandRunner, log: (message: string) => void, keep = DEPENDENCY_CACHE_KEEP): PruneReport {
  const report: PruneReport = { removed: [], failures: [] };
  let stale: string[];
  try {
    const names = listVolumesByPrefix(runner, dependencyCachePrefix()).filter((name) => dependencyCacheRepo(name) !== undefined);
    stale = staleDependencyCaches(inspectCreatedAt(runner, names), keep);
  } catch (cause) {
    report.failures.push(`listing dependency caches failed: ${shortMessageOf(cause)}`);
    return report;
  }
  for (const name of stale) {
    log(`[gc] removing dependency cache ${name}`);
    try {
      removeVolume(runner, name);
      report.removed.push(name);
    } catch (cause) {
      report.failures.push(`docker volume rm ${name} failed: ${shortMessageOf(cause)}`);
    }
  }
  return report;
}

export interface DependencyCachesDeps {
  runner: CommandRunner;
  fs: FileSystemPort;
  image: string;
  settings: Readonly<Record<TargetRepo, boolean | undefined>> | undefined;
  log: (message: string) => void;
}

export type ExecStep = (command: string, step: string) => Promise<unknown>;

export class DependencyCaches {
  private readonly plans = new Map<TargetRepo, DependencyCachePlan>();
  private imageId: string | undefined;

  constructor(private readonly deps: DependencyCachesDeps) {}

  plan(repo: TargetRepo, worktree: string, bootstrap: string): void {
    const decision = planDependencyCache({
      fs: this.deps.fs,
      repo,
      worktree,
      bootstrap,
      imageId: this.resolveImageId(),
      setting: this.deps.settings?.[repo],
    });
    if (decision.kind === "skip") {
      if (bootstrap.length > 0) this.deps.log(`[feature-verify] ${repo} dependencies cache off: ${decision.reason}`);
      return;
    }
    this.plans.set(repo, decision.plan);
  }

  volumes(): VolumeMount[] {
    return [...this.plans.values()].map((plan) => ({ volume: plan.volume, containerPath: plan.mountPath }));
  }

  claimMounts(container: string): void {
    if (this.plans.size === 0) return;
    execAsRoot(this.deps.runner, container, claimCacheMountsCommand([...this.plans.values()]));
  }

  async bootstrap(container: string, repo: TargetRepo, sourcePath: string, bootstrap: string, exec: ExecStep): Promise<void> {
    const plan = this.plans.get(repo);
    if (!plan) {
      if (bootstrap.length > 0) await exec(`cd ${sourcePath} && ${bootstrap}`, `${repo} bootstrap`);
      return;
    }
    if (cacheIsComplete(this.deps.runner, container, plan) && (await this.restore(plan, sourcePath, exec))) {
      if (plan.remainder.length > 0) await exec(`cd ${sourcePath} && ${plan.remainder}`, `${repo} bootstrap (after cached install)`);
      return;
    }
    this.deps.log(`[feature-verify] ${repo} dependencies cache miss ${plan.key}`);
    await exec(`cd ${sourcePath} && ${bootstrap}`, `${repo} bootstrap`);
    await this.save(plan, sourcePath, exec);
  }

  private async restore(plan: DependencyCachePlan, sourcePath: string, exec: ExecStep): Promise<boolean> {
    this.deps.log(`[feature-verify] ${plan.repo} dependencies cache hit ${plan.key}`);
    try {
      await exec(restoreCommand(plan, sourcePath), `${plan.repo} restore dependencies`);
      return true;
    } catch (cause) {
      this.deps.log(`[feature-verify][warn] ${plan.repo} dependencies cache restore failed, installing instead: ${messageOf(cause)}`);
      return false;
    }
  }

  private async save(plan: DependencyCachePlan, sourcePath: string, exec: ExecStep): Promise<void> {
    try {
      await exec(saveCommand(plan, sourcePath), `${plan.repo} save dependencies cache`);
    } catch (cause) {
      this.deps.log(`[feature-verify][warn] ${plan.repo} dependencies cache was not saved: ${messageOf(cause)}`);
      return;
    }
    const pruned = pruneDependencyCaches(this.deps.runner, this.deps.log);
    for (const failure of pruned.failures) this.deps.log(`[feature-verify][warn] ${failure}`);
  }

  private resolveImageId(): string {
    if (this.imageId !== undefined) return this.imageId;
    try {
      this.imageId = imageIdOf(this.deps.runner, this.deps.image);
    } catch (cause) {
      this.deps.log(`[feature-verify][warn] could not read the id of image ${this.deps.image}: ${messageOf(cause)}`);
      this.imageId = "";
    }
    return this.imageId;
  }
}
