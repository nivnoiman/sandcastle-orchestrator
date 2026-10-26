import type { ItemView } from "../engine/engine.js";

/** An Item is Quiet when its agent has been silent for more than this share of the idle timeout. */
export const QUIET_FRACTION = 0.5;

export interface QuietInfo {
  silentSeconds: number;
  timeoutSeconds: number;
}

export interface QuietInput {
  view: Pick<ItemView, "phase" | "phaseSince">;
  /** Epoch ms of the last agent output for the item, if any was seen. */
  lastOutputAt: number | undefined;
  nowMs: number;
  timeoutSeconds: number;
}

export function quietInfo(input: QuietInput): QuietInfo | undefined {
  if (input.view.phase !== "running") return undefined;
  const startedAt = Date.parse(input.view.phaseSince);
  const lastSignalAt = Math.max(startedAt, input.lastOutputAt ?? startedAt);
  const silentSeconds = Math.max(0, Math.floor((input.nowMs - lastSignalAt) / 1000));
  if (silentSeconds <= input.timeoutSeconds * QUIET_FRACTION) return undefined;
  return { silentSeconds, timeoutSeconds: input.timeoutSeconds };
}
