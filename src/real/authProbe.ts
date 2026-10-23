import { agentWaitFrom, type WaitReason } from "./agentFailure.js";
import { runWithIdleTimeout, type CommandRunner } from "./commandRunner.js";
import { execRequest, removeContainer, stageContainerName, startContainer, SANDBOX_WORKDIR } from "./docker.js";
import { agentAuthEnv, type OrchestratorConfig } from "./env.js";
import type { FileSystemPort } from "./fileSystem.js";
import type { SandcastleLayout } from "./paths.js";
import { claudeCommand, claudeHomeMounts, hydrateHomeCommand, withContainerEnvFile } from "./sandboxRunner.js";
import { messageOf } from "../messageOf.js";

export const PROBE_ITEM_NUMBER = 0;
export const PROBE_TIMEOUT_SECONDS = 180;
export const PROBE_PROMPT = "Reply with the single word ok. Do not use any tools.";

export interface AuthProbeResult {
  ok: boolean;
  reason: WaitReason | "other" | undefined;
  detail: string | undefined;
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

function probeContainerName(deps: AuthProbeDeps): string {
  const stamp = (deps.now ?? Date.now)().toString(36);
  return stageContainerName("probe", PROBE_ITEM_NUMBER, stamp);
}

export async function probeAgentAuth(deps: AuthProbeDeps): Promise<AuthProbeResult> {
  const container = probeContainerName(deps);
  const timeout = deps.timeoutSeconds ?? PROBE_TIMEOUT_SECONDS;
  withContainerEnvFile(deps.fs, agentAuthEnv(deps.config), (envFile) => {
    startContainer(deps.runner, {
      name: container,
      image: deps.config.imageTag,
      workdir: SANDBOX_WORKDIR,
      mounts: claudeHomeMounts(deps.layout),
      envFile,
    });
  });
  try {
    await runWithIdleTimeout(deps.runner, execRequest(container, hydrateHomeCommand()), timeout);
    await runWithIdleTimeout(
      deps.runner,
      execRequest(container, claudeCommand(deps.config.model), { input: PROBE_PROMPT }),
      timeout,
    );
    return { ok: true, reason: undefined, detail: undefined };
  } catch (cause) {
    const waiting = agentWaitFrom(cause);
    if (waiting) return { ok: false, reason: waiting.reason, detail: waiting.detail };
    return { ok: false, reason: "other", detail: messageOf(cause) };
  } finally {
    removeProbeContainer(deps, container);
  }
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
