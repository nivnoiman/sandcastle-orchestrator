import { join } from "node:path";
import { agentDetail, AgentWaitError, jsonLines } from "../agentFailure.js";
import type { Mount } from "../docker.js";
import type { OrchestratorConfig } from "../env.js";
import { CONTAINER_HOME, type SandcastleLayout } from "../paths.js";
import { assertQuotableModel, CONTAINER_AUTOCRLF, HOST_CLAUDE_DIR, requiredSkillChecks } from "./claude.js";
import type { AgentProvider } from "./provider.js";

export const CURSOR_FLAGS = ["-p", "--force", "--trust", "--output-format", "stream-json"];
const RATE_LIMIT = /rate.?limit|resource_exhausted|\b429\b|too many requests|usage limit|out of usage|quota exceeded/i;
const AUTH_FAILURE =
  /not logged in|authentication required|invalid api key|api key (?:is )?(?:invalid|rejected|expired)|unauthorized|\b401\b|please (?:log|sign) in|cursor_api_key/i;

/**
 * cursor-agent takes the prompt as a positional argument, not `-`/stdin, so the container shell
 * substitutes the stdin it is given (`$(cat)`); the prompt stays out of the host-side argv.
 */
export function cursorCommand(model: string | undefined): string {
  const modelArgs = model === undefined ? [] : ["--model", assertQuotableModel(model)];
  return ["cursor-agent", ...CURSOR_FLAGS, ...modelArgs, '"$(cat)"'].join(" ");
}

export function cursorHydrateCommand(): string {
  return [
    "set -o pipefail",
    `rm -rf ${CONTAINER_HOME}/.claude`,
    `mkdir -p ${CONTAINER_HOME}/.claude`,
    `tar -C ${HOST_CLAUDE_DIR} --ignore-failed-read -cf - ./skills ./commands | tar -C ${CONTAINER_HOME}/.claude -xf -`,
    `git config --global core.autocrlf ${CONTAINER_AUTOCRLF}`,
    ...requiredSkillChecks(),
  ].join(" && ");
}

/** Only the shared skill source — Cursor authenticates with `CURSOR_API_KEY`, no login dir is mounted. */
export function cursorHomeMounts(layout: SandcastleLayout): Mount[] {
  return [
    { hostPath: join(layout.claudeDir, "skills"), containerPath: `${HOST_CLAUDE_DIR}/skills`, readonly: true },
    { hostPath: join(layout.claudeDir, "commands"), containerPath: `${HOST_CLAUDE_DIR}/commands`, readonly: true },
  ];
}

export function cursorAuthEnv(config: Pick<OrchestratorConfig, "cursorApiKey">): Record<string, string> {
  return config.cursorApiKey ? { CURSOR_API_KEY: config.cursorApiKey } : {};
}

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

/** Failures: a `result` event with `is_error`, or plain stderr text (the process exits non-zero, often without a `result`). Tool output is never scanned. */
export function cursorErrorMessages(stdout: string, stderr: string): string[] {
  const messages: string[] = [];
  for (const event of jsonLines(stdout)) {
    if (event["type"] === "result" && event["is_error"] === true) messages.push(stringField(event, "result") ?? "");
    if (event["type"] === "error") messages.push(stringField(event, "message") ?? "");
  }
  const plainStderr = stderr
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("{"))
    .join("\n");
  if (plainStderr.trim()) messages.push(plainStderr);
  return messages.filter((message) => message.trim().length > 0);
}

/** Cursor gives no reset time, so a rate limit parks without a resume instant. */
export function classifyCursorOutput(stdout: string, stderr: string): AgentWaitError | undefined {
  const messages = cursorErrorMessages(stdout, stderr);
  const detail = agentDetail(stdout, stderr);
  if (messages.some((message) => AUTH_FAILURE.test(message))) {
    return new AgentWaitError("auth", undefined, detail, "agent credentials rejected by Cursor CLI (CURSOR_API_KEY)");
  }
  if (!messages.some((message) => RATE_LIMIT.test(message))) return undefined;
  return new AgentWaitError("rate-limit", undefined, detail, "Cursor CLI rate or usage limit reached");
}

export const cursorProvider: AgentProvider = {
  name: "cursor",
  label: "Cursor CLI",
  egressHosts: ["api2.cursor.sh", "api.cursor.com", "cursor.com", "repo42.cursor.sh", "api3.cursor.sh"],
  skillTool: false,
  command: cursorCommand,
  homeMounts: cursorHomeMounts,
  hydrateCommand: cursorHydrateCommand,
  authEnv: cursorAuthEnv,
  classify: (stdout, stderr) => classifyCursorOutput(stdout, stderr),
};
