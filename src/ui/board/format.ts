export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Elapsed time as a Phase Clock: `42s`, `12:41`, `2h 05m`, `3d 4h`. */
export function formatClock(sinceIso: string, nowMs: number): string {
  const since = Date.parse(sinceIso);
  if (Number.isNaN(since)) return "";
  const seconds = Math.max(0, Math.floor((nowMs - since) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}:${pad(seconds % 60)}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${pad(minutes % 60)}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** Whole-minute duration for quiet/timeout display: `45s`, `10m`, `1h 05m`. */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.floor(seconds))}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${pad(minutes % 60)}m`;
}

export function formatQuiet(quiet: { silentSeconds: number; timeoutSeconds: number }): string {
  return `quiet ${formatDuration(quiet.silentSeconds)} / ${formatDuration(quiet.timeoutSeconds)}`;
}

/** Time left until an ISO instant: `in 3m`, `in 1h 05m`, `now`. */
export function formatCountdown(untilIso: string, nowMs: number): string {
  const until = Date.parse(untilIso);
  if (Number.isNaN(until)) return "";
  const seconds = Math.max(0, Math.round((until - nowMs) / 1000));
  if (seconds < 30) return "now";
  return `in ${formatDuration(Math.max(60, seconds))}`;
}

export function feedTime(at: string): string {
  return at.length >= 19 ? at.slice(11, 19) : at;
}
