export type TurnKind = "" | "meta" | "tool" | "result" | "err";

export interface Turn {
  kind: TurnKind;
  text: string;
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  return value === undefined || value === null ? "" : JSON.stringify(value);
}

function firstLine(value: unknown): string {
  const text = textOf(value).replace(/\s+/g, " ").trim();
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

function describeCodexEvent(event: Json): Turn | undefined {
  if (event["type"] === "thread.started") return { kind: "meta", text: `codex thread ${textOf(event["thread_id"])}`.trim() };
  if (event["type"] === "error") return { kind: "err", text: `error: ${textOf(event["message"])}` };
  if (event["type"] === "turn.failed") {
    const error = isRecord(event["error"]) ? event["error"] : {};
    return { kind: "err", text: `turn failed: ${textOf(error["message"])}` };
  }
  if (event["type"] === "turn.completed") {
    const usage = isRecord(event["usage"]) ? event["usage"] : {};
    return { kind: "result", text: `turn done · ${textOf(usage["input_tokens"] ?? "?")} in · ${textOf(usage["output_tokens"] ?? "?")} out` };
  }
  const item = event["item"];
  if (event["type"] !== "item.completed" || !isRecord(item)) return undefined;
  if (item["type"] === "agent_message") return { kind: "", text: textOf(item["text"]).trim() };
  if (item["type"] === "command_execution") {
    return { kind: "tool", text: `→ $ ${firstLine(item["command"])} (exit ${textOf(item["exit_code"] ?? "?")})` };
  }
  if (item["type"] === "file_change") {
    const changes = Array.isArray(item["changes"]) ? item["changes"] : [];
    return { kind: "tool", text: `→ edit ${changes.map((change) => (isRecord(change) ? textOf(change["path"]) : "")).join(", ")}` };
  }
  if (item["type"] === "error") return { kind: "err", text: `error: ${textOf(item["message"])}` };
  return undefined;
}

function cursorToolText(toolCall: unknown): string {
  if (!isRecord(toolCall)) return "";
  const [kind, body] = Object.entries(toolCall)[0] ?? [];
  if (kind === undefined) return "";
  const args = isRecord(body) && isRecord(body["args"]) ? body["args"] : isRecord(body) ? body : {};
  const target = args["path"] ?? args["command"] ?? args["pattern"] ?? args["arguments"];
  const name = isRecord(body) && typeof body["name"] === "string" ? body["name"] : kind.replace(/ToolCall$/, "");
  return `${name}: ${firstLine(target ?? args)}`;
}

/** cursor-agent stream-json: `tool_call` started/completed events; `system`/`assistant`/`result` share the claude shapes. */
function describeCursorToolCall(event: Json): Turn | undefined {
  if (event["subtype"] === "started") return { kind: "tool", text: `→ ${cursorToolText(event["tool_call"])}` };
  if (event["subtype"] !== "completed") return undefined;
  const call = isRecord(event["tool_call"]) ? Object.values(event["tool_call"])[0] : undefined;
  const result = isRecord(call) && isRecord(call["result"]) ? call["result"] : {};
  const failed = result["error"] !== undefined || result["failure"] !== undefined;
  return { kind: failed ? "err" : "tool", text: `← ${cursorToolText(event["tool_call"])}` };
}

function describeEvent(event: Json): Turn | undefined {
  const type = event["type"];
  if (type === "tool_call") return describeCursorToolCall(event);
  if (typeof type === "string" && /^(thread|turn|item)\.|^error$/.test(type)) return describeCodexEvent(event);
  if (type === "system") return { kind: "meta", text: `system: ${textOf(event["subtype"])} ${textOf(event["model"])}`.trim() };
  if (type === "rate_limit_event") {
    const info = isRecord(event["rate_limit_info"]) ? event["rate_limit_info"] : {};
    return { kind: "err", text: `rate limit: ${textOf(info["rateLimitType"])} ${textOf(info["status"])} resetsAt ${textOf(info["resetsAt"] ?? "?")}` };
  }
  if (type === "result") {
    const cost = event["total_cost_usd"] === undefined ? "" : ` · $${Number(event["total_cost_usd"]).toFixed(2)}`;
    const turns = event["num_turns"] === undefined ? "" : ` · ${textOf(event["num_turns"])} turns`;
    return { kind: event["is_error"] ? "err" : "result", text: `result${turns}${cost}\n${textOf(event["result"])}` };
  }
  if (type !== "assistant" && type !== "user") return undefined;
  const message = isRecord(event["message"]) ? event["message"] : {};
  const content = Array.isArray(message["content"]) ? message["content"] : [];
  const parts: Turn[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block["type"] === "text" && textOf(block["text"]).trim()) parts.push({ kind: "", text: textOf(block["text"]).trim() });
    if (block["type"] === "tool_use") parts.push({ kind: "tool", text: `→ ${textOf(block["name"])}: ${firstLine(block["input"])}` });
    if (block["type"] === "tool_result") parts.push({ kind: "tool", text: `← ${firstLine(block["content"])}` });
  }
  const first = parts[0];
  if (!first) return undefined;
  return { kind: first.kind, text: parts.map((part) => part.text).join("\n") };
}

/** Agent transcript (claude, codex or cursor JSON lines) as readable turns; non-JSON lines pass through as meta. */
export function transcriptTurns(text: string): Turn[] {
  const turns: Turn[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (!trimmed.startsWith("{")) {
      turns.push({ kind: "meta", text: trimmed });
      continue;
    }
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      turns.push({ kind: "meta", text: trimmed.slice(0, 400) });
      continue;
    }
    if (!isRecord(event)) continue;
    const turn = describeEvent(event);
    if (turn) turns.push(turn);
  }
  return turns;
}
