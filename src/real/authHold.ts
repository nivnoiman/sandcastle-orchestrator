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
  recheck(): Promise<AuthProbeResult>;
}

function backoffFor(failures: number): number {
  return AUTH_PROBE_BACKOFF_MS[Math.min(failures, AUTH_PROBE_BACKOFF_MS.length - 1)]!;
}

export function createAuthHoldProbe(deps: AuthHoldDeps): AuthHoldProbe {
  const now = deps.now ?? Date.now;
  let inFlight: Promise<AuthProbeResult> | undefined;
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

  const probeOrJoinInFlight = (): Promise<AuthProbeResult> => {
    inFlight ??= deps
      .probe()
      .catch((cause: unknown): AuthProbeResult => ({ ok: false, reason: "other", detail: messageOf(cause) }))
      .then((result) => {
        settle(result);
        return result;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };

  return {
    poll: (): void => {
      if (!deps.held() || inFlight || now() < nextProbeAt) return;
      probeOrJoinInFlight().catch((cause: unknown) => deps.log(`[auth][warn] resuming after the credentials recovered failed: ${messageOf(cause)}`));
    },
    recheck: probeOrJoinInFlight,
  };
}

export interface AuthRecheck {
  ok: boolean;
  error: string | undefined;
}

const MAX_ERROR_CHARS = 500;
const REDACTED = "[redacted]";
const SECRET_PATTERNS: readonly RegExp[] = [
  /\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|API_KEY|PASSWORD)\s*=\s*\S+/g,
  /\bBearer\s+[\w.~+/=-]+/gi,
  /(["']?(?:access|refresh|id)[_-]?token["']?\s*[:=]\s*)["']?[^\s"',}]+["']?/gi,
  /\bsk-[\w-]{8,}/g,
  /[A-Za-z0-9_+/=-]{32,}/g,
];

export function scrubProbeError(detail: string | undefined, reason: string | undefined): string {
  const raw = (detail ?? "").trim();
  if (raw.length === 0) return `agent credentials still rejected (${reason ?? "unknown"})`;
  let text = raw;
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, (_match, prefix: unknown) => `${typeof prefix === "string" ? prefix : ""}${REDACTED}`);
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text;
}

export function toAuthRecheck(result: AuthProbeResult): AuthRecheck {
  return result.ok ? { ok: true, error: undefined } : { ok: false, error: scrubProbeError(result.detail, result.reason) };
}
