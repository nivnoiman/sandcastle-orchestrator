import { attentionBadge, type AttentionEntry } from "../attention.js";
import { esc } from "../format.js";
import { projectCap, projectWorking, type BoardProject } from "../model.js";
import { attrs, modeChip } from "./html.js";
import { icon } from "./icons.js";
import { currentProject, type BoardUi } from "./ui.js";

const THEME_LABEL = { auto: "auto", light: "light", dark: "dark" } as const;

function dotClass(project: BoardProject, red: number): string {
  if (project.status === "died") return "park";
  if (project.status === "stopped") return "";
  if (red > 0) return "park";
  if (projectWorking(project) > 0) return "run pulse";
  if (project.state?.hold) return "wait";
  return project.state && project.state.runs.length > 0 ? "wait" : "";
}

function subline(project: BoardProject): string {
  if (project.status === "died") return "died unexpectedly";
  if (project.status === "stopped") return "stopped";
  if (!project.state) return project.connected ? "loading…" : "unreachable";
  if (project.state.hold?.reason === "auth") return "held - agent login expired";
  if (project.idle && project.state.runs.length === 0) return "idle — pick an Orchestration Issue";
  const runs = project.state.runs.length;
  const working = projectWorking(project);
  return `${runs} active run${runs === 1 ? "" : "s"}${working > 0 ? ` · ${working} working` : ""}`;
}

function projectRow(ui: BoardUi, project: BoardProject, attention: readonly AttentionEntry[]): string {
  const badge = attentionBadge(attention, project.id);
  const held = project.state?.hold !== undefined && badge.red === 0;
  const badges =
    (badge.red > 0 ? `<span class="badge" title="${badge.red} need attention">${badge.red}</span>` : "") +
    (badge.purple > 0 ? `<span class="badge purple" title="${badge.purple} ready for your merge">${badge.purple}</span>` : "") +
    (held ? `<span class="badge amber" title="held">held</span>` : "");
  return `<li><button${attrs({
    type: "button",
    class: "proj",
    "data-act": "select-project",
    "data-proj": project.id,
    "aria-current": project.id === ui.currentId,
  })}>
    <span class="dot ${dotClass(project, badge.red)}"></span>
    <span class="name">${esc(project.name)}${project.mode === "dry" ? " " + modeChip("dry") : ""}</span>
    <span class="badges">${badges}</span>
    <span class="hub">${esc(project.hub)}</span>
    <span class="sub">${esc(subline(project))}</span>
  </button></li>`;
}

function dashboardLink(ui: BoardUi): string {
  if (ui.scope !== "project") return "";
  const dashboard = ui.dashboard;
  if (dashboard?.up) {
    return `<a class="rail-link" href="${esc(dashboard.url)}">${icon("dash")}<span>Open dashboard</span></a>`;
  }
  const hint = dashboard?.up === false ? "Dashboard not running — start it with: sandcastle dashboard --detach" : "Checking for a Dashboard…";
  return `<span class="rail-link rail-hint" title="${esc(hint)}">${icon("dash")}<span>Dashboard<code>sandcastle dashboard</code></span></span>`;
}

export function renderRail(ui: BoardUi, attention: readonly AttentionEntry[]): string {
  const project = currentProject(ui);
  const working = ui.projects.reduce((sum, candidate) => sum + projectWorking(candidate), 0);
  const cap = ui.projects.reduce((sum, candidate) => sum + projectCap(candidate), 0);
  const totals =
    ui.scope === "dashboard"
      ? `${working}/${cap} agents working across ${ui.projects.length} project${ui.projects.length === 1 ? "" : "s"}`
      : `${working}/${cap} agents working`;
  const heading = ui.scope === "dashboard" ? "Projects" : "Project";
  return `
    <div class="brand">
      <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-castle"/></svg>
      <b>sandcastle</b>
    </div>
    <h2 id="proj-h">${heading}</h2>
    <ul class="projects" aria-labelledby="proj-h">${ui.projects.map((candidate) => projectRow(ui, candidate, attention)).join("")}</ul>
    <p class="rail-totals">${esc(totals)}</p>
    <div class="grow"></div>
    <div class="rail-foot">
      ${button("switch", ui.scope === "dashboard" ? "Switch project or run" : "Switch run", "search", "Ctrl K")}
      ${dashboardLink(ui)}
      ${project ? `<a class="rail-link" href="${esc(project.legacyHref)}">${icon("legacy")}<span>Legacy view</span></a>` : ""}
      <button type="button" class="rail-link" data-act="theme" aria-label="Theme: ${THEME_LABEL[ui.theme]}. Switch theme">${icon("theme")}<span>Theme</span><span class="kbd">${THEME_LABEL[ui.theme]}</span></button>
    </div>`;
}

function button(act: string, label: string, iconName: string, kbd: string): string {
  return `<button type="button" class="rail-link" data-act="${act}">${icon(iconName)}<span>${esc(label)}</span><span class="kbd">${esc(kbd)}</span></button>`;
}
