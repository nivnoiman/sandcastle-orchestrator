import { OperatorError } from "../engine/operatorError.js";
import type { WorkerSlots } from "../engine/slots.js";

export interface Refillable {
  refill(): void;
}

export interface BrokerSlots extends WorkerSlots {
  detach(): void;
}

export interface SlotBrokerOptions {
  schedule?: (work: () => void) => void;
  onRefillError?: (engine: Refillable, cause: unknown) => void;
}

interface Lease {
  engine: Refillable;
  outstanding: number;
  attached: boolean;
}

export function validGlobalCap(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new OperatorError(`global worker cap must be a positive integer, got ${value}`);
  }
  return value;
}

export class SlotBroker {
  private globalCap: number;
  private usedCount = 0;
  private readonly leases: Lease[] = [];
  private readonly schedule: (work: () => void) => void;
  private readonly onRefillError: ((engine: Refillable, cause: unknown) => void) | undefined;
  private lastGranted: Lease | undefined;
  private roundScheduled = false;
  private serving: Lease | undefined;
  private servingGranted = false;

  constructor(globalCap: number, options: SlotBrokerOptions = {}) {
    this.globalCap = validGlobalCap(globalCap);
    this.schedule = options.schedule ?? ((work) => queueMicrotask(work));
    this.onRefillError = options.onRefillError;
  }

  slotsFor(engine: Refillable): BrokerSlots {
    const lease: Lease = { engine, outstanding: 0, attached: true };
    this.leases.push(lease);
    return {
      tryAcquire: () => this.acquire(lease),
      release: () => this.release(lease),
      detach: () => this.detach(lease),
    };
  }

  setCap(value: number): void {
    const previous = this.globalCap;
    this.globalCap = validGlobalCap(value);
    if (this.globalCap > previous) this.scheduleRound();
  }

  cap(): number {
    return this.globalCap;
  }

  used(): number {
    return this.usedCount;
  }

  private acquire(lease: Lease): boolean {
    if (!lease.attached) return false;
    if (this.usedCount >= this.globalCap) return false;
    if (!this.mayGrant(lease)) return false;
    this.usedCount += 1;
    lease.outstanding += 1;
    this.lastGranted = lease;
    if (this.serving) this.servingGranted = true;
    return true;
  }

  private mayGrant(lease: Lease): boolean {
    if (this.serving) return this.serving === lease && !this.servingGranted;
    return !this.roundScheduled;
  }

  private release(lease: Lease): void {
    if (!lease.attached) return;
    if (lease.outstanding === 0) throw new Error("slot released with nothing outstanding");
    lease.outstanding -= 1;
    this.usedCount -= 1;
    this.scheduleRound();
  }

  private detach(lease: Lease): void {
    if (!lease.attached) return;
    lease.attached = false;
    const index = this.leases.indexOf(lease);
    this.leases.splice(index, 1);
    if (this.lastGranted === lease) this.lastGranted = this.leases[index - 1];
    if (lease.outstanding === 0) return;
    this.usedCount -= lease.outstanding;
    lease.outstanding = 0;
    this.scheduleRound();
  }

  private scheduleRound(): void {
    if (this.roundScheduled) return;
    this.roundScheduled = true;
    this.schedule(() => this.runRound());
  }

  private runRound(): void {
    this.roundScheduled = false;
    const failures = new Map<Lease, unknown>();
    let granted = true;
    while (granted && this.usedCount < this.globalCap) {
      granted = false;
      for (const lease of this.rotation()) {
        if (this.usedCount >= this.globalCap) break;
        if (!lease.attached || failures.has(lease)) continue;
        if (this.serveOnce(lease, failures)) granted = true;
      }
    }
    const report = this.onRefillError;
    if (report) {
      for (const [lease, cause] of failures) report(lease.engine, cause);
      return;
    }
    const errors = [...failures.values()];
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, `${errors.length} engines failed to refill`);
  }

  private rotation(): Lease[] {
    const start = this.lastGranted ? this.leases.indexOf(this.lastGranted) + 1 : 0;
    return [...this.leases.slice(start), ...this.leases.slice(0, start)];
  }

  private serveOnce(lease: Lease, failures: Map<Lease, unknown>): boolean {
    this.serving = lease;
    this.servingGranted = false;
    try {
      lease.engine.refill();
      return this.servingGranted;
    } catch (cause) {
      failures.set(lease, cause);
      return false;
    } finally {
      this.serving = undefined;
    }
  }
}
