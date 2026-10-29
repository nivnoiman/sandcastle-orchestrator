import { join } from "node:path";
import { agentDetail, AgentWaitError, jsonLines, plainStderrOf, stringField } from "../agentFailure.js";
import type { Mount } from "../docker.js";
import type { OrchestratorConfig } from "../env.js";
import { codexDirOf, CONTAINER_HOME, type SandcastleLayout } from "../paths.js";
import { assertQuotableModel, CONTAINER_AUTOCRLF, HOST_CLAUDE_DIR, requiredSkillChecks } from "./claude.js";
import type { AgentProvider, RefreshableCredential } from "./provider.js";

export const HOST_CODEX_DIR = `${CONTAINER_HOME}/.codex-host`;
export const CONTAINER_CODEX_DIR = `${CONTAINER_HOME}/.codex`;
/** Codex discovers user skills here; it points at the same `~/.claude/skills` copy every prompt reads by path. */
export const CONTAINER_AGENTS_SKILLS = `${CONTAINER_HOME}/.agents/skills`;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Codex refreshes ChatGPT tokens once `last_refresh` is ~8 days old; refresh a day earlier, serialized. */
export const CODEX_REFRESH_AFTER_MS = 7 * DAY_MS;

export const CODEX_FLAGS = ["--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "--ephemeral"];
const RATE_LIMIT = /you.ve hit your usage limit|usage_limit_reached|usage limit reached|rate limit exceeded|quota exceeded/i;
const AUTH_FAILURE =
  /refresh token (?:has expired|was already used|was revoked)|failed to refresh token|not logged in|invalid api key|incorrect api key|401 unauthorized|status 401|token_expired|please (?:log|sign) in again/i;
const RESET_AT = /try again at (?:([A-Z][a-z]{2}) (\d{1,2})(?:st|nd|rd|th)?, (\d{4}) )?(\d{1,2}):(\d{2}) ?([AP]M)/i;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export function codexCommand(model: string | undefined): string {
  const modelArgs = model === undefined ? [] : ["--model", assertQuotableModel(model)];
  return ["codex", "exec", ...CODEX_FLAGS, ...modelArgs, "-"].join(" ");
}

export function codexHydrateCommand(): string {
  return [
    "set -o pipefail",
    `rm -rf ${CONTAINER_CODEX_DIR} ${CONTAINER_HOME}/.claude ${CONTAINER_HOME}/.agents`,
    `mkdir -p ${CONTAINER_CODEX_DIR} ${CONTAINER_HOME}/.claude ${CONTAINER_HOME}/.agents`,
    `tar -C ${HOST_CLAUDE_DIR} --ignore-failed-read -cf - ./skills ./commands | tar -C ${CONTAINER_HOME}/.claude -xf -`,
    `ln -s ${CONTAINER_HOME}/.claude/skills ${CONTAINER_AGENTS_SKILLS}`,
    `printf 'cli_auth_credentials_store = "file"\\n' > ${CONTAINER_CODEX_DIR}/config.toml`,
    `if [ -f ${HOST_CODEX_DIR}/auth.json ]; then install -m 600 ${HOST_CODEX_DIR}/auth.json ${CONTAINER_CODEX_DIR}/auth.json; fi`,
    `if [ -f ${HOST_CODEX_DIR}/AGENTS.md ]; then install -m 644 ${HOST_CODEX_DIR}/AGENTS.md ${CONTAINER_CODEX_DIR}/AGENTS.md; fi`,
    `git config --global core.autocrlf ${CONTAINER_AUTOCRLF}`,
    ...requiredSkillChecks(),
  ].join(" && ");
}

/** The Codex login plus the shared skill source — never the Claude login. */
export function codexHomeMounts(layout: SandcastleLayout): Mount[] {
  return [
    { hostPath: codexDirOf(layout), containerPath: HOST_CODEX_DIR, readonly: true },
    { hostPath: join(layout.claudeDir, "skills"), containerPath: `${HOST_CLAUDE_DIR}/skills`, readonly: true },
    { hostPath: join(layout.claudeDir, "commands"), containerPath: `${HOST_CLAUDE_DIR}/commands`, readonly: true },
  ];
}

export function codexAuthEnv(config: Pick<OrchestratorConfig, "codexApiKey">): Record<string, string> {
  return config.codexApiKey ? { CODEX_API_KEY: config.codexApiKey } : {};
}

/** Codex prints failures as JSON on stdout (`error`, `turn.failed`, an `error` item); tool output is never scanned. */
export function codexErrorMessages(stdout: string, stderr: string): string[] {
  const messages: string[] = [];
  for (const event of [...jsonLines(stdout), ...jsonLines(stderr)]) {
    const type = event["type"];
    if (type === "error") messages.push(stringField(event, "message") ?? "");
    if (type === "turn.failed") messages.push(stringField(event["error"], "message") ?? "");
    if (type === "item.completed" && stringField(event["item"], "type") === "error") {
      messages.push(stringField(event["item"], "message") ?? "");
    }
  }
  const plainStderr = stderr
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("{"))
    .join("\n");
  if (plainStderr.trim()) messages.push(plainStderr);
  return messages.filter((message) => message.trim().length > 0);
}

/** "try again at 3:15 PM" (next occurrence) or "try again at Oct 24th, 2026 3:15 PM"; the container clock is UTC. */
export function codexResetAt(message: string, now: number): number | undefined {
  const match = RESET_AT.exec(message);
  if (!match) return undefined;
  const [, monthName, day, year, rawHour, minute, meridiem] = match;
  const hour = (Number(rawHour) % 12) + (meridiem!.toUpperCase() === "PM" ? 12 : 0);
  if (monthName !== undefined) {
    const month = MONTHS.indexOf(monthName.toLowerCase());
    if (month < 0) return undefined;
    return Date.UTC(Number(year), month, Number(day), hour, Number(minute));
  }
  const today = new Date(now);
  const candidate = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), hour, Number(minute));
  return candidate > now ? candidate : candidate + DAY_MS;
}

export function classifyCodexOutput(stdout: string, stderr: string, now: number = Date.now()): AgentWaitError | undefined {
  const messages = codexErrorMessages(stdout, stderr);
  const detail = agentDetail(stdout, stderr);
  if (messages.some((message) => AUTH_FAILURE.test(message))) {
    return new AgentWaitError("auth", undefined, detail, "agent credentials rejected by Codex CLI (ChatGPT login or CODEX_API_KEY)");
  }
  const limited = messages.filter((message) => RATE_LIMIT.test(message)).at(-1);
  if (limited === undefined) return undefined;
  const resumeAt = codexResetAt(limited, now);
  const when = resumeAt === undefined ? "" : ` — the window reopens at ${new Date(resumeAt).toISOString()}`;
  return new AgentWaitError("rate-limit", resumeAt, detail, `Codex CLI usage limit reached${when}`);
}

export function isStaleCodexLogin(content: string, now: number): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || !("tokens" in parsed) || !parsed.tokens) return false;
  const lastRefresh = Date.parse(stringField(parsed, "last_refresh") ?? "");
  return Number.isNaN(lastRefresh) || now - lastRefresh > CODEX_REFRESH_AFTER_MS;
}

export const codexLogin: RefreshableCredential = {
  hostPath: (layout) => join(codexDirOf(layout), "auth.json"),
  containerPath: `${CONTAINER_CODEX_DIR}/auth.json`,
  isStale: isStaleCodexLogin,
  overriddenBy: (config) => config.codexApiKey !== undefined,
};

export const codexProvider: AgentProvider = {
  name: "codex",
  label: "Codex CLI",
  egressHosts: ["api.openai.com", "chatgpt.com", "auth.openai.com"],
  skillTool: false,
  command: codexCommand,
  homeMounts: codexHomeMounts,
  hydrateCommand: codexHydrateCommand,
  authEnv: codexAuthEnv,
  classify: (stdout, stderr) => classifyCodexOutput(stdout, stderr),
  credential: codexLogin,
};
