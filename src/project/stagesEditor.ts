import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { messageOf } from "../messageOf.js";
import { MODEL_NAME, PROVIDER_NAMES, type AgentChoice, type ProviderName } from "./agentsConfig.js";
import { parseProjectConfig, projectRootOf, type ProjectConfig } from "./projectConfig.js";
import { BUILTIN_AGENT_STAGES, STAGE_PROMPT_PLACEHOLDERS, VERIFY_STAGE, type BuiltinAgentStage, type StageSpec } from "./stagesConfig.js";

export const PROMPTS_DIR = ".sandcastle/prompts";
export const PROMPT_MAX_CHARS = 65536;

const SUGGESTED_MODELS: Record<ProviderName, readonly string[]> = {
  claude: ["opus", "sonnet", "haiku"],
  codex: ["gpt-5.5", "gpt-5.5-codex"],
  cursor: [],
};

/** One chain row as the Board View shows it. `agent` is what the config says; unset = `agents.default`. */
export interface StageRow {
  name: string;
  kind: StageSpec["kind"];
  hasAgent: boolean;
  agent: { provider: ProviderName; model: string | undefined } | undefined;
  run?: string | Record<string, string>;
  promptText?: string;
  promptPath?: string;
}

export interface StagesView {
  stages: StageRow[];
  defaultAgent: AgentChoice;
  providers: readonly ProviderName[];
  models: Record<ProviderName, string[]>;
  commands: ExistingCommand[];
  placeholders: readonly string[];
  missingBuiltins: BuiltinAgentStage[];
  promptsDir: string;
  appliesTo: "new runs";
}

export interface ExistingCommand {
  source: string;
  command: string;
}

interface AgentFields {
  provider: ProviderName | null;
  model: string | null;
}

export type StageEdit =
  | ({ kind: "builtin"; name: BuiltinAgentStage } & AgentFields)
  | { kind: "verify"; name: typeof VERIFY_STAGE }
  | ({ kind: "agent"; name: string; prompt: string } & AgentFields)
  | { kind: "command"; name: string; run: string | Record<string, string> };

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPromptText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function rowOf(stage: StageSpec, project: ProjectConfig): StageRow {
  if (stage.kind === "builtin") return { name: stage.name, kind: stage.kind, hasAgent: true, agent: project.agents.roles[stage.name] };
  if (stage.kind === "agent") {
    return {
      name: stage.name,
      kind: stage.kind,
      hasAgent: true,
      agent: stage.agent,
      promptText: readPromptText(stage.promptPath) ?? "",
      promptPath: relative(project.projectRoot, stage.promptPath).replaceAll("\\", "/"),
    };
  }
  if (stage.kind === "command") return { name: stage.name, kind: stage.kind, hasAgent: false, agent: undefined, run: stage.run };
  return { name: stage.name, kind: stage.kind, hasAgent: false, agent: undefined };
}

function modelsInUse(project: ProjectConfig): Record<ProviderName, string[]> {
  const models = Object.fromEntries(PROVIDER_NAMES.map((name) => [name, new Set<string>(SUGGESTED_MODELS[name])])) as Record<ProviderName, Set<string>>;
  const choices = [
    project.agents.default,
    ...Object.values(project.agents.roles),
    ...project.stages.flatMap((stage) => (stage.kind === "agent" && stage.agent ? [stage.agent] : [])),
  ];
  for (const choice of choices) if (choice?.model) models[choice.provider].add(choice.model);
  return Object.fromEntries(PROVIDER_NAMES.map((name) => [name, [...models[name]].sort()])) as Record<ProviderName, string[]>;
}

function existingCommands(project: ProjectConfig): ExistingCommand[] {
  const found: ExistingCommand[] = [];
  for (const [repo, config] of Object.entries(project.repos)) {
    found.push({ source: `${repo} checks`, command: config.checks });
    if (config.bootstrap.trim() !== "") found.push({ source: `${repo} bootstrap`, command: config.bootstrap });
  }
  if (project.verify.strategy === "command") {
    for (const [repo, command] of Object.entries(project.verify.commands)) found.push({ source: `verify ${repo}`, command });
  }
  for (const stage of project.stages) {
    if (stage.kind !== "command") continue;
    if (typeof stage.run === "string") found.push({ source: `stage ${stage.name}`, command: stage.run });
    else for (const [repo, command] of Object.entries(stage.run)) found.push({ source: `stage ${stage.name} (${repo})`, command });
  }
  const seen = new Set<string>();
  return found.filter((entry) => !seen.has(entry.command) && seen.add(entry.command));
}

export function stagesViewOf(project: ProjectConfig): StagesView {
  const present = new Set(project.stages.map((stage) => stage.name));
  return {
    stages: project.stages.map((stage) => rowOf(stage, project)),
    defaultAgent: project.agents.default,
    providers: PROVIDER_NAMES,
    models: modelsInUse(project),
    commands: existingCommands(project),
    placeholders: STAGE_PROMPT_PLACEHOLDERS,
    missingBuiltins: BUILTIN_AGENT_STAGES.filter((name) => !present.has(name)),
    promptsDir: PROMPTS_DIR,
    appliesTo: "new runs",
  };
}

function agentFields(raw: Json, where: string): AgentFields {
  const { provider, model } = raw;
  if (provider === null || provider === undefined) return { provider: null, model: null };
  if (typeof provider !== "string" || !(PROVIDER_NAMES as readonly string[]).includes(provider)) {
    throw new Error(`${where}.provider must be null or one of ${PROVIDER_NAMES.join(", ")}`);
  }
  if (model !== null && model !== undefined && (typeof model !== "string" || !MODEL_NAME.test(model))) {
    throw new Error(`${where}.model must be a plain model name (letters, digits, . _ -) or null`);
  }
  return { provider: provider as ProviderName, model: typeof model === "string" ? model : null };
}

function parseEdit(raw: unknown, index: number): StageEdit {
  const where = `stages[${index}]`;
  if (!isObject(raw)) throw new Error(`${where} must be an object`);
  const { kind, name } = raw;
  if (typeof name !== "string") throw new Error(`${where}.name must be a stage name`);
  if (kind === "verify") return { kind, name: VERIFY_STAGE };
  if (kind === "builtin") {
    if (!(BUILTIN_AGENT_STAGES as readonly string[]).includes(name)) throw new Error(`${where}.name "${name}" is not a built-in stage`);
    return { kind, name: name as BuiltinAgentStage, ...agentFields(raw, where) };
  }
  if (kind === "agent") {
    const prompt = raw["prompt"];
    if (typeof prompt !== "string" || prompt.trim().length === 0) throw new Error(`${where} (${name}): the prompt must not be empty`);
    if (prompt.length > PROMPT_MAX_CHARS) throw new Error(`${where} (${name}): the prompt is longer than ${PROMPT_MAX_CHARS} characters`);
    return { kind, name, prompt, ...agentFields(raw, where) };
  }
  if (kind === "command") {
    const run = raw["run"];
    if (typeof run !== "string" && !isObject(run)) throw new Error(`${where} (${name}): run must be a command or a map of repo names to commands`);
    return { kind, name, run: run as string | Record<string, string> };
  }
  throw new Error(`${where}.kind must be "builtin", "verify", "agent" or "command"`);
}

/** The whole ordered chain as the editor sends it; the list replaces `stages`. */
export function parseStageEdits(raw: unknown): StageEdit[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("stages must be a non-empty list");
  return raw.map(parseEdit);
}

function choiceJson(provider: ProviderName, model: string | null): string | Json {
  return model === null ? provider : { provider, model };
}

interface PromptWrite {
  path: string;
  text: string;
  newlyConfigured: boolean;
}

function promptPathKeepingExisting(name: string, rawStages: unknown): { prompt: string; newlyConfigured: boolean } {
  const existing = Array.isArray(rawStages) ? rawStages.find((entry) => isObject(entry) && entry["name"] === name) : undefined;
  const current = isObject(existing) ? existing["prompt"] : undefined;
  if (typeof current === "string" && current.trim().length > 0) return { prompt: current, newlyConfigured: false };
  return { prompt: `${PROMPTS_DIR}/${name}.md`, newlyConfigured: true };
}

/** The raw config for the edited chain, plus the prompt files it needs written. Built-in agents go to `agents.<role>`. */
export function withStageEdits(rawConfig: Json, edits: readonly StageEdit[], projectRoot: string): { config: Json; prompts: PromptWrite[] } {
  const next: Json = structuredClone(rawConfig);
  const agents: Json = isObject(next["agents"]) ? { ...next["agents"] } : {};
  const prompts: PromptWrite[] = [];
  const stages = edits.map((edit): unknown => {
    if (edit.kind === "verify") return VERIFY_STAGE;
    if (edit.kind === "builtin") {
      if (edit.provider === null) delete agents[edit.name];
      else agents[edit.name] = choiceJson(edit.provider, edit.model);
      return edit.name;
    }
    if (edit.kind === "command") return { name: edit.name, kind: "command", run: edit.run };
    const { prompt, newlyConfigured } = promptPathKeepingExisting(edit.name, rawConfig["stages"]);
    prompts.push({ path: resolve(projectRoot, prompt), text: edit.prompt, newlyConfigured });
    return {
      name: edit.name,
      kind: "agent",
      prompt,
      ...(edit.provider === null ? {} : { provider: edit.provider, ...(edit.model === null ? {} : { model: edit.model }) }),
    };
  });
  next["stages"] = stages;
  if (Object.keys(agents).length > 0) next["agents"] = agents;
  else delete next["agents"];
  return { config: next, prompts };
}

function atomicWrite(path: string, text: string): void {
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temp, text);
    renameSync(temp, path);
  } catch (cause) {
    rmSync(temp, { force: true });
    throw new Error(`cannot write ${path} — ${messageOf(cause)}`, { cause });
  }
}

function assertInsideProject(path: string, projectRoot: string): void {
  const inside = relative(projectRoot, path);
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error(`prompt file ${path} is outside the project — edit it by hand, or rename the stage so it gets its own file under ${PROMPTS_DIR}`);
  }
}

/**
 * Validates the edited chain with the parser boot and `validate` use (prompt text read from the pending edit, not the disk),
 * then writes the changed prompt files and replaces `config.json`, each atomically.
 * Refuses when the file changed on disk between our read and the write.
 */
export function saveStageEdits(configPath: string, edits: readonly StageEdit[]): ProjectConfig {
  const original = readFileSync(configPath, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(original);
  } catch (cause) {
    throw new Error(`${configPath} is not valid JSON — ${messageOf(cause)}`, { cause });
  }
  if (!isObject(raw)) throw new Error(`${configPath} must hold a JSON object`);
  const projectRoot = projectRootOf(configPath);
  const { config, prompts } = withStageEdits(raw, edits, projectRoot);
  const pending = new Map<string, string>();
  for (const prompt of prompts) {
    if (pending.has(prompt.path)) throw new Error(`two stages share the prompt file ${prompt.path} — give each its own file in config.json`);
    pending.set(prompt.path, prompt.text);
  }
  const project = parseProjectConfig(config, configPath, (path) => pending.get(path) ?? readFileSync(path, "utf8"));
  const changed = prompts.filter((prompt) => readPromptText(prompt.path) !== prompt.text);
  for (const prompt of changed) {
    assertInsideProject(prompt.path, projectRoot);
    if (prompt.newlyConfigured && existsSync(prompt.path)) {
      throw new Error(`${prompt.path} already exists and no stage uses it — pick another stage name, or point a stage at it in config.json`);
    }
  }
  if (readFileSync(configPath, "utf8") !== original) throw new Error("config.json changed on disk while saving — refresh and try again");
  for (const prompt of changed) atomicWrite(prompt.path, prompt.text);
  atomicWrite(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return project;
}
