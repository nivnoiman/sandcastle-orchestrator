import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { messageOf } from "../messageOf.js";
import { isAgentRole, MODEL_NAME, PROVIDER_NAMES, type AgentChoice, type ProviderName } from "./agentsConfig.js";
import { parseProjectConfig, type ProjectConfig } from "./projectConfig.js";
import { BUILTIN_AGENT_STAGES, STAGE_PROMPT_PLACEHOLDERS, type StageSpec } from "./stagesConfig.js";

/** One chain row as the Board View shows it. `agent` is what the config says; unset = `agents.default`. */
export interface StageRow {
  name: string;
  kind: StageSpec["kind"];
  /** The provider/model can be set on this row (agent stages; verify and command stages run no agent). */
  hasAgent: boolean;
  agent: { provider: ProviderName; model: string | undefined } | undefined;
  /** Command stages: the shell command, or the repos it runs for. */
  run?: string | string[];
}

export interface StagesView {
  stages: StageRow[];
  defaultAgent: AgentChoice;
  providers: readonly ProviderName[];
  /** Models already named in this project's config, per provider, to pick from. */
  models: Record<ProviderName, string[]>;
  placeholders: readonly string[];
  /** Always "new runs": a saved edit never changes a run in flight. */
  appliesTo: "new runs";
}

/** Set (or clear, with `provider: null`) the agent of one stage. */
export interface AgentEdit {
  name: string;
  provider: ProviderName | null;
  model: string | null;
}

type Json = Record<string, unknown>;

function isBuiltinName(name: string): boolean {
  return (BUILTIN_AGENT_STAGES as readonly string[]).includes(name);
}

function rowOf(stage: StageSpec, project: ProjectConfig): StageRow {
  if (stage.kind === "builtin") {
    const choice = project.agents.roles[stage.name];
    return { name: stage.name, kind: stage.kind, hasAgent: true, agent: choice };
  }
  if (stage.kind === "agent") return { name: stage.name, kind: stage.kind, hasAgent: true, agent: stage.agent };
  if (stage.kind === "command") {
    return { name: stage.name, kind: stage.kind, hasAgent: false, agent: undefined, run: typeof stage.run === "string" ? stage.run : Object.keys(stage.run) };
  }
  return { name: stage.name, kind: stage.kind, hasAgent: false, agent: undefined };
}

function modelsInUse(project: ProjectConfig): Record<ProviderName, string[]> {
  const models = Object.fromEntries(PROVIDER_NAMES.map((name) => [name, new Set<string>()])) as Record<ProviderName, Set<string>>;
  const choices = [
    project.agents.default,
    ...Object.values(project.agents.roles),
    ...project.stages.flatMap((stage) => (stage.kind === "agent" && stage.agent ? [stage.agent] : [])),
  ];
  for (const choice of choices) if (choice?.model) models[choice.provider].add(choice.model);
  return Object.fromEntries(PROVIDER_NAMES.map((name) => [name, [...models[name]].sort()])) as Record<ProviderName, string[]>;
}

export function stagesViewOf(project: ProjectConfig): StagesView {
  return {
    stages: project.stages.map((stage) => rowOf(stage, project)),
    defaultAgent: project.agents.default,
    providers: PROVIDER_NAMES,
    models: modelsInUse(project),
    placeholders: STAGE_PROMPT_PLACEHOLDERS,
    appliesTo: "new runs",
  };
}

function choiceJson(provider: ProviderName, model: string | null): string | Json {
  return model === null ? provider : { provider, model };
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEdit(raw: unknown, index: number): AgentEdit {
  const where = `edits[${index}]`;
  if (!isObject(raw)) throw new Error(`${where} must be an object`);
  const { name, provider, model } = raw;
  if (typeof name !== "string") throw new Error(`${where}.name must be a stage name`);
  if (provider !== null && !(typeof provider === "string" && (PROVIDER_NAMES as readonly string[]).includes(provider))) {
    throw new Error(`${where}.provider must be null or one of ${PROVIDER_NAMES.join(", ")}`);
  }
  if (provider === null) return { name, provider: null, model: null };
  if (model !== null && model !== undefined && (typeof model !== "string" || !MODEL_NAME.test(model))) {
    throw new Error(`${where}.model must be a plain model name (letters, digits, . _ -) or null`);
  }
  return { name, provider: provider as ProviderName, model: typeof model === "string" ? model : null };
}

export function parseAgentEdits(raw: unknown): AgentEdit[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("edits must be a non-empty list");
  return raw.map(parseEdit);
}

/** The raw config with each edit applied: built-in stages go to `agents.<role>`, custom agent stages to their own entry. */
export function withAgentEdits(rawConfig: Json, edits: readonly AgentEdit[]): Json {
  const next: Json = structuredClone(rawConfig);
  const stages = Array.isArray(next["stages"]) ? (next["stages"] as unknown[]) : undefined;
  const agents: Json = isObject(next["agents"]) ? { ...next["agents"] } : {};
  for (const edit of edits) {
    if (isBuiltinName(edit.name) && isAgentRole(edit.name)) {
      if (edit.provider === null) delete agents[edit.name];
      else agents[edit.name] = choiceJson(edit.provider, edit.model);
      continue;
    }
    const entry = stages?.find((candidate) => isObject(candidate) && candidate["name"] === edit.name);
    if (!isObject(entry) || entry["kind"] !== "agent") {
      throw new Error(`"${edit.name}" has no agent to set — only develop, simplify, review and custom agent stages run one`);
    }
    delete entry["provider"];
    delete entry["model"];
    if (edit.provider !== null) {
      entry["provider"] = edit.provider;
      if (edit.model !== null) entry["model"] = edit.model;
    }
  }
  if (Object.keys(agents).length > 0) next["agents"] = agents;
  else delete next["agents"];
  return next;
}

function atomicWrite(path: string, text: string): void {
  const temp = join(dirname(path), `.${randomUUID()}.config.tmp`);
  try {
    writeFileSync(temp, text);
    renameSync(temp, path);
  } catch (cause) {
    try {
      unlinkSync(temp);
    } catch {
      // temp may not exist
    }
    throw new Error(`cannot write ${path} — ${messageOf(cause)}`, { cause });
  }
}

/**
 * Validates with the same parser `validate` and boot use, then replaces the file atomically.
 * Refuses when the file changed on disk between our read and the write.
 */
export function saveAgentEdits(configPath: string, edits: readonly AgentEdit[]): ProjectConfig {
  const original = readFileSync(configPath, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(original);
  } catch (cause) {
    throw new Error(`${configPath} is not valid JSON — ${messageOf(cause)}`, { cause });
  }
  if (!isObject(raw)) throw new Error(`${configPath} must hold a JSON object`);
  const next = withAgentEdits(raw, edits);
  const project = parseProjectConfig(next, configPath);
  if (readFileSync(configPath, "utf8") !== original) throw new Error("config.json changed on disk while saving — refresh and try again");
  atomicWrite(configPath, `${JSON.stringify(next, null, 2)}\n`);
  return project;
}
