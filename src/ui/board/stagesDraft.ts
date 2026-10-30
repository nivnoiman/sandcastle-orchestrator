import type { AgentEdit, StageRow, StagesView } from "../../project/stagesEditor.js";
import type { ProviderName } from "../../project/agentsConfig.js";

/** What the operator typed for one stage; provider "" means "use the project default". */
export interface StageDraft {
  provider: string;
  model: string;
}

export type StagesDraft = Record<string, StageDraft>;

function savedDraft(row: StageRow): StageDraft {
  return { provider: row.agent?.provider ?? "", model: row.agent?.model ?? "" };
}

export function draftOf(view: StagesView): StagesDraft {
  return Object.fromEntries(view.stages.filter((row) => row.hasAgent).map((row) => [row.name, savedDraft(row)]));
}

function sameDraft(a: StageDraft, b: StageDraft): boolean {
  return a.provider === b.provider && (a.provider === "" || a.model.trim() === b.model.trim());
}

/** The rows whose draft differs from what is saved, as the PUT body; changing nothing sends nothing. */
export function draftEdits(view: StagesView, draft: StagesDraft): AgentEdit[] {
  const edits: AgentEdit[] = [];
  for (const row of view.stages) {
    const current = draft[row.name];
    if (!row.hasAgent || !current || sameDraft(current, savedDraft(row))) continue;
    const provider = current.provider === "" ? null : (current.provider as ProviderName);
    const model = provider === null || current.model.trim() === "" ? null : current.model.trim();
    edits.push({ name: row.name, provider, model });
  }
  return edits;
}
