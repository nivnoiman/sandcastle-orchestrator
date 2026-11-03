import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import type { ProjectConfig } from "../project/projectConfig.js";
import { BUILTIN_AGENT_STAGES, type BuiltinAgentStage } from "../project/stagesConfig.js";
import { buildStagePrompt } from "../real/promptBuilder.js";

/** The prompt of one stage as the Board View shows it, read-only. */
export interface StagePromptView {
  name: string;
  source: "built-in" | "file";
  text: string;
  /** Project-relative; custom stages only. */
  path?: string;
  note: string;
}

export class StagePromptError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404,
  ) {
    super(message);
  }
}

const BUILTIN_NOTE =
  "Built-in prompt template the engine builds for this stage. Read-only. A real run fills in the item's issue, branch, required reading and project memory; those show as example values here. Rework and salvage runs add a section to it.";

function isBuiltin(name: string): name is BuiltinAgentStage {
  return (BUILTIN_AGENT_STAGES as readonly string[]).includes(name);
}

function builtinPrompt(project: ProjectConfig, name: BuiltinAgentStage): string {
  return buildStagePrompt({
    stage: name,
    item: { number: 1, title: "<sub-issue title>", repo: Object.keys(project.repos)[0] ?? "<repo>", dependsOn: [], admission: "queued", extraMemories: [], body: "<sub-issue body>" },
    branch: "<branch>",
    integrationBranch: "<integration-branch>",
    requiredReading: [],
    memories: [],
    hubRepo: project.hubRepo,
    parentNumber: 0,
    feature: "<feature>",
    tracker: project.tracker,
  });
}

function insideRoot(path: string, root: string): boolean {
  const inside = relative(root, path);
  return inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside) && inside !== "";
}

function customPrompt(project: ProjectConfig, name: string, promptPath: string): StagePromptView {
  let real: string;
  let root: string;
  try {
    root = realpathSync(project.projectRoot);
    real = realpathSync(promptPath);
  } catch {
    throw new StagePromptError(`the prompt file of "${name}" does not exist`, 404);
  }
  if (!insideRoot(real, root)) throw new StagePromptError(`the prompt file of "${name}" is outside the project — refusing to show it`, 400);
  let text: string;
  try {
    text = readFileSync(real, "utf8");
  } catch {
    throw new StagePromptError(`the prompt file of "${name}" could not be read`, 404);
  }
  return {
    name,
    source: "file",
    text,
    path: relative(root, real).replaceAll("\\", "/"),
    note: "The prompt file of this custom stage, as it is on disk now; {{placeholders}} are filled per item. Sandcastle wraps it in the usual run context.",
  };
}

/** Looks the stage up in the project's own chain, so no caller-supplied path is ever opened. */
export function stagePromptOf(project: ProjectConfig, name: string): StagePromptView {
  const stage = project.stages.find((candidate) => candidate.name === name);
  if (!stage) throw new StagePromptError(`no stage named "${name}"`, 404);
  if (stage.kind === "builtin" && isBuiltin(stage.name)) return { name, source: "built-in", text: builtinPrompt(project, stage.name), note: BUILTIN_NOTE };
  if (stage.kind === "agent") return customPrompt(project, name, stage.promptPath);
  throw new StagePromptError(`"${name}" runs no agent prompt`, 400);
}
