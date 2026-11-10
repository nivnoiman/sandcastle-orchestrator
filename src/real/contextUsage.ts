/** Context-window usage of a running Claude agent, read from its stream-json transcript. Other providers report no per-turn context, so they yield nothing. */

/** What the transcript says; the window may be unknown. */
export interface ContextReading {
  /** Tokens in context at the latest main-thread turn: input + cache read + cache creation. */
  tokens: number;
  /** Model id the turn ran on (`message.model`). */
  model: string | undefined;
  /** Window the CLI itself reported in its final `result` event, if it did. */
  reportedWindow: number | undefined;
}

export interface UiUsage {
  tokens: number;
  /** Unset when the window of the model is unknown: tokens are shown without a percentage. */
  window: number | undefined;
  /** 0-100 (may pass 100 only if the window is wrong; then the window is dropped instead). */
  percent: number | undefined;
}

export const ONE_MILLION = 1_000_000;

/** Known windows by model-id prefix, first match wins. Unknown model: no guess. */
export const CONTEXT_WINDOWS: readonly { prefix: RegExp; tokens: number }[] = [
  { prefix: /^claude-opus-4-(?:[7-9]|\d{2})(?!\d)/, tokens: ONE_MILLION },
  { prefix: /^claude-(?:opus|sonnet)-(?:[5-9]|\d{2})(?!\d)/, tokens: ONE_MILLION },
  { prefix: /^claude-fable/, tokens: ONE_MILLION },
  { prefix: /^claude-(?:opus|sonnet|haiku)-[34]/, tokens: 200_000 },
  { prefix: /^claude-3/, tokens: 200_000 },
];

const MAX_PARTIAL_LINE_CHARS = 4_000_000;

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Parses one transcript line; returns what it adds to the reading, or undefined for any other line. */
export function usageFromLine(line: string): Partial<ContextReading> | undefined {
  if (!line.includes('"usage"') && !line.includes('"modelUsage"')) return undefined;
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(event)) return undefined;
  if (event["type"] === "result") {
    const perModel = isRecord(event["modelUsage"]) ? Object.values(event["modelUsage"]) : [];
    const windows = perModel.map((entry) => (isRecord(entry) ? count(entry["contextWindow"]) : 0)).filter((tokens) => tokens > 0);
    return windows.length > 0 ? { reportedWindow: Math.max(...windows) } : undefined;
  }
  if (event["type"] !== "assistant" || event["parent_tool_use_id"] != null) return undefined;
  const message = event["message"];
  if (!isRecord(message) || !isRecord(message["usage"])) return undefined;
  const usage = message["usage"];
  const tokens = count(usage["input_tokens"]) + count(usage["cache_read_input_tokens"]) + count(usage["cache_creation_input_tokens"]);
  if (tokens === 0) return undefined;
  const model = typeof message["model"] === "string" && !message["model"].startsWith("<") ? message["model"] : undefined;
  return { tokens, model };
}

/** Folds appended transcript chunks into a reading; keeps only the partial last line between calls, never the log. */
export class ContextTracker {
  private pending = "";
  private current: ContextReading | undefined;

  push(chunk: string): void {
    const lines = (this.pending + chunk).split("\n");
    const partial = lines.pop() ?? "";
    this.pending = partial.length > MAX_PARTIAL_LINE_CHARS ? "" : partial;
    for (const line of lines) this.apply(line);
  }

  private apply(line: string): void {
    const found = usageFromLine(line);
    if (!found) return;
    this.current = {
      tokens: found.tokens ?? this.current?.tokens ?? 0,
      model: found.model ?? this.current?.model,
      reportedWindow: found.reportedWindow ?? this.current?.reportedWindow,
    };
  }

  reading(): ContextReading | undefined {
    return this.current && { ...this.current };
  }
}

/** Window by priority: the CLI's own report, a `[1m]` configured model, the known table; undefined if none applies. */
export function contextWindow(reading: ContextReading, configuredModel: string | undefined): number | undefined {
  if (reading.reportedWindow !== undefined) return reading.reportedWindow;
  if (configuredModel !== undefined && /\[1m\]$/i.test(configuredModel)) return ONE_MILLION;
  const model = reading.model ?? configuredModel;
  return CONTEXT_WINDOWS.find((entry) => model !== undefined && entry.prefix.test(model))?.tokens;
}

export function uiUsage(reading: ContextReading | undefined, configuredModel: string | undefined): UiUsage | undefined {
  if (!reading) return undefined;
  const window = contextWindow(reading, configuredModel);
  if (window === undefined || reading.tokens > window) return { tokens: reading.tokens, window: undefined, percent: undefined };
  return { tokens: reading.tokens, window, percent: Math.round((reading.tokens / window) * 100) };
}
