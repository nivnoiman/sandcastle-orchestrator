import type { AgentRole, ProviderName } from "../../project/agentsConfig.js";
import type { AgentOutputClassifier } from "../agentFailure.js";
import type { Mount } from "../docker.js";
import type { OrchestratorConfig } from "../env.js";
import type { SandcastleLayout } from "../paths.js";

export type { AgentRole, ProviderName };

/** A login file the agent CLI rewrites when it refreshes its tokens; sandcastle copies refreshes back to the host. */
export interface RefreshableCredential {
  hostPath(layout: SandcastleLayout): string;
  containerPath: string;
  /** Old enough that the CLI will refresh on its next call — refresh it once, serialized, before parallel stages start. */
  isStale(content: string, now: number): boolean;
  /** An env credential the CLI prefers over this file (`CODEX_API_KEY`) is set — the file is never refreshed, so never gate on it. */
  overriddenBy(config: OrchestratorConfig): boolean;
}

export interface AgentProvider {
  readonly name: ProviderName;
  readonly label: string;
  readonly egressHosts: readonly string[];
  /** Can invoke a named skill/command itself (Claude's `Skill` tool) and spawn subagents. */
  readonly skillTool: boolean;
  /** The non-interactive command; the prompt arrives on stdin. No model → the CLI's own default. */
  command(model: string | undefined): string;
  /** Read-only host mounts the home hydrates from — only this provider's login, never another's. */
  homeMounts(layout: SandcastleLayout): Mount[];
  /** Builds the container-local home (login, instructions, skills); fails if a required skill is missing. */
  hydrateCommand(): string;
  /** Credential env for this provider's containers only. */
  authEnv(config: OrchestratorConfig): Record<string, string>;
  classify: AgentOutputClassifier;
  credential?: RefreshableCredential;
}

export interface ResolvedAgent {
  provider: AgentProvider;
  model: string | undefined;
}
