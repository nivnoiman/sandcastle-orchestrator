import { isAgentRole, type AgentRole, type ProviderName } from "../../project/agentsConfig.js";
import type { StageSpec } from "../../project/stagesConfig.js";
import type { CommandRunner } from "../commandRunner.js";
import type { OrchestratorConfig } from "../env.js";
import type { FileSystemPort } from "../fileSystem.js";
import type { SandcastleLayout } from "../paths.js";
import { claudeProvider } from "./claude.js";
import { codexProvider } from "./codex.js";
import { cursorProvider } from "./cursor.js";
import type { AgentProvider, ResolvedAgent } from "./provider.js";
import { messageOf } from "../../messageOf.js";

export type { AgentProvider, AgentRole, ProviderName, ResolvedAgent };
export { claudeProvider, codexProvider, cursorProvider };

const PROVIDERS: Record<ProviderName, AgentProvider> = { claude: claudeProvider, codex: codexProvider, cursor: cursorProvider };
const MAIN_MODEL_ROLES: ReadonlySet<AgentRole> = new Set(["develop", "resolve", "feature-fix"]);

export function providerNamed(name: ProviderName): AgentProvider {
  return PROVIDERS[name];
}

type AgentSettings = Pick<OrchestratorConfig, "agents" | "model" | "reviewModel">;

export function resolveAgent(config: AgentSettings, role: AgentRole): ResolvedAgent {
  const choice = config.agents.roles[role] ?? config.agents.default;
  const provider = providerNamed(choice.provider);
  if (choice.model !== undefined || provider.name !== "claude") return { provider, model: choice.model };
  return { provider, model: MAIN_MODEL_ROLES.has(role) ? config.model : config.reviewModel };
}

/** The default agent: non-agent containers (the verify gate) hydrate its home, and the auth probe uses `SANDCASTLE_MODEL` for claude. */
export function defaultAgent(config: AgentSettings): ResolvedAgent {
  const choice = config.agents.default;
  const provider = providerNamed(choice.provider);
  return { provider, model: choice.model ?? (provider.name === "claude" ? config.model : undefined) };
}

type StageAgentSettings = AgentSettings & { stages?: readonly StageSpec[] };

/** The agent for a chain stage: a built-in role as `resolveAgent`, a custom agent stage from its own entry (else `agents.default`). */
export function resolveStageAgent(config: StageAgentSettings, stage: string): ResolvedAgent {
  if (isAgentRole(stage)) return resolveAgent(config, stage);
  const spec = config.stages?.find((candidate) => candidate.name === stage);
  if (spec?.kind !== "agent") throw new Error(`"${stage}" is not an agent stage of this project`);
  const choice = spec.agent ?? config.agents.default;
  const provider = providerNamed(choice.provider);
  if (choice.model !== undefined || provider.name !== "claude") return { provider, model: choice.model };
  return { provider, model: config.reviewModel };
}

/** One agent per provider in use, default first — what the auth probe and preflight must cover. */
export function agentsInUse(config: StageAgentSettings): ResolvedAgent[] {
  const agents = new Map<ProviderName, ResolvedAgent>();
  const fallback = defaultAgent(config);
  agents.set(fallback.provider.name, fallback);
  const customStages = (config.stages ?? []).filter((stage) => stage.kind === "agent").map((stage) => stage.name);
  const inUse = [
    ...(Object.keys(config.agents.roles) as AgentRole[]).map((role) => resolveAgent(config, role)),
    ...customStages.map((stage) => resolveStageAgent(config, stage)),
  ];
  for (const agent of inUse) {
    if (!agents.has(agent.provider.name)) agents.set(agent.provider.name, agent);
  }
  return [...agents.values()];
}

/** `opus`, or `codex default model` / `codex gpt-5.5` for non-claude agents — log lines stay as they were for claude. */
export function describeAgent(agent: ResolvedAgent): string {
  const model = agent.model ?? "default model";
  return agent.provider.name === "claude" ? model : `${agent.provider.name} ${model}`;
}

export interface CredentialSnapshot {
  hostPath: string;
  containerPath: string;
  content: string;
}

/** What the container will copy in, so a refresh inside it can be written back without clobbering a newer host login. */
export function snapshotCredential(fs: FileSystemPort, layout: SandcastleLayout, provider: AgentProvider): CredentialSnapshot | undefined {
  const credential = provider.credential;
  if (!credential) return undefined;
  const hostPath = credential.hostPath(layout);
  const content = fs.readText(hostPath);
  if (content === undefined) return undefined;
  return { hostPath, containerPath: credential.containerPath, content };
}

/** Copies a login the agent refreshed inside the container back to the host, so the rotated refresh token is not lost. Never throws: it runs from `finally` blocks. */
export function syncBackCredential(
  deps: { runner: CommandRunner; fs: FileSystemPort; log: (message: string) => void },
  container: string,
  snapshot: CredentialSnapshot | undefined,
): void {
  if (!snapshot) return;
  let refreshed: string;
  try {
    refreshed = deps.runner.run({ command: "docker", args: ["exec", container, "cat", snapshot.containerPath] }).stdout;
  } catch (cause) {
    deps.log(`[auth][warn] could not read ${snapshot.containerPath} back from ${container}: ${messageOf(cause)}`);
    return;
  }
  if (refreshed === snapshot.content || refreshed.trim().length === 0) return;
  try {
    JSON.parse(refreshed);
  } catch {
    deps.log(`[auth][warn] ${container} left an unreadable ${snapshot.containerPath} — the host login is kept as it was`);
    return;
  }
  const atomicWriteStaging = `${snapshot.hostPath}.sandcastle-${process.pid}.tmp`;
  try {
    if (deps.fs.readText(snapshot.hostPath) !== snapshot.content) {
      deps.log(`[auth][warn] ${snapshot.hostPath} changed on the host during the run — keeping the host's copy, not ${container}'s refresh`);
      return;
    }
    deps.fs.writePrivateText(atomicWriteStaging, refreshed);
    deps.fs.rename(atomicWriteStaging, snapshot.hostPath);
  } catch (cause) {
    deps.log(`[auth][error] could not write ${container}'s refreshed login to ${snapshot.hostPath}: ${messageOf(cause)}`);
    try {
      deps.fs.removeFile(atomicWriteStaging);
    } catch (removeCause) {
      deps.log(`[auth][warn] could not remove ${atomicWriteStaging}: ${messageOf(removeCause)}`);
    }
    return;
  }
  deps.log(`[auth] the agent refreshed its login in ${container} — wrote it back to ${snapshot.hostPath}`);
}
