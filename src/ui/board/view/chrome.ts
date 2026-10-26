import { esc } from "../format.js";
import { runHint, type BoardProject } from "../model.js";
import { icon } from "./icons.js";
import type { BoardUi, Toast } from "./ui.js";

export interface SwitchTarget {
  projectId: string;
  runNumber: number | undefined;
  label: string;
  sub: string;
}

/** Projects and their runs matching the Ctrl K query, projects first within each group. */
export function switchTargets(projects: readonly BoardProject[], query: string): SwitchTarget[] {
  const needle = query.trim().toLowerCase();
  const targets: SwitchTarget[] = [];
  for (const project of projects) {
    targets.push({ projectId: project.id, runNumber: undefined, label: project.name, sub: project.hub });
    for (const run of project.state?.runs ?? []) {
      targets.push({
        projectId: project.id,
        runNumber: run.parent.number,
        label: `#${run.parent.number} ${run.parent.title}`,
        sub: `${project.name} · ${runHint(run)}`,
      });
    }
  }
  if (needle === "") return targets;
  return targets.filter((target) => `${target.label} ${target.sub}`.toLowerCase().includes(needle));
}

export function renderSwitcher(ui: BoardUi): string {
  const switcher = ui.switcher;
  if (!switcher) return "";
  const targets = switchTargets(ui.projects, switcher.query);
  const index = Math.min(switcher.index, Math.max(0, targets.length - 1));
  const rows = targets
    .map(
      (target, position) =>
        `<li role="option" aria-selected="${position === index}" class="${position === index ? "on" : ""}" data-act="switch-go" data-proj="${esc(target.projectId)}"${target.runNumber === undefined ? "" : ` data-run="${target.runNumber}"`}>
          <span class="sw-label">${target.runNumber === undefined ? icon("castle") : icon("branch")}${esc(target.label)}</span><span class="sw-sub">${esc(target.sub)}</span></li>`,
    )
    .join("");
  return `<div class="scrim" data-act="switcher-close"></div>
    <div class="switcher" role="dialog" aria-modal="true" aria-label="Switch project or run">
      <div class="sw-input">${icon("search")}<input type="text" data-focus="switcher-input" data-act="switcher-query" value="${esc(switcher.query)}" placeholder="Jump to a project or run…" aria-label="Filter projects and runs" autocomplete="off" aria-controls="sw-list" /></div>
      <ul id="sw-list" role="listbox">${rows || `<li class="none">Nothing matches.</li>`}</ul>
    </div>`;
}

export function renderToasts(toasts: readonly Toast[]): string {
  return toasts
    .map(
      (toast) =>
        `<div class="toast ${toast.tone}" role="${toast.tone === "error" ? "alert" : "status"}">${icon(toast.tone === "error" ? "alert" : "check")}<span>${esc(toast.message)}</span><button type="button" class="btn ghost sm icon" data-act="toast-dismiss" data-n="${toast.id}" aria-label="Dismiss">${icon("x")}</button></div>`,
    )
    .join("");
}
