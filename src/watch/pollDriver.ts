import type { RunSnapshot } from "../gh/snapshot.js";
import { loadRunModel, type RunModel } from "../model/runModel.js";

export interface SnapshotSink {
  applySnapshot(model: RunModel): void;
}

export interface WatchOptions {
  fetchSnapshot: () => Promise<RunSnapshot>;
  engine: SnapshotSink;
  intervalMs: number;
  stopWhen?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  onInvalidSnapshot?: (errors: string[]) => void;
  onError?: (error: Error) => void;
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function timerSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class WatchLoop {
  private readonly sleep: (ms: number) => Promise<void>;
  private stopped = false;
  private ticking = false;

  constructor(private readonly options: WatchOptions) {
    if (!Number.isInteger(options.intervalMs) || options.intervalMs < 1) {
      throw new Error(`intervalMs must be a positive integer, got ${options.intervalMs}`);
    }
    this.sleep = options.sleep ?? timerSleep;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.pollOnce();
    } finally {
      this.ticking = false;
    }
  }

  async run(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.tick();
      } catch (cause) {
        this.reportError(asError(cause));
      }
      if (this.stopped || this.shouldStop()) return;
      await this.sleep(this.options.intervalMs);
      if (this.shouldStop()) return;
    }
  }

  stop(): void {
    this.stopped = true;
  }

  private shouldStop(): boolean {
    const stopWhen = this.options.stopWhen;
    if (!stopWhen) return false;
    if (!stopWhen()) return false;
    this.stopped = true;
    return true;
  }

  private async pollOnce(): Promise<void> {
    const snapshot = await this.options.fetchSnapshot();
    const result = loadRunModel(snapshot);
    if (!result.ok) {
      this.reportInvalid(result.errors);
      return;
    }
    this.options.engine.applySnapshot(result.model);
  }

  private reportInvalid(errors: string[]): void {
    const handler = this.options.onInvalidSnapshot;
    if (!handler) throw new Error(`snapshot no longer satisfies the publish contract:\n  - ${errors.join("\n  - ")}`);
    handler(errors);
  }

  private reportError(error: Error): void {
    const handler = this.options.onError;
    if (!handler) throw error;
    handler(error);
  }
}
