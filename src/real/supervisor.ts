export const RESTART_BACKOFF_MS = [10_000, 30_000, 60_000, 120_000, 300_000] as const;
export const RESTART_WINDOW_MS = 60 * 60_000;
export const MAX_RESTARTS_PER_WINDOW = 6;

export interface UiExit {
  code: number | null;
  signal: string | null;
}

export type SupervisorDecision =
  | { kind: "stop"; reason: string }
  | { kind: "restart"; delayMs: number; reason: string };

export function describeExit(exit: UiExit): string {
  if (exit.signal) return `killed by ${exit.signal}`;
  return `exited with code ${exit.code ?? "unknown"}`;
}

export function decideAfterExit(exit: UiExit, recentRestarts: readonly number[], now: number): SupervisorDecision {
  if (exit.code === 0 && !exit.signal) return { kind: "stop", reason: "the ui stopped cleanly" };
  const inWindow = recentRestarts.filter((at) => now - at < RESTART_WINDOW_MS);
  if (inWindow.length >= MAX_RESTARTS_PER_WINDOW) {
    return {
      kind: "stop",
      reason: `the ui ${describeExit(exit)} and already restarted ${inWindow.length} times within the last hour — giving up so a human looks at the log`,
    };
  }
  const delayMs = RESTART_BACKOFF_MS[Math.min(inWindow.length, RESTART_BACKOFF_MS.length - 1)]!;
  return { kind: "restart", delayMs, reason: `the ui ${describeExit(exit)}` };
}
