import type { UiAgent, UiItem, UiRun } from "../../state.js";
import { esc } from "../format.js";
import { isLocalProject, webUrl, type BoardProject } from "../model.js";
import { collapseTurns, transcriptTurns, type LogRow } from "../transcript.js";
import { attrs, button, issueLink, tag } from "./html.js";
import { icon } from "./icons.js";
import { prLabel } from "./run.js";
import { stagesBody, stagesHead } from "./stages.js";
import type { BoardUi, DrawerState } from "./ui.js";

export interface DrawerParts {
  label: string;
  head: string;
  attempts: string;
  body: string;
}

export function findItem(project: BoardProject, itemNumber: number): { item: UiItem; run: UiRun | undefined } | undefined {
  const state = project.state;
  if (!state) return undefined;
  for (const run of state.runs) {
    const item = run.items.find((candidate) => candidate.number === itemNumber);
    if (item) return { item, run };
  }
  const item = state.items.find((candidate) => candidate.number === itemNumber);
  return item ? { item, run: undefined } : undefined;
}

const PHASE_TONE: Record<UiItem["phase"], string> = {
  running: "run",
  awaiting: "run",
  waiting: "wait",
  parked: "park",
  done: "done",
  held: "",
  blocked: "wait",
  queued: "",
};

function blockedBy(project: BoardProject, blockers: number[]): string {
  if (blockers.length === 0) return "";
  const rows = blockers
    .map((number) => {
      const found = findItem(project, number);
      if (!found) return `<li class="d-blocker"><span class="mono">#${number}</span><span class="t">not on this board</span></li>`;
      const { item } = found;
      return `<li><button${attrs({ type: "button", class: "d-blocker", "data-act": "open-item", "data-proj": project.id, "data-n": number, title: `Open #${number} — ${item.title}` })}><span class="mono">#${number}</span><span class="t">${esc(item.title)}</span>${tag(item.phase, PHASE_TONE[item.phase])}</button></li>`;
    })
    .join("");
  return `<div class="d-blocked"><b>Blocked by</b><ul>${rows}</ul></div>`;
}

function closeButton(): string {
  return button({ label: "", icon: "x", cls: "ghost icon", ariaLabel: "Close", data: { "data-act": "drawer-close" } });
}

function agentLabel(agent: UiAgent | undefined): string {
  if (!agent?.model) return "";
  return agent.provider === "claude" ? agent.model : `${agent.provider} · ${agent.model}`;
}

function itemHead(project: BoardProject, drawer: Extract<DrawerState, { kind: "item" }>): string {
  const found = findItem(project, drawer.itemNumber);
  if (!found) {
    return `<div class="d-head"><div class="row"><h2>#${drawer.itemNumber}</h2>${closeButton()}</div><div class="d-meta"><span>This item is no longer in the run.</span></div></div>`;
  }
  const { item, run } = found;
  const data = { "data-proj": project.id, "data-n": item.number };
  const acts = [
    item.phase === "parked" || item.phase === "waiting" ? button({ label: "Retry item", icon: "retry", cls: "primary", data: { "data-act": "retry", ...data } }) : "",
    item.phase === "running" ? button({ label: "Cancel", icon: "x", cls: "danger", data: { "data-act": "cancel", ...data } }) : "",
    webUrl(item.issueUrl) ? `<a class="btn" href="${esc(item.issueUrl)}" target="_blank" rel="noreferrer">${icon("ext")}Open issue</a>` : "",
    webUrl(item.pullRequestUrl) ? `<a class="btn" href="${esc(item.pullRequestUrl)}" target="_blank" rel="noreferrer">${icon("pr")}${esc(prLabel(item.pullRequestUrl ?? ""))}</a>` : "",
  ].join("");
  const model = agentLabel(item.agent);
  const reason = item.parkReason ? `<div class="d-reason"><b>Parked:</b> ${esc(item.parkReason)}</div>` : "";
  return `<div class="d-head">
      <div class="row"><h2>${issueLink(webUrl(item.issueUrl), `#${item.number}`)}${esc(item.title)}</h2>${closeButton()}</div>
      <div class="d-meta">
        ${tag(`${item.phase}${item.stage ? ` · ${item.stage}` : ""}`, PHASE_TONE[item.phase])}
        ${model ? `<span class="d-model mono" title="Agent model of the ${esc(item.stage ?? "latest")} stage">${esc(model)}</span>` : ""}
        <span>${icon("pin")}${esc(item.repo)}</span>
        <span class="mono">${icon("branch")}${esc(item.branch)}</span>
        ${item.reworkRound > 0 ? `<span>Rework ${item.reworkRound}/${item.reworkLimit}</span>` : ""}
        ${run ? `<span>Run #${run.parent.number}</span>` : ""}
      </div>
      ${reason}
      ${blockedBy(project, item.blockers)}
      <div class="d-acts">${acts}</div>
    </div>`;
}

function attemptsMarkup(drawer: Extract<DrawerState, { kind: "item" }>): string {
  const tabs = drawer.attempts
    .map((attempt) => {
      const dot = attempt.live ? "run pulse" : attempt.outcome === "success" ? "done" : "park";
      const label = `${attempt.stage} #${attempt.attempt}${attempt.live ? " · live" : ` · ${attempt.outcome ?? "?"}`}`;
      return `<button${attrs({ type: "button", class: "att", "data-act": "select-attempt", "data-attempt": attempt.id, "aria-selected": attempt.id === drawer.attemptId, title: `${attempt.startedAt} — ${attempt.bytes} bytes` })}><span class="dot ${dot}"></span>${esc(label)}</button>`;
    })
    .join("");
  return `<h3>Attempts<label><input${attrs({ type: "checkbox", "data-act": "raw-toggle", checked: drawer.raw })} /> Raw JSON</label></h3>
      <div class="att-track">${tabs || `<span class="muted">${drawer.loaded ? "No attempt has been recorded for this item yet." : "Loading…"}</span>`}</div>`;
}

function clock(at: number): string {
  return new Date(at).toISOString().slice(11, 19);
}

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** UTC time, or "from - to (duration)" for a collapsed row; empty without a source time. */
export function rowTime(row: LogRow): string {
  if (row.at === undefined) return "";
  if (row.until === undefined || row.until === row.at) return clock(row.at);
  return `${clock(row.at)} - ${clock(row.until)} (${duration(row.until - row.at)})`;
}

function rowMarkup(row: LogRow): string {
  const time = rowTime(row);
  const stamp = time ? `<span class="ts" title="UTC">${esc(time)}</span>` : "";
  const repeat = row.count > 1 ? `<span class="rep">×${row.count}</span>` : "";
  return `<div class="turn ${row.kind}">${stamp}${repeat}${esc(row.text)}</div>`;
}

export function renderLog(text: string, raw: boolean): string {
  if (raw) return `<pre class="raw">${esc(text)}</pre>`;
  return collapseTurns(transcriptTurns(text)).map(rowMarkup).join("");
}

function resetBody(drawer: Extract<DrawerState, { kind: "reset" }>): string {
  const { reset } = drawer;
  return `<div class="d-form">
      <pre class="plan" tabindex="0">${esc(reset.text)}</pre>
      <div class="d-acts">
        ${reset.canApply ? button({ label: reset.busy ? "Applying…" : "Apply reset", icon: "reset", cls: "danger", disabled: reset.busy, data: { "data-act": "reset-apply", "data-proj": drawer.projectId } }) : ""}
        ${button({ label: "Close", cls: "ghost", data: { "data-act": "drawer-close" } })}
      </div>
    </div>`;
}

function newParentBody(drawer: Extract<DrawerState, { kind: "add" }>): string {
  const missing = drawer.title.trim() === "";
  return `<form class="d-form" data-act="add-submit" data-proj="${esc(drawer.projectId)}">
      <label for="add-title" class="field-label">Title</label>
      <input${attrs({ id: "add-title", type: "text", value: drawer.title, placeholder: "Add billing export", "data-act": "add-title", "data-focus": "add-title", autocomplete: "off", spellcheck: false })} />
      <label for="add-input" class="field-label">Description (optional)</label>
      <textarea${attrs({ id: "add-input", rows: 6, placeholder: "What this feature should do. Items are added as files next to it.", "data-act": "add-text", "data-focus": "add-input" })}>${esc(drawer.text)}</textarea>
      <div class="d-acts">
        ${button({ label: drawer.busy ? "Creating…" : "Create parent file", icon: "plus", cls: "primary", disabled: drawer.busy || missing, data: { "data-act": "add-submit-btn" } })}
      </div>
      ${drawer.result ? `<pre class="plan" tabindex="0">${esc(drawer.result)}</pre>` : ""}
    </form>`;
}

function addBody(drawer: Extract<DrawerState, { kind: "add" }>, local: boolean): string {
  if (local) return newParentBody(drawer);
  return `<form class="d-form" data-act="add-submit" data-proj="${esc(drawer.projectId)}">
      <label for="add-input" class="field-label">Issue numbers or URLs, one per line</label>
      <textarea${attrs({ id: "add-input", rows: 6, placeholder: "142\nhttps://github.com/owner/hub/issues/150", "data-act": "add-text", "data-focus": "add-input", spellcheck: false })}>${esc(drawer.text)}</textarea>
      <div class="d-acts">
        ${button({ label: drawer.busy ? "Checking…" : "Add to the list", icon: "plus", cls: "primary", disabled: drawer.busy || drawer.text.trim() === "", data: { "data-act": "add-submit-btn" } })}
      </div>
      ${drawer.result ? `<pre class="plan" tabindex="0">${esc(drawer.result)}</pre>` : ""}
    </form>`;
}

export function renderDrawer(ui: BoardUi, project: BoardProject, drawer: DrawerState, logText: string): DrawerParts {
  const local = isLocalProject(project);
  if (drawer.kind === "item") {
    return {
      label: "Item detail",
      head: itemHead(project, drawer),
      attempts: attemptsMarkup(drawer),
      body: renderLog(logText, drawer.raw),
    };
  }
  if (drawer.kind === "reset") {
    return {
      label: "Reset",
      head: `<div class="d-head"><div class="row"><h2>${esc(drawer.reset.title)}</h2>${closeButton()}</div><div class="d-meta"><span>Clears a killed run's debris: containers, stale lock, sc:* labels and empty item branches. Review the plan before applying.</span></div></div>`,
      attempts: "",
      body: resetBody(drawer),
    };
  }
  if (drawer.kind === "stages") {
    return { label: "Stages", head: stagesHead(project.name, closeButton()), attempts: "", body: stagesBody(drawer) };
  }
  return {
    label: local ? "New orchestration issue" : "Add orchestration issue",
    head: `<div class="d-head"><div class="row"><h2>${local ? "New orchestration issue" : "Add orchestration issue"}</h2>${closeButton()}</div><div class="d-meta"><span>${local ? `Writes a parent file under <code>.scratch/</code> for ${esc(project.name)}; add its items as files next to it.` : `Checks each issue against the hub and adds it to the parent list for ${esc(project.name)}.`}</span></div></div>`,
    attempts: "",
    body: addBody(drawer, local),
  };
}
