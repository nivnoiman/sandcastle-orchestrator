import { esc } from "../format.js";
import { runHint, type BoardProject } from "../model.js";
import { icon } from "./icons.js";
import type { BoardUi, DialogState, Toast } from "./ui.js";

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

const DIALOG_COPY: Record<DialogState["kind"], { heading: (n: number) => string; body: (dialog: DialogState) => string; confirm: string; busy: string }> = {
  requeue: {
    heading: (n) => `Re-queue #${n}?`,
    body: (dialog) =>
      `Sandcastle flips <code>ready-for-human</code> back to <code>ready-for-agent</code> on the issue and restarts the item${dialog.stage ? ` at <b>${esc(dialog.stage)}</b>` : ""}. If the cause is not fixed it will park again.`,
    confirm: "Re-queue",
    busy: "Re-queuing…",
  },
  hold: {
    heading: (n) => `Hold #${n}?`,
    body: () => "Hides this item from Needs Attention and the title badge. The item stays parked, its dependents stay blocked, and GitHub is not touched.",
    confirm: "Hold",
    busy: "Holding…",
  },
  comment: {
    heading: (n) => `Comment on #${n}`,
    body: () => "Posts this text as a comment on the GitHub issue. It does not change labels or restart the item.",
    confirm: "Post comment",
    busy: "Posting…",
  },
};

export function renderDialog(ui: BoardUi): string {
  const dialog = ui.dialog;
  if (!dialog) return "";
  const copy = DIALOG_COPY[dialog.kind];
  const done = dialog.result?.ok === true;
  const field =
    dialog.kind === "comment" && !done
      ? `<textarea data-focus="dialog-text" data-act="dialog-text" rows="5" maxlength="4000" placeholder="e.g. Config change reviewed, it is fine. Retry." aria-label="Comment text">${esc(dialog.text)}</textarea>`
      : "";
  const outcome = dialog.result
    ? `<p class="dlg-result ${dialog.result.ok ? "ok" : "err"}" role="${dialog.result.ok ? "status" : "alert"}">${icon(dialog.result.ok ? "check" : "alert")}${esc(dialog.result.message)}</p>`
    : "";
  const canConfirm = !dialog.busy && !(dialog.kind === "comment" && dialog.text.trim() === "");
  const buttons = done
    ? `<button type="button" class="btn primary" data-act="dialog-close" data-focus="dialog-close">Close</button>`
    : `<button type="button" class="btn ghost" data-act="dialog-close">Cancel</button>
       <button type="button" class="btn primary" data-act="dialog-confirm" data-focus="dialog-confirm"${canConfirm ? "" : " disabled"}>${dialog.busy ? copy.busy : copy.confirm}</button>`;
  return `<div class="scrim" data-act="dialog-close"></div>
    <div class="dialog" role="dialog" aria-modal="true" aria-label="${esc(copy.heading(dialog.itemNumber))}">
      <h3>${esc(copy.heading(dialog.itemNumber))}</h3>
      <p class="dlg-item">${esc(dialog.title)}</p>
      ${done ? "" : `<p>${copy.body(dialog)}</p><pre class="nh-reason">${esc(dialog.reason)}</pre>`}
      ${field}
      ${outcome}
      <div class="dlg-acts">${buttons}</div>
    </div>`;
}
