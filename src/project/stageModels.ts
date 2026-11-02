import type { AgentChoice, ProviderName } from "./agentsConfig.js";

/** The concrete model claude runs with when nothing pins one: `SANDCASTLE_MODEL` (develop) and `SANDCASTLE_REVIEW_MODEL` (every other stage). `null` = could not be read. */
export interface ClaudeDefaultModels {
  main: string | null;
  review: string | null;
}

export type ModelTier = "main" | "review";
export type ProviderFrom = "stage" | "project-default";
export type ModelFrom = "stage" | "project-default" | "provider-default" | "unpinned";

/** The agent a new run uses for a stage, with where each half came from. */
export interface EffectiveAgent {
  provider: ProviderName;
  providerFrom: ProviderFrom;
  model: string | null;
  modelFrom: ModelFrom;
}

/** Mirrors `resolveAgent` / `resolveStageAgent` in real/agents: the stage's own choice, else `agents.default`; a claude choice with no model falls to the env default for its tier. */
export function effectiveAgent(own: AgentChoice | undefined, projectDefault: AgentChoice, tier: ModelTier, claude: ClaudeDefaultModels): EffectiveAgent {
  const choice = own ?? projectDefault;
  const providerFrom: ProviderFrom = own ? "stage" : "project-default";
  if (choice.model !== undefined) return { provider: choice.provider, providerFrom, model: choice.model, modelFrom: own ? "stage" : "project-default" };
  const pinned = choice.provider === "claude" ? claude[tier] : null;
  if (pinned === null) return { provider: choice.provider, providerFrom, model: null, modelFrom: "unpinned" };
  return { provider: choice.provider, providerFrom, model: pinned, modelFrom: "provider-default" };
}

export function tierOf(stage: string): ModelTier {
  return stage === "develop" ? "main" : "review";
}

/** `claude · opus`, or `codex · provider default (model not pinned)` — never a guessed model. */
export function describeEffective(agent: EffectiveAgent): string {
  return `${agent.provider} · ${agent.model ?? "provider default (model not pinned)"}`;
}

export function effectiveHint(agent: EffectiveAgent): string {
  const provider = agent.providerFrom === "stage" ? "provider set on this stage" : "provider inherited from the project default";
  const model: Record<ModelFrom, string> = {
    stage: "model set on this stage",
    "project-default": "model inherited from the project default",
    "provider-default": "model is the provider's default (SANDCASTLE_MODEL / SANDCASTLE_REVIEW_MODEL, else built in)",
    unpinned: "no model pinned — the CLI picks its own",
  };
  return `${provider}; ${model[agent.modelFrom]}`;
}

export function effectiveSourceLabel(agent: EffectiveAgent): string {
  const labels: Record<ModelFrom, string> = { stage: "set on stage", "project-default": "inherited from default", "provider-default": "provider default model", unpinned: "model not pinned" };
  return labels[agent.modelFrom];
}
