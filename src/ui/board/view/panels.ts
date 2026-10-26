import type { UiFeedLine, UiState } from "../../state.js";
import { esc, feedTime } from "../format.js";
import { PARENT_GROUPS, parentGroup, parentMatches, type BoardProject, type ParentOption } from "../model.js";
import { attrs, button, tag } from "./html.js";
import { icon } from "./icons.js";
import type { BoardUi } from "./ui.js";

export function feedLines(ui: BoardUi, project: BoardProject, selectedRun: number | undefined): UiFeedLine[] {
  const all = [...(project.state?.feed ?? []), ...(ui.localFeed[project.id] ?? [])].sort((a, b) => a.at.localeCompare(b.at));
  const shown = ui.feedAll || selectedRun === undefined ? all : all.filter((line) => line.parentNumber === undefined || line.parentNumber === selectedRun);
  return shown.reverse();
}

export function renderFeed(ui: BoardUi, project: BoardProject, selectedRun: number | undefined, uid: string): string {
  const lines = feedLines(ui, project, selectedRun);
  const rows = lines
    .map((line) => {
      const item = line.itemNumber
        ? `<button${attrs({ type: "button", class: "linkish", "data-act": "open-item", "data-proj": project.id, "data-n": line.itemNumber })}>#${line.itemNumber}</button> `
        : "";
      const runRef = ui.feedAll && line.parentNumber ? `<span class="runref">run #${line.parentNumber}</span>` : "";
      return `<li class="${line.kind}"><span class="at">${esc(feedTime(line.at))}</span><span class="k"></span><span class="msg">${item}${esc(line.message)}${runRef}</span></li>`;
    })
    .join("");
  const scope = (value: "run" | "all", label: string): string =>
    `<button${attrs({ type: "button", "data-act": "feed-scope", "data-scope": value, "aria-pressed": (value === "all") === ui.feedAll })}>${label}</button>`;
  return `<section class="panel feed-panel" aria-labelledby="feed-h-${uid}">
    <header><h2 id="feed-h-${uid}">Event feed<span class="count">${lines.length}</span></h2>
      <div class="right"><div class="seg" role="group" aria-label="Feed scope">${scope("run", "This run")}${scope("all", "All runs")}</div></div></header>
    <ul class="feed" data-scroll="feed-${uid}">${rows || `<li><span></span><span></span><span class="msg">No events yet.</span></li>`}</ul>
  </section>`;
}

function parentOption(parent: ParentOption, selected: boolean): string {
  const label = `#${parent.number} ${parent.title} (${parent.completedSubIssues}/${parent.subIssues} closed)`;
  return `<option${attrs({ value: parent.number, selected })}>${esc(label)}</option>`;
}

/** Parent picker: filter box over a select grouped Ready to merge / Working / Todo; the chosen one always stays listed. */
export function parentPicker(ui: BoardUi, project: BoardProject, uid: string): { html: string; chosen: string } {
  const query = ui.parentQuery;
  const matched = project.parents.filter((parent) => parentMatches(parent, query));
  const shown = project.parents.filter((parent) => parentMatches(parent, query) || String(parent.number) === ui.selectedParent);
  const options = project.parents.length === 0 ? [] : shown;
  const chosen = options.some((parent) => String(parent.number) === ui.selectedParent) ? ui.selectedParent : String(options[0]?.number ?? "");
  const groups = PARENT_GROUPS.map(({ group, label }) => {
    const parents = shown.filter((parent) => parentGroup(parent) === group);
    if (parents.length === 0) return "";
    return `<optgroup label="${esc(`${label} (${parents.length})`)}">${parents.map((parent) => parentOption(parent, String(parent.number) === chosen)).join("")}</optgroup>`;
  }).join("");
  const empty =
    matched.length === 0
      ? `<option value="" disabled>${project.parents.length === 0 ? "no open sandcastle parents" : `no parent matches "${esc(query.trim())}" — ${project.parents.length - shown.length} hidden`}</option>`
      : "";
  const html = `<div class="row picker">
      <label class="visually-hidden" for="parent-filter-${uid}">Filter Orchestration Issues</label>
      <input${attrs({ type: "search", id: `parent-filter-${uid}`, class: "filter", placeholder: "Filter issues…", value: query, "data-act": "parent-filter", "data-focus": `parent-filter-${uid}`, autocomplete: "off" })} />
      <select${attrs({ "aria-label": "Orchestration Issue", "data-act": "parent-select", "data-focus": `parent-select-${uid}` })}>${groups}${empty}</select>
    </div>`;
  return { html, chosen };
}

export function renderStartForm(ui: BoardUi, project: BoardProject, uid: string): string {
  const state = project.state;
  if (!state) return "";
  const picker = parentPicker(ui, project, uid);
  const hasChoice = picker.chosen !== "";
  const cap = ui.startCap ?? String(state.queueSettings.parentCap);
  const starting = ui.busy.has(`start:${project.id}`);
  return `<div class="start-form">
      ${picker.html}
      <div class="row">
        <label class="field">Run Cap <input${attrs({ type: "number", min: 1, value: cap, "aria-label": "Run Cap for the new run", "data-act": "start-cap", "data-focus": `start-cap-${uid}` })} /></label>
      </div>
      <div class="row">
        ${button({ label: starting ? "Starting…" : "Start now", icon: "play", cls: "primary", disabled: !state.canStart || !hasChoice || starting, data: { "data-act": "start-now", "data-proj": project.id, "data-parent": picker.chosen } })}
        ${button({ label: state.canStart ? "Queue after" : "Queue next", icon: "plus", disabled: !hasChoice, data: { "data-act": "queue-next", "data-proj": project.id, "data-parent": picker.chosen } })}
        ${button({ label: "Add orchestration issue…", cls: "ghost", data: { "data-act": "open-add", "data-proj": project.id } })}
      </div>
      ${state.canStart ? "" : `<p class="hint">${icon("clock")}Starting is unavailable while another run holds the slot; queue it instead.</p>`}
    </div>`;
}

export function readyToMerge(project: BoardProject): number {
  return project.parents.filter((parent) => parentGroup(parent) === "ready-to-merge").length;
}

function queueTitle(project: BoardProject, number: number): { title: string; sub: string } {
  const known = project.parents.find((parent) => parent.number === number);
  return {
    title: known?.title ?? "",
    sub: known ? `${known.subIssues} sub-issues · cap ${project.state?.queueCap ?? ""}` : `cap ${project.state?.queueCap ?? ""}`,
  };
}

function queueList(project: BoardProject, state: UiState): string {
  if (state.queue.length === 0) {
    return `<p class="muted">Nothing queued. Pick an Orchestration Issue below to run it next.</p>`;
  }
  const rows = state.queue
    .map((number, index) => {
      const { title, sub } = queueTitle(project, number);
      const data = { "data-proj": project.id, "data-n": number, "data-index": index };
      return `<li><span class="pos">${index + 1}</span><span class="q-t"><a href="https://github.com/${esc(state.hubRepo)}/issues/${number}" target="_blank" rel="noreferrer">#${number}</a>${esc(title)}<span class="q-s">${esc(sub)}</span></span>
        <span class="q-acts">
          ${button({ label: "", cls: "sm ghost icon", icon: "up", ariaLabel: `Run #${number} earlier`, disabled: index === 0, data: { "data-act": "queue-up", ...data } })}
          ${button({ label: "", cls: "sm ghost icon", icon: "down", ariaLabel: `Run #${number} later`, disabled: index === state.queue.length - 1, data: { "data-act": "queue-down", ...data } })}
          ${button({ label: "", cls: "sm ghost icon", icon: "x", ariaLabel: `Remove #${number} from the queue`, data: { "data-act": "queue-remove", ...data } })}
        </span></li>`;
    })
    .join("");
  return `<ol class="qlist">${rows}</ol>`;
}

export function renderQueue(ui: BoardUi, project: BoardProject, uid: string): string {
  const state = project.state;
  if (!state) return "";
  const settings = state.queueSettings;
  const parallel = settings.mode === "parallel";
  const ready = readyToMerge(project);
  const mode = (value: "sequential" | "parallel", label: string): string =>
    `<button${attrs({ type: "button", "data-act": "queue-mode", "data-proj": project.id, "data-mode": value, "aria-pressed": settings.mode === value })}>${label}</button>`;
  return `<section class="panel" aria-labelledby="q-h-${uid}">
    <header><h2 id="q-h-${uid}">Run queue<span class="count">${state.queue.length}</span></h2>
      <div class="right">${ready > 0 ? tag(`${ready} ready for your merge`, "merge", "pr") : ""}</div></header>
    <div class="queue-body">
      <div class="qrow-settings">
        <div class="seg" role="group" aria-label="Queue mode">${mode("sequential", "Sequential")}${mode("parallel", "Parallel")}</div>
        ${parallel ? `<label class="field">Max <input${attrs({ type: "number", min: 1, value: settings.maxParallel, "aria-label": "Max parallel runs", "data-act": "queue-max", "data-proj": project.id, "data-focus": `queue-max-${uid}` })} /></label>` : ""}
        ${settings.paused ? `${tag("Queue paused", "wait")}${button({ label: "Resume queue", icon: "play", cls: "sm primary", data: { "data-act": "queue-resume", "data-proj": project.id } })}` : ""}
        ${button({ label: "Clear", cls: "sm ghost danger push", disabled: state.queue.length === 0, data: { "data-act": "queue-clear", "data-proj": project.id } })}
      </div>
      ${queueList(project, state)}
      ${renderStartForm(ui, project, uid)}
    </div>
  </section>`;
}
