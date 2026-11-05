import type { StageSpec } from "./stagesConfig.js";

/** Ordered shell commands per stage name, for one repo: `repos.<name>.stageChecks`. */
export type StageChecks = Record<string, string[]>;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `repos.<name>.stageChecks`: a map of stage name to a non-empty ordered list of non-blank commands. Absent = no per-stage checks. */
export function parseStageChecks(raw: unknown, where: string): StageChecks {
  if (raw === undefined) return {};
  if (!isObject(raw)) throw new Error(`${where} must map stage names to lists of commands`);
  const checks: StageChecks = {};
  for (const [stage, list] of Object.entries(raw)) {
    const at = `${where}.${stage}`;
    if (!Array.isArray(list) || list.length === 0) throw new Error(`${at} must be a non-empty list of commands - drop the key to run none`);
    list.forEach((command, index) => {
      if (typeof command !== "string" || command.trim().length === 0) throw new Error(`${at}[${index}] must be a non-empty command`);
    });
    checks[stage] = list as string[];
  }
  return checks;
}

/** Throws when a list names a stage that is not in the chain, or one that runs its own command instead of an agent. */
export function assertStageChecksTargets(repos: Readonly<Record<string, { stageChecks: StageChecks }>>, stages: readonly StageSpec[]): void {
  for (const [repo, config] of Object.entries(repos)) {
    for (const stage of Object.keys(config.stageChecks)) {
      const found = stages.find((candidate) => candidate.name === stage);
      const where = `repos.${repo}.stageChecks.${stage}`;
      if (!found) throw new Error(`${where} names a stage that is not in stages (have: ${stages.map((entry) => entry.name).join(", ")})`);
      if (found.kind === "command") throw new Error(`${where}: "${stage}" is a command stage - it already runs its own "run" command`);
    }
  }
}

/** The commands a gate runs after `stage`, or undefined when none are configured. `verify` falls back to the repo default `checks`. */
export function commandsForStage(stageChecks: StageChecks | undefined, stage: string, defaultChecks: string | undefined): string[] | undefined {
  const own = stageChecks?.[stage];
  if (own) return own;
  if (stage === "verify" && defaultChecks !== undefined) return [defaultChecks];
  return undefined;
}

/** One command per line in the editor, blank lines dropped. */
export function commandsOfText(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
}
