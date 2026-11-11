import type { Express, Request, Response } from "express";
import { messageOf } from "../messageOf.js";
import type { AttemptChunk, AttemptRecord } from "../real/attemptLog.js";
import { capText, lastAgentMessage, TAIL_BYTES, TASK_CAP, wholeLines, type AttemptTail, type SummaryResult } from "./summary.js";
import type { UiState } from "./state.js";

export class SummaryError extends Error {}

export interface SummaryRouteDeps {
  state(): UiState;
  /** Attempt records of an item, or of a parent for its lifecycle steps. */
  attempts(number: number): AttemptRecord[];
  read(id: string, from: number): AttemptChunk;
  task(number: number): string | undefined;
}

function numberOf(request: Request): number {
  const raw = request.query["item"];
  if (typeof raw !== "string" || !/^[1-9]\d{0,9}$/.test(raw)) throw new SummaryError("item must be a positive integer");
  return Number(raw);
}

function known(state: UiState, number: number): boolean {
  return state.runs.some((run) => run.parent.number === number || run.items.some((item) => item.number === number)) || state.items.some((item) => item.number === number);
}

function tailOf(deps: SummaryRouteDeps, record: AttemptRecord): AttemptTail {
  const from = Math.max(0, record.bytes - TAIL_BYTES);
  try {
    const { chunk } = deps.read(record.id, from);
    return { id: record.id, ...lastAgentMessage(wholeLines(chunk, from === 0)) };
  } catch {
    return { id: record.id, message: undefined, clipped: false };
  }
}

export function buildSummary(deps: SummaryRouteDeps, number: number): SummaryResult {
  const task = deps.task(number);
  const capped = task === undefined || task.trim() === "" ? undefined : capText(task, TASK_CAP);
  return {
    task: capped?.text,
    taskClipped: capped?.clipped ?? false,
    attempts: deps.attempts(number).map((record) => tailOf(deps, record)),
    generatedAt: new Date().toISOString(),
  };
}

function reply(response: Response, work: () => SummaryResult): void {
  response.set("cache-control", "no-store");
  try {
    response.json({ ok: true, result: work() });
  } catch (cause) {
    const isKnown = cause instanceof SummaryError;
    if (!isKnown) console.error(`summary: ${messageOf(cause).split("\n")[0]}`);
    response.status(isKnown ? 400 : 500).json({ ok: false, error: isKnown ? cause.message : "could not read the summary" });
  }
}

export function mountSummaryRoutes(app: Express, deps: SummaryRouteDeps): void {
  app.get("/api/summary", (request, response) => {
    reply(response, () => {
      const number = numberOf(request);
      if (!known(deps.state(), number)) throw new SummaryError("this item is no longer in the run");
      return buildSummary(deps, number);
    });
  });
}
