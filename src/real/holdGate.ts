import type { HoldReason } from "../engine/adapters.js";
import type { RunHold } from "../engine/hold.js";
import { isAgentWait, type AgentWaitError } from "./agentFailure.js";

export type HoldingWait = AgentWaitError & { readonly reason: HoldReason };

export type AwaitHold = (wait: HoldingWait, stage: string) => Promise<void>;

export interface HoldGateDeps {
  hold: RunHold;
  poll: () => void;
  sleep: (ms: number) => Promise<void>;
  intervalMs: number;
  log: (message: string) => void;
}

export function isHoldingWait(cause: unknown): cause is HoldingWait {
  return isAgentWait(cause) && cause.reason !== "transient";
}

export function createHoldGate(deps: HoldGateDeps): AwaitHold {
  return async (wait, stage) => {
    deps.hold.raise(wait.reason, wait.resumeAt);
    deps.log(`[${stage}] held on ${wait.reason}: ${wait.message} — the attempt re-runs once the Hold lifts`);
    while (deps.hold.reason !== undefined) {
      await deps.sleep(deps.intervalMs);
      deps.poll();
    }
    deps.log(`[${stage}] Hold lifted — re-running the attempt`);
  };
}
