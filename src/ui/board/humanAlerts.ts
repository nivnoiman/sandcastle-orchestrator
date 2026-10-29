import type { AttentionEntry } from "./attention.js";

/** Entries that need a person and count toward the badge; the ones worth a notification. */
export function alertable(entries: readonly AttentionEntry[]): AttentionEntry[] {
  return entries.filter((entry) => entry.counted);
}

/** Entries not in `seen`. An undefined `seen` is a project's first load: nothing is new yet. */
export function newlyNeedingAttention(seen: ReadonlySet<string> | undefined, entries: readonly AttentionEntry[]): AttentionEntry[] {
  if (seen === undefined) return [];
  return alertable(entries).filter((entry) => !seen.has(entry.key));
}

/** Hold is remembered per entry key and tied to the park reason, so a different failure shows again. */
export type HeldMap = Record<string, string>;

export function holdReasonOf(entry: AttentionEntry): string {
  return entry.park?.reason ?? entry.detail;
}

export function isHeld(held: HeldMap, entry: AttentionEntry): boolean {
  return entry.kind === "parked" && held[entry.key] === holdReasonOf(entry);
}

export function parseHeld(raw: string | undefined): HeldMap {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    return Object.fromEntries(Object.entries(parsed).filter((pair): pair is [string, string] => typeof pair[1] === "string"));
  } catch {
    return {};
  }
}

/** One line for a toast or desktop notification. */
export function alertText(entry: AttentionEntry): { title: string; body: string } {
  return { title: `${entry.projectName}: ${entry.title}`, body: entry.park ? entry.park.reason : entry.detail };
}

export function pageTitle(count: number, projectName: string | undefined): string {
  return `${count > 0 ? `(${count}) ` : ""}Sandcastle${projectName ? ` · ${projectName}` : ""}`;
}
