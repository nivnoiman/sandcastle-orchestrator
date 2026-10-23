import { join } from "node:path";
import type { FileSystemPort } from "./fileSystem.js";
import type { SandcastleLayout } from "./paths.js";

export interface LockHolder {
  pid: number;
  startedAt: string;
}

export interface LockDeps {
  fs: FileSystemPort;
  layout: SandcastleLayout;
  pid: number;
  isAlive: (pid: number) => boolean;
  now: () => Date;
}

export function lockPath(layout: SandcastleLayout): string {
  return join(layout.sandcastleDir, ".orchestrator.lock");
}

function parseHolder(raw: string): LockHolder | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const { pid, startedAt } = parsed as Record<string, unknown>;
    if (typeof pid !== "number" || typeof startedAt !== "string") return undefined;
    return { pid, startedAt };
  } catch {
    return undefined;
  }
}

export function acquireLock(deps: LockDeps): string {
  const path = lockPath(deps.layout);
  const existing = deps.fs.readText(path);
  if (existing !== undefined) {
    const holder = parseHolder(existing);
    if (holder && holder.pid === deps.pid) {
      throw new Error(
        `this process still holds the sandcastle lock from a run that has not settled (taken ${holder.startedAt}) — ` +
          "feature verify keeps it until the run finishes; wait for it rather than starting a second run in the same process.",
      );
    }
    if (holder && deps.isAlive(holder.pid)) {
      throw new Error(
        `another sandcastle orchestrator is running (pid ${holder.pid}, since ${holder.startedAt}). ` +
          `Stop it, or delete ${path} if you are certain it is dead — two orchestrators garbage-collect each other's containers.`,
      );
    }
  }
  deps.fs.writeText(path, JSON.stringify({ pid: deps.pid, startedAt: deps.now().toISOString() }));
  return path;
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}
