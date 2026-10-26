import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { OperatorError } from "../engine/operatorError.js";
import type { InstanceRegistry, RegistryEntry } from "../registry/index.js";
import { isRunning } from "../registry/index.js";

export const SANDCASTLE_BIN = join(import.meta.dirname, "..", "..", "bin", "sandcastle.mjs");

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface LauncherOptions {
  registry: InstanceRegistry;
  spawnProcess?: SpawnFn;
  /** How long to wait for the new Project Server to register. */
  startTimeoutMs?: number;
  pollMs?: number;
}

/** Env a spawned Project Server must not inherit: its cwd picks the project and it picks its own free port. */
const DROPPED_ENV = ["SANDCASTLE_CONFIG", "SANDCASTLE_UI_PORT"];

export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  for (const name of DROPPED_ENV) delete copy[name];
  return copy;
}

/** Output file for a detached child, beside the registry. */
export function logFileFor(registry: InstanceRegistry, name: string): number {
  const dir = dirname(registry.file);
  mkdirSync(dir, { recursive: true });
  return openSync(join(dir, name), "a");
}

/**
 * Starts a stopped Known Project by id. The command is fixed (`sandcastle ui`, no arguments, so an Idle
 * Project Server in real mode) and the only variable is the directory the registry already holds.
 */
export function createProjectLauncher(options: LauncherOptions): (id: string) => Promise<RegistryEntry> {
  const { registry } = options;
  const spawnProcess = options.spawnProcess ?? spawn;
  const timeoutMs = options.startTimeoutMs ?? 20_000;
  const pollMs = options.pollMs ?? 250;
  const pending = new Set<string>();

  return async (id) => {
    const entry = registry.get(id);
    if (!entry) throw new OperatorError(`unknown project ${id}`);
    if (isRunning(entry)) throw new OperatorError(`${entry.name} already has a Project Server (port ${entry.port})`);
    if (pending.has(id)) throw new OperatorError(`${entry.name} is already starting`);
    if (!existsSync(entry.dir)) throw new OperatorError(`${entry.dir} no longer exists`);

    pending.add(id);
    const log = logFileFor(registry, `ui-${id}.log`);
    try {
      const child = spawnProcess(process.execPath, [SANDCASTLE_BIN, "ui"], {
        cwd: entry.dir,
        env: childEnv(process.env),
        detached: true,
        stdio: ["ignore", log, log],
        windowsHide: true,
      });
      let exitCode: number | null | undefined;
      child.once("exit", (code) => {
        exitCode = code;
      });
      child.once("error", () => {
        exitCode = -1;
      });
      child.unref();

      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const current = registry.get(id);
        if (current && isRunning(current)) return current;
        if (exitCode !== undefined) {
          throw new OperatorError(`sandcastle ui in ${entry.dir} exited (code ${exitCode}) — see ${join(dirname(registry.file), `ui-${id}.log`)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
      throw new OperatorError(`${entry.name} did not register within ${Math.round(timeoutMs / 1000)}s — see ${join(dirname(registry.file), `ui-${id}.log`)}`);
    } finally {
      closeSync(log);
      pending.delete(id);
    }
  };
}
