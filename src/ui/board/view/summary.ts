import type { SummaryResult } from "../../summary.js";
import type { UiItem, UiRun } from "../../state.js";
import { esc, formatClock } from "../format.js";
import { webUrl } from "../model.js";
import { attrs, button, tag } from "./html.js";
import type { ChangesState } from "./changes.js";
import { icon } from "./icons.js";
import { prLabel } from "./run.js";

/** State of the drawer's Summary tab; fetched on demand, never part of the polled state. */
export interface SummaryState {
  status: "idle" | "loading" | "ready" | "error";
  /** Attempt ids and outcomes the data was loaded for; a change means the recap is stale. */
  key: string;
  data: SummaryResult | undefined;
  error: string | undefined;
  /** Bumped per load; responses from an older load are dropped. */
  generation: number;
}

export function emptySummary(): SummaryState {
  return { status: "idle", key: "", data: undefined, error: undefined, generation: 0 };
}

export interface SummaryAttempt {
  id: string;
  stage: string;
  attempt: number;
  outcome: string | undefined;
  live: boolean;
  startedAt: string;
  endedAt?: string | undefined;
}

export type SummarySubject = { kind: "item"; item: UiItem; run: UiRun | undefined } | { kind: "feature"; run: UiRun } | undefined;

export interface SummaryView {
  subject: SummarySubject;
  attempts: SummaryAttempt[];
  /** Attempts were fetched (an empty list is then final). */
  attemptsLoaded: boolean;
  summary: SummaryState;
  changes: ChangesState | undefined;
  /** Dashboard chain: queued, every configured stage, merged. */
  stages: string[];
  nowMs: number;
}

function spanMs(attempt: SummaryAttempt, nowMs: number): number {
  const start = Date.parse(attempt.startedAt);
  const end = attempt.endedAt === undefined ? nowMs : Date.parse(attempt.endedAt);
  return Number.isNaN(start) || Number.isNaN(end) ? 0 : Math.max(0, end - start);
}

function lengthOf(ms: number, nowMs: number): string {
  return ms <= 0 ? "" : formatClock(new Date(nowMs - ms).toISOString(), nowMs);
}

function section(title: string, body: string): string {
  return `<section class="sm-sec"><h3>${title}</h3>${body}</section>`;
}

function outcomeTone(attempt: SummaryAttempt): string {
  if (attempt.live) return "run";
  return attempt.outcome === "success" ? "done" : "park";
}

function attemptCount(count: number): string {
  return count === 0 ? "" : `<span class="mono" title="Agent attempts of this stage">${count} attempt${count === 1 ? "" : "s"}</span>`;
}

function whatSection(view: SummaryView): string {
  const { subject, summary } = view;
  if (!subject) return "";
  const parent = subject.kind === "feature" ? subject.run.parent : undefined;
  const title = subject.kind === "item" ? subject.item.title : subject.run.parent.title;
  const issueUrl = subject.kind === "item" ? subject.item.issueUrl : subject.run.parent.url;
  const number = subject.kind === "item" ? subject.item.number : subject.run.parent.number;
  const link = webUrl(issueUrl) ? `<a href="${esc(issueUrl)}" target="_blank" rel="noreferrer">#${number}</a>` : `#${number}`;
  const rows = [`<dt>Title</dt><dd>${link} ${esc(title)}</dd>`];
  if (subject.kind === "item") {
    rows.push(`<dt>Repo</dt><dd>${esc(subject.item.repo)}</dd>`);
    rows.push(`<dt>Branch</dt><dd class="mono">${esc(subject.item.branch)}${subject.run ? ` → ${esc(subject.run.parent.integrationBranch)}` : ""}</dd>`);
  } else if (parent) {
    rows.push(`<dt>Feature</dt><dd>${esc(parent.feature)}</dd>`);
    rows.push(`<dt>Branch</dt><dd class="mono">${esc(parent.integrationBranch)}</dd>`);
  }
  const task = summary.data?.task;
  let taskBlock = "";
  if (task !== undefined) {
    taskBlock = `<div class="sm-task" tabindex="0" role="group" aria-label="Task text">${esc(task)}${summary.data?.taskClipped ? '<span class="muted"> (shortened)</span>' : ""}</div>`;
  } else if (summary.status === "ready") {
    taskBlock = '<p class="muted">No task text is available on the server for this item.</p>';
  }
  return section("What", `<dl class="sm-kv">${rows.join("")}</dl>${taskBlock}`);
}

function stageRow(stage: string, current: string | undefined, attempts: SummaryAttempt[], nowMs: number): string {
  const mine = attempts.filter((attempt) => attempt.stage === stage);
  const last = mine.at(-1);
  const total = mine.reduce((sum, attempt) => sum + spanMs(attempt, nowMs), 0);
  let state = '<span class="muted">no agent attempt</span>';
  if (last) state = tag(last.live ? "running" : (last.outcome ?? "?"), outcomeTone(last));
  else if (stage === current) state = tag("current", "run");
  const clock = lengthOf(total, nowMs);
  return `<li class="sm-stage${stage === current ? " current" : ""}"><span class="t">${esc(stage)}</span>${state}${attemptCount(mine.length)}${clock ? `<span class="mono" title="Total agent time in this stage">${esc(clock)}</span>` : ""}</li>`;
}

const STEP_TONE: Record<string, string> = { running: "run", done: "done", red: "park", waiting: "wait", reverted: "wait" };

function statusSection(view: SummaryView): string {
  const { subject, attempts, nowMs } = view;
  if (!subject) return "";
  if (subject.kind === "feature") {
    const rows = subject.run.lifecycle
      .map((step) => {
        const model = step.agent?.model ? `<span class="d-model mono">${esc(step.agent.model)}</span>` : "";
        const reason = step.reason ? `<span class="why">${esc(step.reason)}</span>` : "";
        return `<li class="sm-stage"><span class="t">${esc(step.label)}</span>${tag(step.phase, STEP_TONE[step.phase] ?? "")}${model}${attemptCount(attempts.filter((attempt) => attempt.stage === step.stage).length)}${reason}</li>`;
      })
      .join("");
    return section("Status", `<ul class="sm-stages">${rows}</ul>`);
  }
  const { item } = subject;
  const chain = view.stages.filter((stage) => stage !== "queued" && stage !== "merged");
  const tone = item.phase === "parked" ? "park" : item.phase === "done" ? "done" : item.phase === "running" ? "run" : "wait";
  const model = item.agent?.model ? `<span class="d-model mono" title="Agent model of the current stage">${esc(item.agent.model)}</span>` : "";
  const rework = item.reworkRound > 0 ? `<span title="Rework rounds used of the limit">Rework ${item.reworkRound}/${item.reworkLimit}</span>` : "";
  const head = `<div class="sm-line">${tag(`${item.phase}${item.stage ? ` · ${item.stage}` : ""}`, tone)}<span class="mono" title="Time in this phase">${esc(formatClock(item.phaseSince, nowMs))}</span>${model}${rework}</div>`;
  const reason = item.parkReason ? `<div class="d-reason"><b>Parked:</b> ${esc(item.parkReason)}</div>` : "";
  const rows = chain.map((stage) => stageRow(stage, item.stage, attempts, nowMs)).join("");
  return section("Status", `${head}${reason}<ul class="sm-stages">${rows}</ul>`);
}

function attemptCard(attempt: SummaryAttempt, view: SummaryView): string {
  const { summary, nowMs } = view;
  const tail = summary.data?.attempts.find((candidate) => candidate.id === attempt.id);
  let body: string;
  if (attempt.live) body = '<p class="muted">Still running; see the Log tab.</p>';
  else if (tail?.message !== undefined) body = `<div class="sm-msg" tabindex="0" role="group" aria-label="Last agent message of ${esc(attempt.stage)} attempt ${attempt.attempt}">${esc(tail.message)}${tail.clipped ? '<span class="muted"> (shortened)</span>' : ""}</div>`;
  else if (summary.status === "ready") body = '<p class="muted">No agent message in this attempt\'s log.</p>';
  else body = summary.status === "error" ? "" : '<p class="muted">Loading…</p>';
  const length = lengthOf(spanMs(attempt, nowMs), nowMs);
  return `<li class="sm-att"><div class="sm-att-head"><span class="t">${esc(attempt.stage)} #${attempt.attempt}</span>${tag(attempt.live ? "running" : (attempt.outcome ?? "?"), outcomeTone(attempt))}${length ? `<span class="mono">${esc(length)}</span>` : ""}</div>${body}</li>`;
}

function outcomesSection(view: SummaryView): string {
  if (view.attempts.length === 0) {
    return section("Outcome per stage", `<p class="muted">${view.attemptsLoaded ? "No agent attempt has been recorded yet." : "Loading…"}</p>`);
  }
  return section("Outcome per stage", `<ol class="sm-atts">${view.attempts.map((attempt) => attemptCard(attempt, view)).join("")}</ol>`);
}

function filesMarkup(changes: ChangesState | undefined): string {
  if (changes?.status === "ready" && changes.data) {
    const { totals } = changes.data;
    return `<span title="Files changed against ${esc(changes.data.base)}">${totals.files} file${totals.files === 1 ? "" : "s"} changed <span class="df-counts mono"><span class="p">+${totals.additions}</span> <span class="m">−${totals.deletions}</span></span></span>`;
  }
  if (changes?.status === "loading") return '<span class="muted">Loading changes…</span>';
  const error = changes?.status === "error" ? `<span class="muted">${esc(changes.error ?? "could not load")}</span>` : "";
  return `${error}${button({ label: "Load file counts", cls: "ghost", data: { "data-act": "summary-load-changes" } })}`;
}

function resultSection(view: SummaryView): string {
  const { subject } = view;
  if (!subject) return "";
  const urls = subject.kind === "item" ? [subject.item.pullRequestUrl ?? ""] : [...subject.run.featureVerify.pullRequests, ...subject.run.polish.pullRequests];
  const links = urls
    .filter((url) => webUrl(url))
    .map((url) => `<a class="btn" href="${esc(url)}" target="_blank" rel="noreferrer">${icon("pr")}${esc(prLabel(url))}</a>`)
    .join("");
  const blockers = subject.kind === "item" && subject.item.blockers.length > 0 ? `<span>Blocked by ${subject.item.blockers.map((number) => `#${number}`).join(", ")}</span>` : "";
  return section("Result", `<div class="sm-line">${links || '<span class="muted">No pull request yet.</span>'}${filesMarkup(view.changes)}${blockers}</div>`);
}

export function renderSummary(view: SummaryView): string {
  if (!view.subject) return '<div class="sm"><p class="muted">This item is no longer in the run.</p></div>';
  const { summary } = view;
  const failure = summary.status === "error" ? `<div class="d-reason"><b>Could not load the recap:</b> ${esc(summary.error ?? "unknown error")}</div>` : "";
  const refresh = button({ label: summary.status === "loading" ? "Refreshing…" : "Refresh", icon: "retry", cls: "ghost", disabled: summary.status === "loading", data: { "data-act": "summary-refresh" } });
  return `<div class="sm"${attrs({ role: "tabpanel", "aria-labelledby": "d-tab-summary" })}><div class="sm-bar">${refresh}</div>${failure}${whatSection(view)}${statusSection(view)}${outcomesSection(view)}${resultSection(view)}</div>`;
}
