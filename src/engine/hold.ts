import type { HoldReason } from "./adapters.js";

function latest(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.max(left, right);
}

export interface HoldState {
  reason: HoldReason;
  until: number | undefined;
}

export class RunHold {
  private heldReason: HoldReason | undefined;
  private heldUntil: number | undefined;

  get reason(): HoldReason | undefined {
    return this.heldReason;
  }

  state(): HoldState | undefined {
    if (!this.heldReason) return undefined;
    return { reason: this.heldReason, until: this.heldUntil };
  }

  raise(reason: HoldReason, resumeAt: number | undefined): boolean {
    if (this.heldReason === "auth") return false;
    const previousUntil = this.heldReason === "rate-limit" ? this.heldUntil : undefined;
    this.heldReason = reason;
    this.heldUntil = reason === "rate-limit" ? latest(previousUntil, resumeAt) : undefined;
    return true;
  }

  releaseReopenedWindow(nowMs: number, fallbackMs: number): boolean {
    if (this.heldReason !== "rate-limit") return false;
    this.heldUntil ??= nowMs + fallbackMs;
    if (nowMs < this.heldUntil) return false;
    this.release();
    return true;
  }

  release(): HoldReason | undefined {
    const released = this.heldReason;
    this.heldReason = undefined;
    this.heldUntil = undefined;
    return released;
  }
}
