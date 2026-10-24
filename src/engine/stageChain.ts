import { stageChain } from "../project/projectConfig.js";
import type { StageSpec } from "../project/stagesConfig.js";
import { RUNNING_STAGE_LABELS, STAGE_LABELS, VERIFY_STAGE_LABEL, type StageLabel, type StageName } from "./adapters.js";

export type { StageSpec };

/** The active project's chain: built-ins plus any custom stages from config.json. */
export function activeStageChain(): readonly StageSpec[] {
  return stageChain();
}

export function runningStageLabel(stage: StageSpec): StageLabel {
  if (stage.kind === "builtin") return RUNNING_STAGE_LABELS[stage.name];
  if (stage.kind === "verify") return VERIFY_STAGE_LABEL;
  return `sc:${stage.name}`;
}

export function isCustomStage(stage: StageSpec): boolean {
  return stage.kind === "agent" || stage.kind === "command";
}

/** Every label the orchestrator owns for this chain: the fixed ones plus `sc:<name>` per custom stage. */
export function stageLabels(chain: readonly StageSpec[]): StageLabel[] {
  return [...STAGE_LABELS, ...chain.filter(isCustomStage).map(runningStageLabel)];
}

export function customStageLabels(chain: readonly StageSpec[]): StageLabel[] {
  return chain.filter(isCustomStage).map(runningStageLabel);
}

/** The chain index whose running label is `label`, or -1. */
export function stageIndexForLabel(chain: readonly StageSpec[], label: StageLabel): number {
  return chain.findIndex((stage) => runningStageLabel(stage) === label);
}

export function stageNames(chain: readonly StageSpec[]): StageName[] {
  return chain.map((stage) => stage.name);
}

/** The command a command stage runs for `repo`, or undefined when the stage skips that repo. */
export function commandFor(stage: Extract<StageSpec, { kind: "command" }>, repo: string): string | undefined {
  return typeof stage.run === "string" ? stage.run : stage.run[repo];
}
