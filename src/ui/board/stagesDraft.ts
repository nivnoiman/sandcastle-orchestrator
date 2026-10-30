import type { ProviderName } from "../../project/agentsConfig.js";
import type { BuiltinAgentStage } from "../../project/stagesConfig.js";
import type { StageEdit, StageRow, StagesView } from "../../project/stagesEditor.js";

/** One editable row; `provider` "" means "use the project default". */
export interface DraftRow {
  key: string;
  kind: StageRow["kind"];
  name: string;
  isNew: boolean;
  provider: string;
  model: string;
  /** The model picker is on "Custom…" and shows a text box. */
  customModel: boolean;
  prompt: string;
  promptPath: string | undefined;
  run: string;
  runMap: Record<string, string> | undefined;
}

export interface StagesDraft {
  rows: DraftRow[];
  nextKey: number;
}

export function isLocked(row: Pick<DraftRow, "kind" | "name">): boolean {
  return row.kind === "verify" || row.name === "develop";
}

function rowOfView(row: StageRow, key: string): DraftRow {
  return {
    key,
    kind: row.kind,
    name: row.name,
    isNew: false,
    provider: row.agent?.provider ?? "",
    model: row.agent?.model ?? "",
    customModel: false,
    prompt: row.promptText ?? "",
    promptPath: row.promptPath,
    run: typeof row.run === "string" ? row.run : "",
    runMap: typeof row.run === "object" ? row.run : undefined,
  };
}

export function draftOf(view: StagesView): StagesDraft {
  return { rows: view.stages.map((row, index) => rowOfView(row, `r${index}`)), nextKey: view.stages.length };
}

function blankRow(draft: StagesDraft, kind: DraftRow["kind"], name: string): DraftRow {
  const key = `r${draft.nextKey}`;
  draft.nextKey += 1;
  return { key, kind, name, isNew: true, provider: "", model: "", customModel: false, prompt: "", promptPath: undefined, run: "", runMap: undefined };
}

/** New rows go just before the verify gate. */
function insertBeforeVerify(draft: StagesDraft, row: DraftRow): void {
  const verifyAt = draft.rows.findIndex((candidate) => candidate.kind === "verify");
  draft.rows.splice(verifyAt === -1 ? draft.rows.length : verifyAt, 0, row);
}

export function addStage(draft: StagesDraft, kind: "agent" | "command"): DraftRow {
  const row = blankRow(draft, kind, "");
  insertBeforeVerify(draft, row);
  return row;
}

export function addBuiltin(draft: StagesDraft, name: BuiltinAgentStage): void {
  insertBeforeVerify(draft, { ...blankRow(draft, "builtin", name), isNew: false });
}

const OPTIONAL_BUILTINS: readonly BuiltinAgentStage[] = ["simplify", "review"];

/** Built-ins that can be put back: `develop` is never removed, so it is never missing. */
export function missingBuiltins(draft: StagesDraft): BuiltinAgentStage[] {
  return OPTIONAL_BUILTINS.filter((name) => !draft.rows.some((row) => row.name === name));
}

export function removeRow(draft: StagesDraft, key: string): void {
  const row = draft.rows.find((candidate) => candidate.key === key);
  if (row && !isLocked(row)) draft.rows = draft.rows.filter((candidate) => candidate !== row);
}

/** Moves a row to `toIndex`, never ahead of `develop` or behind `verify`; locked rows stay put. */
export function moveRow(draft: StagesDraft, key: string, toIndex: number): void {
  const from = draft.rows.findIndex((row) => row.key === key);
  const row = draft.rows[from];
  if (!row || isLocked(row)) return;
  const to = Math.min(Math.max(toIndex, 1), draft.rows.length - 2);
  draft.rows.splice(from, 1);
  draft.rows.splice(to, 0, row);
}

function agentFields(row: DraftRow): { provider: ProviderName | null; model: string | null } {
  const model = row.model.trim();
  return row.provider === "" ? { provider: null, model: null } : { provider: row.provider as ProviderName, model: model === "" ? null : model };
}

function editOf(row: DraftRow): StageEdit {
  if (row.kind === "verify") return { kind: "verify", name: "verify" };
  if (row.kind === "builtin") return { kind: "builtin", name: row.name as BuiltinAgentStage, ...agentFields(row) };
  if (row.kind === "agent") return { kind: "agent", name: row.name.trim(), prompt: row.prompt, ...agentFields(row) };
  return { kind: "command", name: row.name.trim(), run: row.runMap ?? row.run.trim() };
}

/** The whole chain as the PUT body. */
export function draftEdits(draft: StagesDraft): StageEdit[] {
  return draft.rows.map(editOf);
}

export function isDirty(view: StagesView, draft: StagesDraft): boolean {
  return JSON.stringify(draftEdits(draft)) !== JSON.stringify(draftEdits(draftOf(view)));
}

/** Why Save would be refused before it asks the server; the server still validates everything. */
export function draftProblem(draft: StagesDraft): string | undefined {
  const blank = draft.rows.find((row) => (row.kind === "agent" || row.kind === "command") && row.name.trim() === "");
  if (blank) return `Name the new ${blank.kind} stage.`;
  const emptyPrompt = draft.rows.find((row) => row.kind === "agent" && row.prompt.trim() === "");
  if (emptyPrompt) return `${emptyPrompt.name.trim()} has no prompt — open "Edit prompt" and write one.`;
  const emptyRun = draft.rows.find((row) => row.kind === "command" && !row.runMap && row.run.trim() === "");
  if (emptyRun) return `${emptyRun.name.trim()} has no command to run.`;
  return undefined;
}
