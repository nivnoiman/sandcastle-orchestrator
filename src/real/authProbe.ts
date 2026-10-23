import { agentWaitFrom, type WaitReason } from "./agentFailure.js";
import { agentsInUse, snapshotCredential, syncBackCredential, type AgentProvider, type ResolvedAgent } from "./agents/index.js";
import { runWithIdleTimeout, type CommandRunner } from "./commandRunner.js";
import { execRequest, removeContainer, stageContainerName, startContainer, SANDBOX_WORKDIR, withContainerEnvFile } from "./docker.js";
import type { OrchestratorConfig } from "./env.js";
import type { FileSystemPort } from "./fileSystem.js";
import type { SandcastleLayout } from "./paths.js";
import type { ProviderName } from "../project/agentsConfig.js";
import { messageOf } from "../messageOf.js";

export const PROBE_ITEM_NUMBER = 0;
export const PROBE_TIMEOUT_SECONDS = 180;
export const PROBE_PROMPT = "Reply with the single word ok. Do not use any tools.";

export interface AuthProbeResult {
  ok: boolean;
  reason: WaitReason | "other" | undefined;
  detail: string | undefined;
  provider?: ProviderName;
}

export interface AuthProbeDeps {
  runner: CommandRunner;
  fs: FileSystemPort;
  layout: SandcastleLayout;
  config: OrchestratorConfig;
  timeoutSeconds?: number;
  log?: (message: string) => void;
  now?: () => number;
}

function probeContainerName(deps: AuthProbeDeps, provider: AgentProvider): string {
  const stamp = (deps.now ?? Date.now)().toString(36);
  const stage = provider.name === "claude" ? "probe" : `probe${provider.name}`;
  return stageContainerName(stage, PROBE_ITEM_NUMBER, stamp);
}

/** Probes every provider the config uses, in turn; the first rejection wins. */
export async function probeAgentAuth(deps: AuthProbeDeps): Promise<AuthProbeResult> {
  for (const agent of agentsInUse(deps.config)) {
    const result = await probeAgent(deps, agent);
    if (!result.ok) return result;
  }
  return { ok: true, reason: undefined, detail: undefined };
}

export async function probeAgent(deps: AuthProbeDeps, agent: ResolvedAgent): Promise<AuthProbeResult> {
  const { provider } = agent;
  const container = probeContainerName(deps, provider);
  const timeout = deps.timeoutSeconds ?? PROBE_TIMEOUT_SECONDS;
  const login = snapshotCredential(deps.fs, deps.layout, provider);
  withContainerEnvFile(deps.fs, provider.authEnv(deps.config), (envFile) => {
    startContainer(deps.runner, {
      name: container,
      image: deps.config.imageTag,
      workdir: SANDBOX_WORKDIR,
      mounts: provider.homeMounts(deps.layout),
      envFile,
    });
  });
  try {
    await runWithIdleTimeout(deps.runner, execRequest(container, provider.hydrateCommand()), timeout);
    await runWithIdleTimeout(deps.runner, execRequest(container, provider.command(agent.model), { input: PROBE_PROMPT }), timeout);
    return { ok: true, reason: undefined, detail: undefined, provider: provider.name };
  } catch (cause) {
    const waiting = agentWaitFrom(cause, provider.classify);
    if (waiting) return { ok: false, reason: waiting.reason, detail: waiting.detail, provider: provider.name };
    return { ok: false, reason: "other", detail: messageOf(cause), provider: provider.name };
  } finally {
    syncBackCredential({ runner: deps.runner, fs: deps.fs, log: deps.log ?? (() => undefined) }, container, login);
    removeProbeContainer(deps, container);
  }
}

const refreshes = new Map<string, Promise<void>>();
const lastGated = new Map<string, number>();
/** Between gate probes of one login — without it, a login the probe did not refresh is re-probed before every stage. */
export const REFRESH_GATE_RETRY_MS = 60 * 60 * 1000;

/**
 * Refresh gate: a login the CLI is about to refresh is refreshed once, by a probe, before the stage starts —
 * parallel containers then never race to rotate the same refresh token. Concurrent callers share the one probe.
 * Returns undefined when nothing needs refreshing, so callers stay synchronous up to the container start.
 */
export function ensureFreshLogin(deps: AuthProbeDeps, agent: ResolvedAgent): Promise<void> | undefined {
  const credential = agent.provider.credential;
  if (!credential || credential.overriddenBy(deps.config)) return undefined;
  const hostPath = credential.hostPath(deps.layout);
  const inFlight = refreshes.get(hostPath);
  if (inFlight) return inFlight;
  const now = (deps.now ?? Date.now)();
  const gatedAt = lastGated.get(hostPath);
  if (gatedAt !== undefined && now - gatedAt < REFRESH_GATE_RETRY_MS) return undefined;
  const content = deps.fs.readText(hostPath);
  if (content === undefined || !credential.isStale(content, now)) return undefined;
  lastGated.set(hostPath, now);
  deps.log?.(`[auth] ${hostPath} is due for a token refresh — refreshing it once before the stage starts`);
  const refresh = probeAgent(deps, agent)
    .then((result) => {
      if (!result.ok) deps.log?.(`[auth][warn] refreshing ${hostPath} failed (${result.reason ?? "unknown"}) — the stage will report it`);
    })
    .finally(() => refreshes.delete(hostPath));
  refreshes.set(hostPath, refresh);
  return refresh;
}

function removeProbeContainer(deps: AuthProbeDeps, container: string): void {
  try {
    removeContainer(deps.runner, container);
  } catch (cause) {
    deps.log?.(
      `[auth] the probe container ${container} could not be removed (${messageOf(cause)}) —` +
        " the next gc collects it",
    );
  }
}
