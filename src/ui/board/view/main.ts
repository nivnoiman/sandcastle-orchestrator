import type { AttentionEntry } from "../attention.js";
import { esc } from "../format.js";
import { chooseRun, type BoardProject } from "../model.js";
import { attrs, button, meter, modeChip, tag } from "./html.js";
import { icon } from "./icons.js";
import { renderAttention } from "./attention.js";
import { renderFeed, renderQueue, renderStartForm } from "./panels.js";
import { renderRunPanel, renderRunTabs } from "./run.js";
import { currentProject, type BoardUi } from "./ui.js";

function resetTitle(state: NonNullable<BoardProject["state"]>): string {
  if (state.canReset) return "Clear a killed run's debris: gc, stale lock, sc:* labels, empty item branches";
  if (state.mode !== "real") return "Reset only applies to a real run";
  if (state.resetting) return "A reset is already running — the control plane is blocked until it finishes";
  return "Stop the run first — reset would garbage-collect its own containers";
}

function topbar(ui: BoardUi, project: BoardProject): string {
  const state = project.state;
  const working = state?.globalRunning ?? 0;
  const cap = state?.queueSettings.globalCap ?? 0;
  const live = state?.runs.filter((run) => !run.settled) ?? [];
  const allPaused = live.length > 0 && live.every((run) => run.paused);
  const agents =
    ui.scope === "dashboard"
      ? { working: ui.projects.reduce((sum, candidate) => sum + (candidate.state?.globalRunning ?? 0), 0), cap: ui.projects.reduce((sum, candidate) => sum + (candidate.state?.queueSettings.globalCap ?? 0), 0), label: "agents across all projects" }
      : { working, cap, label: "agents working" };
  const data = { "data-proj": project.id };
  return `<div class="topbar">
      <h1>${esc(project.name)}</h1>
      <span class="hubrepo mono">${esc(project.hub)}</span>
      ${modeChip(project.mode)}
      ${state && !project.connected ? tag("reconnecting…", "wait") : ""}
      ${project.idle && (state?.runs.length ?? 0) === 0 ? tag("idle", "") : ""}
      <span class="spacer"></span>
      <span class="workers" title="Agents working against the Project Cap">${meter(agents.working, agents.cap)}<strong>${agents.working}/${agents.cap}</strong> ${agents.label}</span>
      ${
        state
          ? `<label class="field">Project Cap <input${attrs({ type: "number", min: 1, value: cap, "aria-label": "Project Cap", "data-act": "project-cap", "data-focus": "project-cap", ...data })} /></label>
      ${button({ label: allPaused ? "Resume project" : "Pause project", icon: allPaused ? "play" : "pause", title: live.length === 0 ? "Nothing is running to pause" : "Stop starting new stages across every run; agents already working finish their stage", disabled: live.length === 0, data: { "data-act": allPaused ? "resume-project" : "pause-project", ...data } })}
      ${ui.scope === "dashboard" ? button({ label: "Pause all", icon: "pause", cls: "ghost", title: "Pause every running Project Server: no new stages start; agents already working finish their stage", data: { "data-act": "pause-all" } }) : ""}
      ${button({ label: "Feed", icon: "log", cls: "ghost", title: ui.feedOpen ? "Hide the event feed" : "Show the event feed", data: { "data-act": "toggle-feed", "aria-pressed": ui.feedOpen } })}
      ${button({ label: "Reset…", icon: "reset", cls: "ghost", title: resetTitle(state), disabled: !state.canReset, data: { "data-act": "open-reset", ...data } })}`
          : ""
      }
    </div>`;
}

function modeBanner(project: BoardProject): string {
  if (project.mode !== "dry") return "";
  return `<div class="mode-banner" role="note">${icon("bolt")}<span><b>Dry mode</b> — this Project Server simulates runs. No containers start, GitHub is not written, no tokens are spent.</span></div>`;
}

function emptyState(ui: BoardUi, project: BoardProject): string {
  const state = project.state;
  if (!state) return "";
  const held = state.hold;
  const lead = project.idle ? "Idle Project Server" : "No run in flight";
  const text = held
    ? held.reason === "auth"
      ? "This project is held: agent credentials were rejected. Fix them and sandcastle resumes on the next probe; the queued run then starts on its own."
      : "This project is held: the usage window is exhausted. Queued runs start when it reopens."
    : project.idle
      ? "Pick an Orchestration Issue to run. Nothing spends tokens until you press Start now."
      : "Pick an Orchestration Issue and press Start now, or queue it behind the current run.";
  return `<div class="panel"><div class="empty-state"><h3>${lead}</h3><p>${esc(text)}</p>${state.canStart ? renderStartForm(ui, project, "empty") : ""}</div></div>`;
}

function unreachable(project: BoardProject): string {
  const text =
    project.status === "died"
      ? "The Project Server died unexpectedly. Restart it to watch its runs again."
      : project.status === "stopped"
        ? "This Project Server is not running."
        : project.connected
          ? "Loading state…"
          : "Waiting for the Project Server to answer…";
  const restart = project.status !== "running" ? button({ label: "Restart", icon: "retry", cls: "primary", data: { "data-act": "att-restart", "data-proj": project.id } }) : "";
  return `<div class="panel"><div class="empty-state"><h3>${esc(project.name)}</h3><p>${esc(text)}</p>${restart}</div></div>`;
}

export function renderMain(ui: BoardUi, attention: readonly AttentionEntry[]): string {
  const project = currentProject(ui);
  if (!project) return `<div class="panel"><div class="empty-state"><h3>No projects yet</h3><p>Start a Project Server with <code>sandcastle ui</code> inside a project.</p></div></div>`;
  const state = project.state;
  const run = chooseRun(state, ui.selectedRuns[project.id]);
  const body = !state
    ? unreachable(project)
    : run
      ? `${renderRunTabs(ui, project, run)}${renderRunPanel(ui, project, run)}`
      : emptyState(ui, project);
  const selected = run?.parent.number;
  return `${topbar(ui, project)}
    ${modeBanner(project)}
    ${renderAttention(ui, attention)}
    ${body}
    <div class="lower${ui.feedOpen ? "" : " no-feed"}">${state ? `${renderFeed(ui, project, selected, "a")}${renderQueue(ui, project, "a")}` : ""}</div>`;
}

export function renderSide(ui: BoardUi): string {
  const project = currentProject(ui);
  if (!project?.state) return "";
  const run = chooseRun(project.state, ui.selectedRuns[project.id]);
  return `${renderFeed(ui, project, run?.parent.number, "b")}${renderQueue(ui, project, "b")}`;
}
