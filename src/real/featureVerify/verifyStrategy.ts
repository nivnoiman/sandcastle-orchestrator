import { CommandVerifyHarness, NoVerifyHarness, type CommandHarnessDeps } from "./commandHarness.js";
import { DockerComposeHarness, type ComposeHarnessDeps, type VerifyHarness } from "./composeHarness.js";

/** Picks the Feature Verify harness the project's verify.strategy names. */
export function createVerifyHarness(deps: ComposeHarnessDeps & Pick<CommandHarnessDeps, "recheckLedger">): VerifyHarness {
  const strategy = deps.config.verify.strategy;
  if (strategy === "compose") return new DockerComposeHarness(deps);
  if (strategy === "command") return new CommandVerifyHarness(deps);
  return new NoVerifyHarness(deps);
}
