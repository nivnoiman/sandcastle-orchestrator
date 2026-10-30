import type { StageRow, StagesView } from "../../../project/stagesEditor.js";
import { esc } from "../format.js";
import { draftEdits } from "../stagesDraft.js";
import { attrs, button, tag } from "./html.js";
import type { DrawerState } from "./ui.js";

type StagesDrawer = Extract<DrawerState, { kind: "stages" }>;

const KIND_LABEL: Record<StageRow["kind"], string> = {
  builtin: "built-in",
  verify: "gate",
  agent: "agent",
  command: "command",
};

function defaultLabel(view: StagesView): string {
  const { provider, model } = view.defaultAgent;
  return model ? `${provider} · ${model}` : provider;
}

function agentControls(row: StageRow, drawer: StagesDrawer, view: StagesView): string {
  const draft = drawer.draft[row.name];
  if (!draft) return "";
  const providerOptions = [`<option value=""${draft.provider === "" ? " selected" : ""}>default (${esc(defaultLabel(view))})</option>`]
    .concat(view.providers.map((provider) => `<option${attrs({ value: provider, selected: provider === draft.provider })}>${esc(provider)}</option>`))
    .join("");
  const listId = `models-${row.name}`;
  const known = draft.provider === "" ? [] : (view.models[draft.provider as keyof StagesView["models"]] ?? []);
  return `<div class="stage-agent">
      <select${attrs({ "aria-label": `${row.name} provider`, disabled: drawer.busy, "data-act": "stage-provider", "data-stage": row.name, "data-focus": `stage-provider-${row.name}` })}>${providerOptions}</select>
      <input${attrs({ type: "text", list: listId, value: draft.model, placeholder: draft.provider === "" ? "model — pick a provider first" : "model (empty = provider default)", disabled: draft.provider === "" || drawer.busy, "aria-label": `${row.name} model`, "data-act": "stage-model", "data-stage": row.name, "data-focus": `stage-model-${row.name}`, autocomplete: "off", spellcheck: false })} />
      <datalist id="${esc(listId)}">${known.map((model) => `<option value="${esc(model)}"></option>`).join("")}</datalist>
    </div>`;
}

function rowMarkup(row: StageRow, drawer: StagesDrawer, view: StagesView): string {
  const note = row.kind === "verify" ? `<span class="muted">runs the project's checks; no agent</span>` : row.kind === "command" ? `<code>${esc(typeof row.run === "string" ? row.run : `per repo: ${(row.run ?? []).join(", ")}`)}</code>` : "";
  return `<li class="stage-row">
      <div class="stage-head"><b class="mono">${esc(row.name)}</b>${tag(KIND_LABEL[row.kind])}</div>
      ${row.hasAgent ? agentControls(row, drawer, view) : `<div class="stage-note">${note}</div>`}
    </li>`;
}

export function stagesBody(drawer: StagesDrawer): string {
  const { view } = drawer;
  if (!view) return `<div class="d-form"><span class="muted">${drawer.error ? esc(drawer.error) : "Loading…"}</span></div>`;
  const dirty = draftEdits(view, drawer.draft).length;
  const flow = ["queued", ...view.stages.map((row) => row.name), "merged"].map((name) => `<span class="flow-step">${esc(name)}</span>`).join('<span class="flow-arrow" aria-hidden="true">→</span>');
  return `<div class="d-form stages-form">
      <p class="stage-applies" role="note"><b>Applies to new runs only.</b> A run already in flight keeps the stages and models it started with.</p>
      <div class="flow" aria-label="Stage flow">${flow}</div>
      <ul class="stage-list">${view.stages.map((row) => rowMarkup(row, drawer, view)).join("")}</ul>
      ${drawer.error ? `<p class="stage-error" role="alert">${esc(drawer.error)}</p>` : ""}
      ${drawer.notice ? `<p class="stage-notice" role="status">${esc(drawer.notice)}</p>` : ""}
      <div class="d-acts">
        ${button({ label: drawer.busy ? "Saving…" : dirty > 0 ? `Save ${dirty} change${dirty === 1 ? "" : "s"}` : "Save", icon: "check", cls: "primary", disabled: drawer.busy || dirty === 0, data: { "data-act": "stages-save", "data-proj": drawer.projectId } })}
        ${button({ label: "Refresh", icon: "retry", cls: "ghost", title: "Re-read .sandcastle/config.json and use it for new runs — picks up hand edits", disabled: drawer.busy, data: { "data-act": "stages-refresh", "data-proj": drawer.projectId } })}
      </div>
    </div>`;
}

export function stagesHead(projectName: string, closeButton: string): string {
  return `<div class="d-head"><div class="row"><h2>Stages</h2>${closeButton}</div><div class="d-meta"><span>Stage flow and the agent per stage for ${esc(projectName)}, from <code>.sandcastle/config.json</code>.</span></div></div>`;
}
