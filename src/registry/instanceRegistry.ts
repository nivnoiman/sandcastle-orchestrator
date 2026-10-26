import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { OperatorError } from "../engine/operatorError.js";
import { processIsAlive } from "../real/lock.js";

export type InstanceMode = "dry" | "real";

/** A Known Project; `pid`/`port`/`mode`/`startedAt` are set only while its Project Server runs. */
export interface RegistryEntry {
  id: string;
  dir: string;
  name: string;
  pid: number | null;
  port: number | null;
  mode: InstanceMode | null;
  startedAt: string | null;
}

export interface RunningEntry extends RegistryEntry {
  pid: number;
  port: number;
  mode: InstanceMode;
  startedAt: string;
}

export interface Registration {
  dir: string;
  name?: string;
  pid: number;
  port: number;
  mode: InstanceMode;
}

export interface InstanceRegistryOptions {
  /** Folder holding `instances.json`; default `SANDCASTLE_REGISTRY_DIR`, then `~/.sandcastle`. */
  registryDir?: string;
  isAlive?: (pid: number) => boolean;
  now?: () => Date;
}

export interface InstanceRegistry {
  readonly file: string;
  /** Known Projects (running or stopped); stale pids are cleaned first. */
  list(): RegistryEntry[];
  running(): RunningEntry[];
  get(id: string): RegistryEntry | undefined;
  /** Throws if another live Project Server already holds this Project. */
  register(registration: Registration): RegistryEntry;
  /** Marks the Project stopped but keeps it as a Known Project; only the owning pid may deregister. */
  deregister(dir: string, pid: number): void;
}

const REGISTRY_FILE = "instances.json";

export function defaultRegistryDir(env: NodeJS.ProcessEnv = process.env): string {
  return env["SANDCASTLE_REGISTRY_DIR"] || join(homedir(), ".sandcastle");
}

function normalizeDir(dir: string): string {
  const absolute = resolve(dir);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

/** Stable id for a Project, derived from its directory. */
export function projectId(dir: string): string {
  return createHash("sha1").update(normalizeDir(dir)).digest("hex").slice(0, 12);
}

export function isRunning(entry: RegistryEntry): entry is RunningEntry {
  return entry.pid !== null && entry.port !== null && entry.mode !== null && entry.startedAt !== null;
}

function isEntry(value: unknown): value is RegistryEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  const nullableNumber = (field: unknown): boolean => field === null || typeof field === "number";
  return (
    typeof entry["id"] === "string" &&
    typeof entry["dir"] === "string" &&
    typeof entry["name"] === "string" &&
    nullableNumber(entry["pid"]) &&
    nullableNumber(entry["port"]) &&
    (entry["mode"] === null || entry["mode"] === "dry" || entry["mode"] === "real") &&
    (entry["startedAt"] === null || typeof entry["startedAt"] === "string")
  );
}

function stopped(entry: RegistryEntry): RegistryEntry {
  return { ...entry, pid: null, port: null, mode: null, startedAt: null };
}

export function createInstanceRegistry(options: InstanceRegistryOptions = {}): InstanceRegistry {
  const dir = options.registryDir ?? defaultRegistryDir();
  const file = join(dir, REGISTRY_FILE);
  const isAlive = options.isAlive ?? processIsAlive;
  const now = options.now ?? (() => new Date());

  function read(): RegistryEntry[] {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw cause;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (!Array.isArray(parsed)) throw new Error("expected an array");
      return parsed.filter(isEntry);
    } catch (cause) {
      console.error(`[registry][warn] ${file} is unreadable, starting empty: ${(cause as Error).message}`);
      return [];
    }
  }

  function write(entries: RegistryEntry[]): void {
    mkdirSync(dir, { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(entries, null, 2)}\n`);
    renameSync(temp, file);
  }

  /** Marks entries whose pid died as stopped, persisting only if something changed. */
  function load(): RegistryEntry[] {
    let changed = false;
    const cleaned = read().map((entry) => {
      if (!isRunning(entry) || isAlive(entry.pid)) return entry;
      changed = true;
      return stopped(entry);
    });
    if (changed) write(cleaned);
    return cleaned;
  }

  return {
    file,
    list: load,
    running: () => load().filter(isRunning),
    get: (id) => load().find((entry) => entry.id === id),
    register(registration) {
      const id = projectId(registration.dir);
      const entries = load();
      const held = entries.find((entry) => entry.id === id);
      if (held && isRunning(held) && held.pid !== registration.pid) {
        throw new OperatorError(
          `${held.dir} already has a Project Server (pid ${held.pid}, port ${held.port}, ${held.mode}) — stop it first`,
        );
      }
      const absolute = resolve(registration.dir);
      const entry: RegistryEntry = {
        id,
        dir: absolute,
        name: registration.name ?? held?.name ?? (basename(absolute) || id),
        pid: registration.pid,
        port: registration.port,
        mode: registration.mode,
        startedAt: now().toISOString(),
      };
      write([...entries.filter((candidate) => candidate.id !== id), entry]);
      return entry;
    },
    deregister(projectDir, pid) {
      const id = projectId(projectDir);
      const entries = load();
      const held = entries.find((entry) => entry.id === id);
      if (!held || held.pid !== pid) return;
      write(entries.map((entry) => (entry.id === id ? stopped(entry) : entry)));
    },
  };
}
