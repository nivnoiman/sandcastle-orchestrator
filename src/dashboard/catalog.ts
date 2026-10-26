import { readFileSync } from "node:fs";
import type { ProjectSource } from "../ui/board/entry.js";
import { isRunning, type InstanceRegistry, type RegistryEntry } from "../registry/index.js";
import { processIsAlive } from "../real/lock.js";

export interface Catalog {
  /** Known Projects as the Board View wants them; `apiBase` points back through this Dashboard's proxy. */
  sources(): ProjectSource[];
}

export function proxyBase(id: string): string {
  return `/p/${id}`;
}

/**
 * Entries whose recorded pid is dead and were never deregistered: the server was killed, not stopped.
 * The registry cleans them to "stopped" on read, so this peeks at the raw file first.
 */
function diedIds(registry: InstanceRegistry, isAlive: (pid: number) => boolean): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(registry.file, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is RegistryEntry => typeof entry === "object" && entry !== null)
      .filter((entry) => isRunning(entry) && !isAlive(entry.pid))
      .map((entry) => entry.id);
  } catch {
    return [];
  }
}

export function createCatalog(registry: InstanceRegistry, isAlive: (pid: number) => boolean = processIsAlive): Catalog {
  const died = new Set<string>();
  return {
    sources() {
      for (const id of diedIds(registry, isAlive)) died.add(id);
      return registry.list().map((entry) => {
        const running = isRunning(entry);
        if (running) died.delete(entry.id);
        return {
          id: entry.id,
          name: entry.name,
          apiBase: proxyBase(entry.id),
          legacyHref: `${proxyBase(entry.id)}/legacy`,
          status: running ? "running" : died.has(entry.id) ? "died" : "stopped",
        };
      });
    },
  };
}
