export const PROVIDER_NAMES = ["claude", "codex", "cursor"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

/** Every place an agent CLI runs; salvage runs under its stage's role. */
export const AGENT_ROLES = ["develop", "simplify", "review", "resolve", "feature-verify", "feature-fix", "polish"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export interface AgentChoice {
  provider: ProviderName;
  model: string | undefined;
}

export interface AgentsConfig {
  default: AgentChoice;
  roles: Partial<Record<AgentRole, AgentChoice>>;
}

export const DEFAULT_AGENTS: AgentsConfig = { default: { provider: "claude", model: undefined }, roles: {} };

/** A model name safe to splice into an agent command line unquoted. */
export const MODEL_NAME = /^[A-Za-z0-9._-]+$/;

export function isProviderName(value: unknown): value is ProviderName {
  return typeof value === "string" && (PROVIDER_NAMES as readonly string[]).includes(value);
}

export function isAgentRole(value: string): value is AgentRole {
  return (AGENT_ROLES as readonly string[]).includes(value);
}

export function parseChoice(raw: unknown, where: string): AgentChoice {
  const providers = PROVIDER_NAMES.map((name) => `"${name}"`).join(", ");
  if (typeof raw === "string") {
    if (!isProviderName(raw)) throw new Error(`${where} must be one of ${providers}, got ${JSON.stringify(raw)}`);
    return { provider: raw, model: undefined };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${where} must be a provider name or { "provider": ..., "model": ... }`);
  }
  const entry = raw as Record<string, unknown>;
  const unknownKey = Object.keys(entry).find((key) => key !== "provider" && key !== "model");
  if (unknownKey) throw new Error(`${where}.${unknownKey} is not a setting — use "provider" and "model"`);
  const provider = entry["provider"];
  if (!isProviderName(provider)) throw new Error(`${where}.provider must be one of ${providers}, got ${JSON.stringify(provider)}`);
  const model = entry["model"];
  if (model === undefined) return { provider, model: undefined };
  if (typeof model !== "string" || !MODEL_NAME.test(model)) {
    throw new Error(`${where}.model must be a plain model name (letters, digits, . _ -), got ${JSON.stringify(model)}`);
  }
  return { provider, model };
}

/** `agents` in config.json: `{ "default": "claude", "review": "codex", "polish": { "provider": "codex", "model": "…" } }`. */
export function parseAgents(raw: unknown): AgentsConfig {
  if (raw === undefined) return DEFAULT_AGENTS;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("agents must be an object");
  const roles: Partial<Record<AgentRole, AgentChoice>> = {};
  let fallback = DEFAULT_AGENTS.default;
  for (const [key, value] of Object.entries(raw)) {
    if (key === "default") {
      fallback = parseChoice(value, "agents.default");
      continue;
    }
    if (!isAgentRole(key)) throw new Error(`agents.${key} is not an agent role — use "default" or one of ${AGENT_ROLES.join(", ")}`);
    roles[key] = parseChoice(value, `agents.${key}`);
  }
  return { default: fallback, roles };
}
