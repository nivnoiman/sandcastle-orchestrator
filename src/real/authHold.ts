import type { AuthProbeResult } from "./authProbe.js";
import { messageOf } from "../messageOf.js";

export const AUTH_PROBE_BACKOFF_MS = [60_000, 120_000, 300_000, 600_000] as const;

export interface AuthHoldDeps {
  held: () => boolean;
  probe: () => Promise<AuthProbeResult>;
  onRecovered: () => void;
  log: (message: string) => void;
  now?: () => number;
}

export interface AuthHoldProbe {
  poll(): void;
}

function backoffFor(failures: number): number {
  return AUTH_PROBE_BACKOFF_MS[Math.min(failures, AUTH_PROBE_BACKOFF_MS.length - 1)]!;
}

export function createAuthHoldProbe(deps: AuthHoldDeps): AuthHoldProbe {
  const now = deps.now ?? Date.now;
  let inFlight = false;
  let failures = 0;
  let nextProbeAt = 0;

  const settle = (result: AuthProbeResult): void => {
    if (result.ok) {
      failures = 0;
      nextProbeAt = 0;
      deps.onRecovered();
      return;
    }
    const wait = backoffFor(failures);
    failures += 1;
    nextProbeAt = now() + wait;
    deps.log(
      `[auth] agent credentials still rejected (${result.reason ?? "unknown"}) — probing again in ${wait / 60_000}m`,
    );
  };

  return {
    poll: (): void => {
      if (!deps.held() || inFlight || now() < nextProbeAt) return;
      inFlight = true;
      void deps
        .probe()
        .then(settle)
        .catch((cause: unknown) => {
          settle({ ok: false, reason: "other", detail: messageOf(cause) });
        })
        .finally(() => {
          inFlight = false;
        });
    },
  };
}
