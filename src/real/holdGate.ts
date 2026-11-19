import type { HoldReason } from "../engine/adapters.js";
import type { RunHold } from "../engine/hold.js";
import { messageOf } from "../messageOf.js";
import { isAgentWait, type AgentWaitError } from "./agentFailure.js";

export type HoldingWait = AgentWaitError & { readonly reason: HoldReason };

export type AwaitHold = (wait: HoldingWait, stage: string) => Promise<void>;

export interface HoldGateDeps {
  hold: RunHold;
  poll: () => void;
  sleep: (ms: number) => Promise<void>;
  intervalMs: number;
  stopped: () => boolean;
  log: (message: string) => void;
}

export class HoldStoppedError extends Error {
  constructor(stage: string, reason: HoldReason) {
    super(`[${stage}] the run was stopped while held on ${reason} — the attempt did not re-run`);
  }
}

export function isHoldingWait(cause: unknown): cause is HoldingWait {
  return isAgentWait(cause) && cause.reason !== "transient";
}

function pollQuietly(deps: HoldGateDeps, stage: string): void {
  try {
    deps.poll();
  } catch (cause) {
    deps.log(`[${stage}][warn] polling the Hold failed: ${messageOf(cause)}`);
  }
}

export function createHoldGate(deps: HoldGateDeps): AwaitHold {
  return async (wait, stage) => {
    deps.hold.raise(wait.reason, wait.resumeAt);
    deps.log(`[${stage}] held on ${wait.reason}: ${wait.message} — the attempt re-runs once the Hold lifts`);
    while (deps.hold.reason !== undefined) {
      if (deps.stopped()) throw new HoldStoppedError(stage, wait.reason);
      await deps.sleep(deps.intervalMs);
      pollQuietly(deps, stage);
    }
    deps.log(`[${stage}] Hold lifted — re-running the attempt`);
  };
}
