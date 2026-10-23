import type { Engine } from "../engine/engine.js";
import { RunHold } from "../engine/hold.js";
import { SlotBroker, validGlobalCap } from "../ui/slotBroker.js";
import { createAuthHoldProbe } from "./authHold.js";
import { probeAgentAuth, type AuthProbeResult } from "./authProbe.js";
import { NodeCommandRunner, type CommandRunner } from "./commandRunner.js";
import { loadOrchestratorConfig, resolveLayout, type OrchestratorConfig } from "./env.js";
import { nodeFileSystem, type FileSystemPort } from "./fileSystem.js";
import { collectOrphans, type GcReport } from "./gc.js";
import { acquireLock, processIsAlive } from "./lock.js";
import type { SandcastleLayout } from "./paths.js";
import { VerifyMutex } from "./verifyMutex.js";

export interface ControlPlaneOptions {
  hubRepo: string;
  idleTimeoutSeconds?: number | undefined;
  skipGc?: boolean | undefined;
  globalCap: number;
  log: (message: string) => void;
}

export interface ControlPlaneDeps {
  runner: CommandRunner;
  fs: FileSystemPort;
  layout: SandcastleLayout;
  loadConfig(): OrchestratorConfig;
  acquireLock(): string;
  releaseLock(path: string): void;
  collectOrphans(): GcReport;
  probeAuth(config: OrchestratorConfig): Promise<AuthProbeResult>;
  onProcessExit(hook: () => void): () => void;
}

export interface ControlPlane {
  runner: CommandRunner;
  fs: FileSystemPort;
  layout: SandcastleLayout;
  config: OrchestratorConfig;
  broker: SlotBroker;
  hold: RunHold;
  verifyMutex: VerifyMutex;
  pollAuth(): void;
}

export interface ParentLease {
  plane: ControlPlane;
  shared: boolean;
  attach(engine: Engine): void;
  release(): void;
}

export interface ControlPlaneHost {
  acquire(): ParentLease;
  active(): boolean;
  globalCap(): number;
  setGlobalCap(value: number): void;
}

interface LivePlane {
  plane: ControlPlane;
  engines: Set<Engine>;
  leases: number;
  teardown(): void;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function realControlPlaneDeps(options: ControlPlaneOptions): ControlPlaneDeps {
  const fs = nodeFileSystem;
  const layout = resolveLayout(fs);
  const runner = new NodeCommandRunner();
  const { log } = options;
  return {
    runner,
    fs,
    layout,
    loadConfig: () =>
      loadOrchestratorConfig(fs, layout, { hubRepo: options.hubRepo, idleTimeoutSeconds: options.idleTimeoutSeconds }),
    acquireLock: () => acquireLock({ fs, layout, pid: process.pid, isAlive: processIsAlive, now: () => new Date() }),
    releaseLock: (path) => {
      try {
        fs.removeFile(path);
      } catch (cause) {
        log(`[lock][warn] could not remove ${path}: ${messageOf(cause)}`);
      }
    },
    collectOrphans: () => collectOrphans({ runner, fs, layout, log }),
    probeAuth: (config) => probeAgentAuth({ runner, fs, layout, config, log }),
    onProcessExit: (hook) => {
      process.once("exit", hook);
      return () => process.off("exit", hook);
    },
  };
}

function runGc(deps: ControlPlaneDeps, log: (message: string) => void): void {
  log("[gc] cleaning orphan sandcastle containers, networks, volumes + worktrees…");
  const report = deps.collectOrphans();
  log(
    `[gc] removed ${report.containers.length} container(s), ${report.networks.length} network(s),` +
      ` ${report.volumes.length} volume(s), ${report.worktrees.length} worktree(s)`,
  );
  for (const failure of report.failures) log(`[gc][warn] ${failure}`);
}

function releaseEveryAuthHold(engines: ReadonlySet<Engine>, log: (message: string) => void): void {
  for (const engine of engines) {
    try {
      engine.releaseAuthHold();
    } catch (cause) {
      log(`[auth][warn] resuming a parent after the credentials recovered failed: ${messageOf(cause)}`);
    }
  }
}

function bootPlane(options: ControlPlaneOptions, deps: ControlPlaneDeps, globalCap: number): LivePlane {
  const { log } = options;
  const config = deps.loadConfig();
  const lockFile = deps.acquireLock();
  const releaseLock = (): void => deps.releaseLock(lockFile);
  const removeExitHook = deps.onProcessExit(releaseLock);
  const teardown = (): void => {
    removeExitHook();
    releaseLock();
  };
  try {
    if (!options.skipGc) runGc(deps, log);
    const engines = new Set<Engine>();
    const authProbe = createAuthHoldProbe({
      held: () => [...engines].some((engine) => engine.authHeld() || engine.waitingOnAuth()),
      probe: () => deps.probeAuth(config),
      onRecovered: () => releaseEveryAuthHold(engines, log),
      log,
    });
    const broker = new SlotBroker(globalCap, {
      onRefillError: (_engine, cause) => log(`[slots][warn] a parent failed to start its next stage: ${messageOf(cause)}`),
    });
    const plane: ControlPlane = {
      runner: deps.runner,
      fs: deps.fs,
      layout: deps.layout,
      config,
      broker,
      hold: new RunHold(),
      verifyMutex: new VerifyMutex(),
      pollAuth: () => authProbe.poll(),
    };
    return { plane, engines, leases: 0, teardown };
  } catch (cause) {
    teardown();
    throw cause;
  }
}

export function controlPlaneHost(
  options: ControlPlaneOptions,
  deps: ControlPlaneDeps = realControlPlaneDeps(options),
): ControlPlaneHost {
  let live: LivePlane | undefined;
  let currentGlobalCap = options.globalCap;

  const lease = (current: LivePlane): ParentLease => {
    const shared = current.leases > 0;
    current.leases += 1;
    const attached: Engine[] = [];
    let released = false;
    return {
      plane: current.plane,
      shared,
      attach: (engine) => {
        if (released) throw new Error("cannot attach an engine to a released control plane lease");
        attached.push(engine);
        current.engines.add(engine);
      },
      release: () => {
        if (released) return;
        released = true;
        for (const engine of attached) current.engines.delete(engine);
        current.leases -= 1;
        if (current.leases > 0) return;
        if (live === current) live = undefined;
        current.teardown();
      },
    };
  };

  return {
    acquire: () => {
      live ??= bootPlane(options, deps, currentGlobalCap);
      return lease(live);
    },
    active: () => live !== undefined,
    globalCap: () => currentGlobalCap,
    setGlobalCap: (value) => {
      const globalCap = validGlobalCap(value);
      live?.plane.broker.setCap(globalCap);
      currentGlobalCap = globalCap;
    },
  };
}
