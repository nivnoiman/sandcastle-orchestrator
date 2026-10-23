import type { ReworkBrief, ReworkContext } from "./adapters.js";

export const REWORK_LIMIT_DEFAULT = 3;

export function reworkRoundOf(subject: { rework?: ReworkContext }): number {
  return subject.rework?.round ?? 0;
}

export function reworkTitle(brief: ReworkBrief, limit: number): string {
  return `Rework ${brief.round}/${limit} — sent back by ${brief.source}`;
}

export function reworkHeading(brief: ReworkBrief, limit: number): string {
  return `## ${reworkTitle(brief, limit)}`;
}

export function reworkComment(brief: ReworkBrief, limit: number): string {
  return [
    `sandcastle sent this item back to develop — rework round ${brief.round} of ${limit}, raised by the ${brief.source} stage.`,
    "It re-runs develop → simplify → review → verify with the story below as its brief.",
    "",
    reworkHeading(brief, limit),
    "",
    brief.story.trim(),
  ].join("\n");
}

export function reworkLimitDetail(briefs: readonly ReworkBrief[], limit: number): string {
  return briefs.map((brief) => `${reworkHeading(brief, limit)}\n\n${brief.story.trim()}`).join("\n\n");
}
