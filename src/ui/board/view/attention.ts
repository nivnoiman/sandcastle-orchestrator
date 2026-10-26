import type { AttentionAction, AttentionEntry } from "../attention.js";
import { esc, formatCountdown } from "../format.js";
import { attrs } from "./html.js";
import { icon } from "./icons.js";
import type { BoardUi } from "./ui.js";

const ROW_ICON: Record<AttentionEntry["kind"], string> = {
  "auth-hold": "alert",
  parked: "alert",
  "verify-red": "alert",
  stall: "pause",
  quiet: "clock",
  "polish-reverted": "retry",
  "integration-ready": "pr",
  "rate-hold": "clock",
  "server-died": "alert",
};

const ACTION_ICON: Partial<Record<AttentionAction["id"], string>> = { retry: "retry", log: "log", restart: "retry", cancel: "x" };

function actionButton(entry: AttentionEntry, action: AttentionAction, primary: boolean): string {
  const cls = `btn sm ${primary ? "primary" : ""} ${action.id === "cancel" ? "danger" : ""}`.trim();
  const iconName = ACTION_ICON[action.id];
  const inner = `${iconName ? icon(iconName) : ""}${esc(action.label)}`;
  if (action.href) {
    return `<a${attrs({ class: cls, href: action.href, target: "_blank", rel: "noreferrer" })}>${inner}</a>`;
  }
  return `<button${attrs({
    type: "button",
    class: cls,
    "data-act": `att-${action.id}`,
    "data-proj": entry.projectId,
    "data-run": action.runNumber,
    "data-n": action.itemNumber,
  })}>${inner}</button>`;
}

function row(entry: AttentionEntry, currentId: string, nowMs: number): string {
  const other = entry.projectId !== currentId;
  const lastIndex = entry.actions.length - 1;
  const detail =
    entry.kind === "rate-hold" && entry.until
      ? `${esc(entry.detail)} Reopens <span data-until="${esc(entry.until)}">${esc(formatCountdown(entry.until, nowMs))}</span>.`
      : esc(entry.detail);
  const actions = entry.actions.map((action, index) => actionButton(entry, action, index === lastIndex && action.id !== "cancel")).join("");
  const goProject = other
    ? `<button type="button" class="btn sm ghost" data-act="select-project" data-proj="${esc(entry.projectId)}">Open project</button>`
    : "";
  return `<li class="alert ${entry.tone} k-${entry.kind} ${other ? "other" : ""}">
      ${icon(ROW_ICON[entry.kind])}
      <div class="alert-text">
        <div class="what"${other ? ` data-project="${esc(entry.projectName)}"` : ""}>${esc(entry.title)}${entry.runNumber !== undefined && entry.kind === "parked" ? `<span class="where">run #${entry.runNumber}</span>` : ""}</div>
        <div class="why">${detail}</div>
      </div>
      <div class="acts">${other ? goProject : actions}</div>
    </li>`;
}

export function renderAttention(ui: BoardUi, entries: readonly AttentionEntry[]): string {
  const own = entries.filter((entry) => entry.projectId === ui.currentId).length;
  const others = entries.length - own;
  if (entries.length === 0) {
    return `<section class="attention clear" aria-label="Needs attention"><p>${icon("check")}Nothing needs your attention.</p></section>`;
  }
  const count = ui.scope === "dashboard" || others > 0 ? `${own} here${others > 0 ? ` · ${others} in other projects` : ""}` : `${own}`;
  return `<section class="attention" aria-labelledby="att-h">
    <header><h2 id="att-h">${icon("alert")}Needs attention <span class="count">${count}</span></h2></header>
    <ul class="alerts">${entries.map((entry) => row(entry, ui.currentId, ui.nowMs)).join("")}</ul>
  </section>`;
}
