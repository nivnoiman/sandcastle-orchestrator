import type { WaitReason } from "../engine/adapters.js";
import { transientSignature } from "../engine/transient.js";
import { CommandFailure } from "./commandRunner.js";

export type { WaitReason };

export const AGENT_DETAIL_LIMIT = 1200;
export const TRANSIENT_SCAN_LIMIT = 4000;

const AUTH_PHRASES = [
  "oauth session expired",
  "failed to authenticate",
  "invalid api key",
  "authentication_error",
  "please run /login",
  "authentication_failed",
  "oauth access token has been revoked",
];

const HTTP_UNAUTHORIZED = 401;

export class AgentWaitError extends Error {
  readonly agentWait = true;

  constructor(
    readonly reason: WaitReason,
    readonly resumeAt: number | undefined,
    readonly detail: string,
    message?: string,
  ) {
    super(message ?? waitErrorMessage(reason, resumeAt, detail));
    this.name = "AgentWaitError";
  }
}

function waitErrorMessage(reason: WaitReason, resumeAt: number | undefined, detail: string): string {
  if (reason === "rate-limit") return rateLimitMessage(resumeAt);
  if (reason === "transient") return `transient infrastructure failure (${transientSignature(detail) ?? "network"})`;
  return "agent credentials rejected by the Claude API";
}

export function rateLimitMessage(resumeAt: number | undefined): string {
  if (resumeAt === undefined) return "five-hour usage limit reached";
  return `five-hour usage limit reached — the window reopens at ${new Date(resumeAt).toISOString()}`;
}

export function jsonLines(text: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null) events.push(parsed as Record<string, unknown>);
    } catch {
      continue;
    }
  }
  return events;
}

function rateLimitInfo(event: Record<string, unknown>): Record<string, unknown> | undefined {
  const info = event["rate_limit_info"];
  if (typeof info !== "object" || info === null) return undefined;
  return info as Record<string, unknown>;
}

function resetsAtMs(event: Record<string, unknown>): number | undefined {
  const resetsAt = rateLimitInfo(event)?.["resetsAt"];
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt)) return undefined;
  return resetsAt > 1e11 ? resetsAt : resetsAt * 1000;
}

export function lastStreamEvent(text: string): Record<string, unknown> | undefined {
  return jsonLines(text).at(-1);
}

export function tail(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `…${trimmed.slice(-limit)}`;
}

export function agentDetail(stdout: string, stderr: string): string {
  const event = lastStreamEvent(stdout) ?? lastStreamEvent(stderr);
  const parts = [stderr.trim() ? `stderr: ${tail(stderr, AGENT_DETAIL_LIMIT)}` : ""];
  if (event) parts.push(`last event: ${tail(JSON.stringify(event), AGENT_DETAIL_LIMIT)}`);
  else parts.push(tail(stdout, AGENT_DETAIL_LIMIT));
  return parts.filter((part) => part.length > 0).join("\n");
}

function isRejectedLimit(event: Record<string, unknown>): boolean {
  return event["type"] === "rate_limit_event" && rateLimitInfo(event)?.["status"] === "rejected";
}

function isUnauthorizedEvent(event: Record<string, unknown>): boolean {
  return event["api_error_status"] === HTTP_UNAUTHORIZED || event["error_status"] === HTTP_UNAUTHORIZED;
}

function mentionsAuthFailure(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`.toLowerCase();
  return AUTH_PHRASES.some((phrase) => haystack.includes(phrase));
}

export function classifyAgentOutput(stdout: string, stderr: string): AgentWaitError | undefined {
  const events = [...jsonLines(stdout), ...jsonLines(stderr)];
  const detail = agentDetail(stdout, stderr);
  if (events.some(isUnauthorizedEvent)) return new AgentWaitError("auth", undefined, detail);
  const limited = events.filter(isRejectedLimit).at(-1);
  if (limited) return new AgentWaitError("rate-limit", resetsAtMs(limited), detail);
  if (mentionsAuthFailure(stdout, stderr)) return new AgentWaitError("auth", undefined, detail);
  return undefined;
}

export type AgentOutputClassifier = (stdout: string, stderr: string) => AgentWaitError | undefined;

export function agentWaitFrom(cause: unknown, classify: AgentOutputClassifier = classifyAgentOutput): AgentWaitError | undefined {
  if (cause instanceof AgentWaitError) return cause;
  if (!(cause instanceof CommandFailure)) return undefined;
  return classify(cause.stdout, cause.stderr);
}

export function transientWaitFrom(cause: unknown): AgentWaitError | undefined {
  if (!(cause instanceof CommandFailure)) return undefined;
  const scanned = tail(`${cause.stdout}\n${cause.stderr}`, TRANSIENT_SCAN_LIMIT);
  if (!transientSignature(scanned)) return undefined;
  return new AgentWaitError("transient", undefined, scanned);
}

export function isAgentWait(cause: unknown): cause is AgentWaitError {
  return cause instanceof AgentWaitError;
}

export function commandFailureDetail(cause: unknown): string | undefined {
  if (!(cause instanceof CommandFailure)) return undefined;
  return agentDetail(cause.stdout, cause.stderr);
}
