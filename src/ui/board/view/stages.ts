import type { StageRow, StagesView } from "../../../project/stagesEditor.js";
import { esc } from "../format.js";
import { draftProblem, isDirty, isLocked, missingBuiltins, type DraftRow } from "../stagesDraft.js";
import { attrs, button, tag } from "./html.js";
import type { DrawerState } from "./ui.js";

type StagesDrawer = Extract<DrawerState, { kind: "stages" }>;

const KIND_LABEL: Record<StageRow["kind"], string> = {
  builtin: "built-in",
  verify: "gate",
  agent: "agent",
  command: "command",
};

const CUSTOM_MODEL = "__custom__";

function defaultLabel(view: StagesView): string {
  const { provider, model } = view.defaultAgent;
  return model ? `${provider} · ${model}` : provider;
}

function promptPathOf(row: DraftRow, view: StagesView): string {
  return row.promptPath ?? `${view.promptsDir}/${row.name.trim() || "<name>"}.md`;
}

function agentControls(row: DraftRow, drawer: StagesDrawer, view: StagesView): string {
  const providerOptions = [`<option value=""${row.provider === "" ? " selected" : ""}>default (${esc(defaultLabel(view))})</option>`]
    .concat(view.providers.map((provider) => `<option${attrs({ value: provider, selected: provider === row.provider })}>${esc(provider)}</option>`))
    .join("");
  const known = row.provider === "" ? [] : (view.models[row.provider as keyof StagesView["models"]] ?? []);
  const custom = row.customModel || (row.model !== "" && !known.includes(row.model));
  const picked = custom ? CUSTOM_MODEL : row.model;
  const modelOptions = [`<option value=""${picked === "" ? " selected" : ""}>${row.provider === "" ? "model — pick a provider first" : "provider default"}</option>`]
    .concat(known.map((model) => `<option${attrs({ value: model, selected: model === picked })}>${esc(model)}</option>`))
    .concat(row.provider === "" ? [] : [`<option${attrs({ value: CUSTOM_MODEL, selected: custom })}>Custom…</option>`])
    .join("");
  const data = { "data-key": row.key };
  return `<div class="stage-agent">
      <select${attrs({ "aria-label": `${row.name || "new"} provider`, disabled: drawer.busy, "data-act": "stage-provider", "data-focus": `stage-provider-${row.key}`, ...data })}>${providerOptions}</select>
      <select${attrs({ "aria-label": `${row.name || "new"} model`, disabled: row.provider === "" || drawer.busy, "data-act": "stage-model-pick", "data-focus": `stage-model-pick-${row.key}`, ...data })}>${modelOptions}</select>
      ${custom ? `<input${attrs({ type: "text", value: row.model, placeholder: "model name, e.g. gpt-5.5", disabled: drawer.busy, class: "stage-model-custom", "aria-label": `${row.name || "new"} custom model`, "data-act": "stage-model", "data-focus": `stage-model-${row.key}`, autocomplete: "off", spellcheck: false, ...data })} />` : ""}
    </div>`;
}

function nameField(row: DraftRow, drawer: StagesDrawer): string {
  if (!row.isNew || row.kind === "builtin") return `<b class="mono">${esc(row.name)}</b>`;
  return `<input${attrs({ type: "text", value: row.name, placeholder: "stage-name", maxlength: 30, disabled: drawer.busy, class: "stage-name", "aria-label": `New ${row.kind} stage name`, "data-act": "stage-name", "data-key": row.key, "data-focus": `stage-name-${row.key}`, autocomplete: "off", spellcheck: false })} />`;
}

function promptButton(row: DraftRow, drawer: StagesDrawer, view: StagesView): string {
  const empty = row.prompt.trim() === "";
  const first = row.prompt.trim().split("\n", 1)[0] ?? "";
  const path = promptPathOf(row, view);
  return `<div class="stage-prompt">
      ${button({ label: empty ? "Write prompt…" : "Edit prompt…", icon: "log", disabled: drawer.busy, data: { "data-act": "stage-prompt-open", "data-key": row.key } })}
      <span class="muted mono" title="${esc(path)}">${esc(empty ? path : first.slice(0, 70))}</span>
    </div>`;
}

function commandField(row: DraftRow, drawer: StagesDrawer, view: StagesView): string {
  if (row.runMap) return `<div class="stage-note"><span class="muted">per repo:</span> <code>${esc(Object.keys(row.runMap).join(", "))}</code> <span class="muted">— edit in config.json</span></div>`;
  const picker =
    view.commands.length === 0
      ? ""
      : `<select${attrs({ "aria-label": `${row.name || "new"} existing commands`, disabled: drawer.busy, "data-act": "stage-run-pick", "data-key": row.key })}><option value="">Pick a command this project already runs…</option>${view.commands.map((entry) => `<option${attrs({ value: entry.command })}>${esc(`${entry.source} — ${entry.command}`)}</option>`).join("")}</select>`;
  return `${picker}<input${attrs({ type: "text", value: row.run, placeholder: "shell command, e.g. npm run e2e", disabled: drawer.busy, "aria-label": `${row.name || "new"} command`, "data-act": "stage-run", "data-key": row.key, "data-focus": `stage-run-${row.key}`, autocomplete: "off", spellcheck: false })} />`;
}

function moveButtons(row: DraftRow, index: number, count: number, drawer: StagesDrawer): string {
  if (isLocked(row)) return `<span class="stage-lock muted" title="${row.kind === "verify" ? "verify is the merge gate and always runs last" : "develop always runs first"}">${row.kind === "verify" ? "last" : "first"}</span>`;
  const data = { "data-key": row.key };
  const label = row.name || "stage";
  return `${button({ label: "", icon: "up", cls: "ghost icon", ariaLabel: `Move ${label} up`, disabled: drawer.busy || index <= 1, data: { "data-act": "stage-up", ...data } })}
    ${button({ label: "", icon: "down", cls: "ghost icon", ariaLabel: `Move ${label} down`, disabled: drawer.busy || index >= count - 2, data: { "data-act": "stage-down", ...data } })}
    ${button({ label: "", icon: "x", cls: "ghost icon", ariaLabel: `Remove ${label}`, title: "Remove this stage from the flow", disabled: drawer.busy, data: { "data-act": "stage-remove", ...data } })}`;
}

function rowMarkup(row: DraftRow, index: number, drawer: StagesDrawer, view: StagesView): string {
  const body =
    row.kind === "verify"
      ? `<div class="stage-note"><span class="muted">runs the project's checks; no agent</span></div>`
      : row.kind === "command"
        ? commandField(row, drawer, view)
        : `${agentControls(row, drawer, view)}${row.kind === "agent" ? promptButton(row, drawer, view) : ""}`;
  const movable = !isLocked(row) && !drawer.busy;
  return `<li${attrs({ class: `stage-row${drawer.dragKey === row.key ? " dragging" : ""}`, "data-key": row.key, "data-index": index })}>
      <div class="stage-head">
        ${isLocked(row) ? "" : `<span${attrs({ class: "grip", title: "Drag to reorder", "aria-hidden": true, draggable: movable ? "true" : undefined, "data-drag": "stage", "data-key": row.key })}>⋮⋮</span>`}
        ${nameField(row, drawer)}${tag(KIND_LABEL[row.kind])}
        <span class="spacer"></span>${moveButtons(row, index, drawer.draft.rows.length, drawer)}
      </div>
      ${body}
    </li>`;
}

function addBar(drawer: StagesDrawer): string {
  const missing = missingBuiltins(drawer.draft);
  const builtinPicker =
    missing.length === 0
      ? ""
      : `<select${attrs({ "aria-label": "Add a built-in stage", disabled: drawer.busy, "data-act": "stage-add-builtin" })}><option value="">+ Built-in…</option>${missing.map((name) => `<option value="${name}">${name}</option>`).join("")}</select>`;
  return `<div class="stage-add">
      ${button({ label: "Agent stage", icon: "plus", disabled: drawer.busy, title: "A prompt run by an agent on the provider and model you pick", data: { "data-act": "stage-add", "data-kind": "agent" } })}
      ${button({ label: "Command stage", icon: "plus", disabled: drawer.busy, title: "A shell command run in a clean copy of the branch; red sends the item back to develop", data: { "data-act": "stage-add", "data-kind": "command" } })}
      ${builtinPicker}
    </div>`;
}

function promptModal(drawer: StagesDrawer, view: StagesView): string {
  const row = drawer.draft.rows.find((candidate) => candidate.key === drawer.editing);
  if (!row) return "";
  const placeholders = view.placeholders.map((name) => `<code>{{${esc(name)}}}</code>`).join(" ");
  return `<div class="modal-scrim" data-act="stage-prompt-close"></div>
    <div class="modal" role="dialog" aria-modal="true" aria-label="Edit prompt for ${esc(row.name || "new stage")}">
      <h3>Prompt — ${esc(row.name.trim() || "new stage")}</h3>
      <ul class="modal-help">
        <li>This is the <b>method</b> the stage's agent follows. Sandcastle wraps it in the usual run context: the issue spec, the branch, the rules for commits and notes.</li>
        <li>Use placeholders to point at the item: ${placeholders}</li>
        <li>An unknown <code>{{name}}</code> is refused when you save.</li>
        <li>Saved as <code>${esc(promptPathOf(row, view))}</code> when you press Save in Stages, and read again at every new stage start. A run already in flight keeps what it started with.</li>
        <li>To send work back to develop, tell the agent to finish with <code>NEEDS-REWORK:</code> and the reason; <code>UNFIXABLE:</code> parks the item.</li>
      </ul>
      <textarea${attrs({ rows: 12, maxlength: 65536, "aria-label": "Prompt text", "data-act": "stage-prompt-text", "data-key": row.key, "data-focus": `stage-prompt-${row.key}`, spellcheck: false })}>${esc(row.prompt)}</textarea>
      <div class="d-acts">${button({ label: "Done", icon: "check", cls: "primary", data: { "data-act": "stage-prompt-close" } })}</div>
    </div>`;
}

export function stagesBody(drawer: StagesDrawer): string {
  const { view } = drawer;
  if (!view) return `<div class="d-form"><span class="muted">${drawer.error ? esc(drawer.error) : "Loading…"}</span></div>`;
  const problem = draftProblem(drawer.draft);
  const dirty = isDirty(view, drawer.draft);
  const flow = ["queued", ...drawer.draft.rows.map((row) => row.name.trim() || "…"), "merged"].map((name) => `<span class="flow-step">${esc(name)}</span>`).join('<span class="flow-arrow" aria-hidden="true">→</span>');
  return `<div class="d-form stages-form">
      <p class="stage-applies" role="note"><b>Applies to new runs only.</b> A run already in flight keeps the stages and models it started with.</p>
      <div class="flow" aria-label="Stage flow">${flow}</div>
      <ul class="stage-list">${drawer.draft.rows.map((row, index) => rowMarkup(row, index, drawer, view)).join("")}</ul>
      ${addBar(drawer)}
      ${problem && dirty ? `<p class="stage-error" role="alert">${esc(problem)}</p>` : ""}
      ${drawer.error ? `<p class="stage-error" role="alert">${esc(drawer.error)}</p>` : ""}
      ${drawer.notice ? `<p class="stage-notice" role="status">${esc(drawer.notice)}</p>` : ""}
      <div class="d-acts">
        ${button({ label: drawer.busy ? "Saving…" : "Save changes", icon: "check", cls: "primary", disabled: drawer.busy || !dirty || problem !== undefined, data: { "data-act": "stages-save", "data-proj": drawer.projectId } })}
        ${button({ label: "Discard", cls: "ghost", disabled: drawer.busy || !dirty, data: { "data-act": "stages-discard" } })}
        ${button({ label: "Refresh", icon: "retry", cls: "ghost", title: "Re-read .sandcastle/config.json and use it for new runs — picks up hand edits and drops unsaved changes", disabled: drawer.busy, data: { "data-act": "stages-refresh", "data-proj": drawer.projectId } })}
      </div>
      ${promptModal(drawer, view)}
    </div>`;
}

export function stagesHead(projectName: string, closeButton: string): string {
  return `<div class="d-head"><div class="row"><h2>Stages</h2>${closeButton}</div><div class="d-meta"><span>Stage flow and the agent per stage for ${esc(projectName)}, from <code>.sandcastle/config.json</code>. Drag a stage to reorder.</span></div></div>`;
}
