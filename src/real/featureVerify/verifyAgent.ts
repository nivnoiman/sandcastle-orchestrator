import { describeAgent, resolveAgent, snapshotCredential, syncBackCredential } from "../agents/index.js";
import { ensureFreshLogin, type AuthProbeDeps } from "../authProbe.js";
import { runWithIdleTimeout } from "../commandRunner.js";
import { execRequest } from "../docker.js";
import type { AttemptLogStore } from "../attemptLog.js";
import { messageOf } from "../../messageOf.js";
import { FEATURE_VERIFY_STAGE } from "./stages.js";

/** Runs the Feature Verify agent in an already-started container (mounted with the `feature-verify` provider's home). */
export async function runVerifyAgent(
  deps: AuthProbeDeps & { log: (message: string) => void; logs?: AttemptLogStore | undefined; parentNumber: number },
  container: string,
  prompt: string,
  exec: (command: string, label: string) => Promise<unknown>,
): Promise<void> {
  const writer = deps.logs?.begin(deps.parentNumber, FEATURE_VERIFY_STAGE);
  const agent = resolveAgent(deps.config, "feature-verify");
  let outcome = "failure";
  try {
    await ensureFreshLogin(deps, agent);
    const login = snapshotCredential(deps.fs, deps.layout, agent.provider);
    await exec(agent.provider.hydrateCommand(), "agent home hydration");
    const idle = deps.config.idleTimeoutSeconds;
    deps.log(`[feature-verify] agent starting (idle budget ${idle}s, model ${describeAgent(agent)})`);
    try {
      await runWithIdleTimeout(
        deps.runner,
        execRequest(container, agent.provider.command(agent.model), { input: prompt, onOutput: (chunk) => writer?.write(chunk) }),
        idle,
      );
      outcome = "success";
    } finally {
      syncBackCredential(deps, container, login);
    }
  } catch (cause) {
    writer?.write(`\n[feature-verify] failed: ${messageOf(cause)}\n`);
    throw cause;
  } finally {
    writer?.finish(outcome);
  }
}
