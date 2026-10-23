import { OperatorError } from "../engine/operatorError.js";

export type QueueMode = "sequential" | "parallel";

export const QUEUE_MODES: readonly QueueMode[] = ["sequential", "parallel"];

export const DEFAULT_MAX_PARALLEL = 2;

export interface QueueSettings {
  mode: QueueMode;
  maxParallel: number;
  globalCap: number;
  parentCap: number;
}

export interface QueueFile extends QueueSettings {
  version: 1;
  parents: number[];
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function isQueueMode(value: unknown): value is QueueMode {
  return QUEUE_MODES.includes(value as QueueMode);
}

export function isQueueFile(value: unknown): value is QueueFile {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Record<keyof QueueFile, unknown>>;
  const { parents } = candidate;
  return (
    candidate.version === 1 &&
    isQueueMode(candidate.mode) &&
    isPositiveInteger(candidate.maxParallel) &&
    isPositiveInteger(candidate.globalCap) &&
    isPositiveInteger(candidate.parentCap) &&
    Array.isArray(parents) &&
    parents.every(isPositiveInteger) &&
    new Set(parents).size === parents.length
  );
}

function requirePositiveInteger(label: string, value: number): void {
  if (isPositiveInteger(value)) return;
  throw new OperatorError(`${label} must be a positive integer, got ${value}`);
}

export class RunQueue {
  private queued: number[];
  private current: QueueSettings;

  constructor(
    initial: QueueFile | undefined,
    defaults: { globalCap: number; parentCap: number },
    private readonly persist: (file: QueueFile) => void,
  ) {
    if (initial === undefined) {
      this.queued = [];
      this.current = { mode: "sequential", maxParallel: DEFAULT_MAX_PARALLEL, ...defaults };
      return;
    }
    const { version: _version, parents, ...settings } = initial;
    this.queued = [...parents];
    this.current = settings;
  }

  parents(): readonly number[] {
    return [...this.queued];
  }

  settings(): QueueSettings {
    return { ...this.current };
  }

  add(parents: readonly number[]): number[] {
    for (const parent of parents) requirePositiveInteger("parent", parent);
    const added = [...new Set(parents)].filter((parent) => !this.queued.includes(parent));
    if (added.length === 0) return [];
    this.commit([...this.queued, ...added], this.current);
    return added;
  }

  remove(parent: number): void {
    if (!this.queued.includes(parent)) throw new OperatorError(`#${parent} is not queued`);
    this.commit(this.queued.filter((queued) => queued !== parent), this.current);
  }

  reorder(parents: readonly number[]): void {
    const isPermutation =
      parents.length === this.queued.length &&
      new Set(parents).size === parents.length &&
      parents.every((parent) => this.queued.includes(parent));
    if (!isPermutation) throw new OperatorError(`reorder must list exactly the queued parents: ${this.queued.join(", ")}`);
    this.commit([...parents], this.current);
  }

  clear(): void {
    this.commit([], this.current);
  }

  setMode(mode: QueueMode, maxParallel: number = this.current.maxParallel): void {
    if (!isQueueMode(mode)) throw new OperatorError(`mode must be one of ${QUEUE_MODES.join(", ")}, got ${String(mode)}`);
    requirePositiveInteger("maxParallel", maxParallel);
    this.updateSettings({ mode, maxParallel });
  }

  setGlobalCap(globalCap: number): void {
    requirePositiveInteger("globalCap", globalCap);
    this.updateSettings({ globalCap });
  }

  setParentCap(parentCap: number): void {
    requirePositiveInteger("parentCap", parentCap);
    this.updateSettings({ parentCap });
  }

  next(itemsInFlightRuns: number): number | undefined {
    const limit = this.current.mode === "sequential" ? 1 : this.current.maxParallel;
    if (itemsInFlightRuns >= limit) return undefined;
    return this.queued[0];
  }

  take(parent: number): void {
    this.remove(parent);
  }

  requeueFront(parent: number, behind: readonly number[] = []): void {
    requirePositiveInteger("parent", parent);
    const rest = this.queued.filter((queued) => queued !== parent);
    const position = Math.max(-1, ...behind.map((ahead) => rest.indexOf(ahead))) + 1;
    this.commit([...rest.slice(0, position), parent, ...rest.slice(position)], this.current);
  }

  private updateSettings(patch: Partial<QueueSettings>): void {
    this.commit(this.queued, { ...this.current, ...patch });
  }

  private commit(queued: number[], settings: QueueSettings): void {
    this.persist({ version: 1, ...settings, parents: [...queued] });
    this.queued = queued;
    this.current = settings;
  }
}
