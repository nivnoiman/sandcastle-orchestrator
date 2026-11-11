import { transcriptTurns } from "./board/transcript.js";
import { redactSecrets } from "./changes/diff.js";

export const TAIL_BYTES = 64 * 1024;
export const MESSAGE_CAP = 1500;
export const TASK_CAP = 2500;

export interface AttemptTail {
  id: string;
  message: string | undefined;
  clipped: boolean;
}

export interface SummaryResult {
  task: string | undefined;
  taskClipped: boolean;
  attempts: AttemptTail[];
  generatedAt: string;
}

export function capText(text: string, cap: number): { text: string; clipped: boolean } {
  const clean = redactSecrets(text).trim();
  if (clean.length <= cap) return { text: clean, clipped: false };
  return { text: `${clean.slice(0, cap).trimEnd()}…`, clipped: true };
}

/** Final agent message of a log tail: the result text, else the last plain agent turn. Capped and redacted. */
export function lastAgentMessage(logText: string): { message: string | undefined; clipped: boolean } {
  const turns = transcriptTurns(logText);
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    if (turn.kind !== "" && turn.kind !== "result") continue;
    const body = turn.kind === "result" ? turn.text.split("\n").slice(1).join("\n") : turn.text;
    if (body.trim() === "") continue;
    const { text, clipped } = capText(body, MESSAGE_CAP);
    return { message: text, clipped };
  }
  return { message: undefined, clipped: false };
}

/** A chunk read from the middle of a file starts mid-line; drop that partial first line. */
export function wholeLines(chunk: string, fromStart: boolean): string {
  if (fromStart) return chunk;
  const newline = chunk.indexOf("\n");
  return newline < 0 ? "" : chunk.slice(newline + 1);
}
