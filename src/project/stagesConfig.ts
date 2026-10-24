import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseChoice, type AgentChoice } from "./agentsConfig.js";

export const BUILTIN_AGENT_STAGES = ["develop", "simplify", "review"] as const;
export type BuiltinAgentStage = (typeof BUILTIN_AGENT_STAGES)[number];
export const VERIFY_STAGE = "verify";

export type StageSpec =
  | { kind: "builtin"; name: BuiltinAgentStage }
  | { kind: "verify"; name: typeof VERIFY_STAGE }
  | { kind: "agent"; name: string; promptPath: string; agent: AgentChoice | undefined }
  | { kind: "command"; name: string; run: string | Readonly<Record<string, string>> };

export type CustomAgentStage = Extract<StageSpec, { kind: "agent" }>;
export type CommandStage = Extract<StageSpec, { kind: "command" }>;

export const DEFAULT_STAGES: readonly StageSpec[] = [
  { kind: "builtin", name: "develop" },
  { kind: "builtin", name: "simplify" },
  { kind: "builtin", name: "review" },
  { kind: "verify", name: VERIFY_STAGE },
];

const STAGE_NAME = /^[a-z][a-z0-9-]*$/;
const STAGE_NAME_MAX = 30;
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  ...BUILTIN_AGENT_STAGES,
  VERIFY_STAGE,
  "resolve",
  "salvage",
  "rework",
  "queued",
  "blocked",
  "done",
  "needs-human",
  "merged",
  "feature-verify",
  "feature-fix",
  "polish",
  "developing",
  "simplifying",
  "in-review",
  "verifying",
]);

/** `{{name}}` in a custom agent stage's prompt file. */
export const STAGE_PROMPT_PLACEHOLDER = /\{\{\s*([A-Za-z]+)\s*\}\}/g;
export const STAGE_PROMPT_PLACEHOLDERS = [
  "issue",
  "issueNumber",
  "title",
  "repo",
  "branch",
  "integrationBranch",
  "feature",
  "stage",
  "round",
] as const;
export type StagePromptPlaceholder = (typeof STAGE_PROMPT_PLACEHOLDERS)[number];

export function isStagePromptPlaceholder(value: string): value is StagePromptPlaceholder {
  return (STAGE_PROMPT_PLACEHOLDERS as readonly string[]).includes(value);
}

/** Throws on the first `{{name}}` that is not a known placeholder. */
export function assertStagePromptPlaceholders(text: string, where: string): void {
  for (const [match, name] of text.matchAll(STAGE_PROMPT_PLACEHOLDER)) {
    if (name !== undefined && isStagePromptPlaceholder(name)) continue;
    throw new Error(`${where} has unknown placeholder ${match} — use ${STAGE_PROMPT_PLACEHOLDERS.map((key) => `{{${key}}}`).join(", ")}`);
  }
}

export interface StagesContext {
  projectRoot: string;
  repos: readonly string[];
  readText?: (path: string) => string;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBuiltinAgentStage(value: string): value is BuiltinAgentStage {
  return (BUILTIN_AGENT_STAGES as readonly string[]).includes(value);
}

function assertKeys(entry: Json, allowed: readonly string[], where: string): void {
  const unknownKey = Object.keys(entry).find((key) => !allowed.includes(key));
  if (unknownKey) throw new Error(`${where}.${unknownKey} is not a setting — use ${allowed.map((key) => `"${key}"`).join(", ")}`);
}

function nonEmptyString(entry: Json, key: string, where: string): string {
  const value = entry[key];
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${where}.${key} must be a non-empty string`);
  return value;
}

function customName(entry: Json, where: string): string {
  const name = entry["name"];
  if (typeof name !== "string" || !STAGE_NAME.test(name)) {
    throw new Error(`${where}.name must be lower-case kebab (it becomes the sc:<name> label), got ${JSON.stringify(name)}`);
  }
  if (name.length > STAGE_NAME_MAX) throw new Error(`${where}.name "${name}" is longer than ${STAGE_NAME_MAX} characters`);
  if (RESERVED_NAMES.has(name)) throw new Error(`${where}.name "${name}" is reserved — pick another name, or use the string "${name}" for a built-in stage`);
  return name;
}

function readPrompt(path: string, where: string, context: StagesContext): void {
  let text: string;
  try {
    text = (context.readText ?? ((file) => readFileSync(file, "utf8")))(path);
  } catch {
    throw new Error(`${where}.prompt: cannot read ${path}`);
  }
  assertStagePromptPlaceholders(text, `${where}.prompt (${path})`);
}

function parseAgentStage(entry: Json, name: string, where: string, context: StagesContext): StageSpec {
  assertKeys(entry, ["name", "kind", "prompt", "provider", "model"], where);
  const promptPath = resolve(context.projectRoot, nonEmptyString(entry, "prompt", where));
  readPrompt(promptPath, where, context);
  if (entry["provider"] === undefined && entry["model"] !== undefined) {
    throw new Error(`${where}.model needs a "provider" next to it`);
  }
  const agent =
    entry["provider"] === undefined
      ? undefined
      : parseChoice(
          entry["model"] === undefined ? { provider: entry["provider"] } : { provider: entry["provider"], model: entry["model"] },
          where,
        );
  return { kind: "agent", name, promptPath, agent };
}

function parseRun(raw: unknown, where: string, context: StagesContext): string | Record<string, string> {
  if (typeof raw === "string") {
    if (raw.trim().length === 0) throw new Error(`${where}.run must not be empty`);
    return raw;
  }
  if (!isObject(raw) || Object.keys(raw).length === 0) {
    throw new Error(`${where}.run must be a command or a map of repo names to commands`);
  }
  const commands: Record<string, string> = {};
  for (const [repo, command] of Object.entries(raw)) {
    if (!context.repos.includes(repo)) throw new Error(`${where}.run.${repo} names a repo that is not under repos`);
    if (typeof command !== "string" || command.trim().length === 0) throw new Error(`${where}.run.${repo} must be a non-empty command`);
    commands[repo] = command;
  }
  return commands;
}

function parseCommandStage(entry: Json, name: string, where: string, context: StagesContext): StageSpec {
  assertKeys(entry, ["name", "kind", "run"], where);
  return { kind: "command", name, run: parseRun(entry["run"], where, context) };
}

function parseEntry(raw: unknown, where: string, context: StagesContext): StageSpec {
  if (typeof raw === "string") {
    if (raw === VERIFY_STAGE) return { kind: "verify", name: VERIFY_STAGE };
    if (isBuiltinAgentStage(raw)) return { kind: "builtin", name: raw };
    throw new Error(`${where} "${raw}" is not a built-in stage — use ${[...BUILTIN_AGENT_STAGES, VERIFY_STAGE].join(", ")} or a { "name", "kind", ... } entry`);
  }
  if (!isObject(raw)) throw new Error(`${where} must be a built-in stage name or a { "name", "kind", ... } entry`);
  const name = customName(raw, where);
  const kind = raw["kind"];
  if (kind === "agent") return parseAgentStage(raw, name, where, context);
  if (kind === "command") return parseCommandStage(raw, name, where, context);
  throw new Error(`${where}.kind must be "agent" or "command", got ${JSON.stringify(kind)}`);
}

/** `stages` in config.json: an ordered list of built-in names and custom `agent` / `command` entries. */
export function parseStages(raw: unknown, context: StagesContext): readonly StageSpec[] {
  if (raw === undefined) return DEFAULT_STAGES;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("stages must be a non-empty list");
  const stages = raw.map((entry, index) => parseEntry(entry, `stages[${index}]`, context));
  const seen = new Set<string>();
  for (const stage of stages) {
    if (seen.has(stage.name)) throw new Error(`stages names "${stage.name}" more than once`);
    seen.add(stage.name);
  }
  if (stages[0]?.name !== "develop") throw new Error('stages must start with "develop"');
  const verifyIndex = stages.findIndex((stage) => stage.kind === "verify");
  if (verifyIndex === -1) return [...stages, { kind: "verify", name: VERIFY_STAGE }];
  if (verifyIndex !== stages.length - 1) throw new Error('"verify" must be the last stage');
  return stages;
}

export function customStageNames(stages: readonly StageSpec[]): string[] {
  return stages.filter((stage) => stage.kind === "agent" || stage.kind === "command").map((stage) => stage.name);
}
