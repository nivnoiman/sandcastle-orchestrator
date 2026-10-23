import { boundedTail, fencedBlock } from "../markdown.js";

export const PARK_DETAIL_LIMIT = 3000;

export function parkComment(reason: string, detail: string | undefined): string {
  const headline =
    `sandcastle parked this item: ${reason}. ` +
    "Dependents stay blocked; flip ready-for-human back to ready-for-agent to re-queue.";
  const trimmed = detail?.trim();
  if (!trimmed) return headline;
  return `${headline}\n\n${fencedBlock(boundedTail(trimmed, PARK_DETAIL_LIMIT))}`;
}
