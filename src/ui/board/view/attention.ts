import type { AttentionAction, AttentionEntry } from "../attention.js";
import { esc, formatClock, formatCountdown } from "../format.js";
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

const ACTION_ICON: Partial<Record<AttentionAction["id"], string>> = { requeue: "retry", log: "log", restart: "retry", cancel: "x", hold: "pause" };

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

function safeHref(url: string): string {
  return /^https?:\/\//i.test(url) ? url : "#";
}

function parkedCard(entry: AttentionEntry, nowMs: number): string {
  const park = entry.park;
  if (!park) return "";
  const lastIndex = entry.actions.length - 1;
  const actions = entry.actions.map((action, index) => actionButton(entry, action, index === lastIndex)).join("");
  const stage = park.stage ? `<span class="chip">stage <b>${esc(park.stage)}</b></span>` : "";
  const since = park.since ? `<span class="chip">parked ${esc(formatClock(park.since, nowMs))} ago</span>` : "";
  const run = entry.runNumber === undefined ? "" : `<span class="chip">run #${entry.runNumber}</span>`;
  const pr = park.pullRequestUrl ? `<a class="chip link" href="${esc(safeHref(park.pullRequestUrl))}" target="_blank" rel="noreferrer">PR</a>` : "";
  return `<li class="alert red k-parked needs-human" data-key="${esc(entry.key)}">
      <div class="nh-head">${icon("alert")}<div class="nh-title">${esc(entry.title)}</div></div>
      <div class="nh-meta">${stage}${run}${since}${pr}<a class="chip link" href="${esc(safeHref(park.issueUrl))}" target="_blank" rel="noreferrer">Issue</a></div>
      <div class="nh-label">Why it stopped</div>
      <pre class="nh-reason">${esc(park.reason)}</pre>
      <p class="nh-help">Re-queue flips <code>ready-for-human</code> back to <code>ready-for-agent</code> and restarts the item. Until then its dependents stay blocked. Hold only hides this banner; GitHub is untouched.</p>
      <div class="acts">${actions}</div>
    </li>`;
}

function row(entry: AttentionEntry, currentId: string, nowMs: number): string {
  const other = entry.projectId !== currentId;
  if (entry.kind === "parked" && !other) return parkedCard(entry, nowMs);
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
  const heldHere = ui.held.filter((entry) => entry.projectId === ui.currentId);
  const heldLine = heldHere.length
    ? `<p class="held-line">${heldHere.length} on hold: ${heldHere.map((entry) => `<button type="button" class="btn sm ghost" data-act="att-unhold" data-key="${esc(entry.key)}" title="Show this banner again">#${entry.itemNumber} ${icon("retry")}Unhold</button>`).join(" ")}</p>`
    : "";
  if (entries.length === 0) {
    return `<section class="attention clear" aria-label="Needs attention"><p>${icon("check")}Nothing needs your attention.</p>${heldLine}</section>`;
  }
  const notifyButton =
    ui.notifyPermission === "default"
      ? `<button type="button" class="btn sm ghost" data-act="notify-enable">${icon("alert")}Enable desktop alerts</button>`
      : "";
  const count = ui.scope === "dashboard" || others > 0 ? `${own} here${others > 0 ? ` · ${others} in other projects` : ""}` : `${own}`;
  return `<section class="attention" aria-labelledby="att-h">
    <header><h2 id="att-h">${icon("alert")}Needs attention <span class="count">${count}</span></h2>${notifyButton}</header>
    <ul class="alerts">${entries.map((entry) => row(entry, ui.currentId, ui.nowMs)).join("")}</ul>
    ${heldLine}
  </section>`;
}
