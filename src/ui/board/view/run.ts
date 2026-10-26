import type { UiHold, UiItem, UiRun } from "../../state.js";
import { esc, formatCountdown, formatClock, formatQuiet } from "../format.js";
import {
  BUCKETS,
  bucketCounts,
  groupByColumn,
  lifecycleSteps,
  runGates,
  runHint,
  type BoardProject,
  type LifecycleStep,
} from "../model.js";
import { attrs, button, externalLink, meter, tag } from "./html.js";
import { icon } from "./icons.js";
import type { BoardUi } from "./ui.js";

const PHASE_DOT: Record<UiItem["phase"], string> = {
  running: "run pulse",
  awaiting: "run",
  waiting: "wait",
  parked: "park",
  done: "done",
  held: "",
  blocked: "wait",
  queued: "",
};

const PHASE_LABEL: Record<UiItem["phase"], string> = {
  running: "Running",
  awaiting: "Awaiting",
  waiting: "Waiting",
  parked: "Parked",
  done: "Merged",
  held: "Held",
  blocked: "Blocked",
  queued: "Queued",
};

const CARD_TONE: Partial<Record<UiItem["phase"], string>> = {
  parked: "park",
  waiting: "wait",
  held: "held",
  blocked: "blocked",
  queued: "queued",
};

/** `owner/repo#12` from a pull request url; `PR #12` or "pull request" for other shapes. */
export function prLabel(url: string): string {
  const match = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
  if (match) return `${match[1]}#${match[2]}`;
  const number = /\/pull\/(\d+)/.exec(url);
  return number ? `PR #${number[1]}` : "pull request";
}

function untilSpan(untilIso: string, nowMs: number): string {
  return `<span data-until="${esc(untilIso)}">${esc(formatCountdown(untilIso, nowMs))}</span>`;
}

export function holdText(hold: UiHold, nowMs: number): string {
  if (hold.reason === "auth") {
    return "<b>Held</b> — agent credentials rejected. No new stages start; sandcastle keeps re-probing them.";
  }
  if (!hold.until) return "<b>Held</b> — five-hour usage limit. No new stages start.";
  return `<b>Held</b> — usage window reopens ${untilSpan(hold.until, nowMs)} (${esc(new Date(hold.until).toLocaleTimeString())}). No new stages start.`;
}

function waitingNote(item: UiItem, nowMs: number): string {
  if (item.waitReason === "auth") return "Waiting — agent credentials rejected; re-probed every poll.";
  const kind = item.waitReason === "transient" ? "Transient API failure" : "Usage limit reached";
  if (!item.resumeAt) return item.waitReason === "transient" ? `${kind} — retrying on its own.` : `${kind}.`;
  return `${kind} — resumes ${untilSpan(item.resumeAt, nowMs)}.`;
}

function cardNote(item: UiItem, nowMs: number): string {
  if (item.phase === "waiting") return waitingNote(item, nowMs);
  if (item.parkReason) return esc(item.parkReason);
  return "";
}

function waitsOn(item: UiItem): string {
  if (item.blockers.length === 0) return "";
  const chips = item.blockers
    .map((blocker) => `<button${attrs({ type: "button", class: "chip", "data-act": "jump", "data-n": blocker, title: `Jump to #${blocker}` })}>#${blocker}</button>`)
    .join("");
  return `<div class="waits"><span>waits on</span>${chips}</div>`;
}

function clockFor(item: UiItem, nowMs: number): string {
  if (item.phase === "queued" || item.phase === "blocked" || item.phase === "done") return "";
  return `<span class="clock" data-since="${esc(item.phaseSince)}" title="Phase Clock: time since this item last changed phase or stage">${esc(formatClock(item.phaseSince, nowMs))}</span>`;
}

export function cardId(projectId: string, run: number, item: number): string {
  return `card-${projectId}-${run}-${item}`;
}

function itemCard(ui: BoardUi, project: BoardProject, run: UiRun, item: UiItem): string {
  const runNumber = run.parent.number;
  const label = item.phase === "held" || item.phase === "blocked" || item.phase === "queued" || !item.stage ? PHASE_LABEL[item.phase] : `${PHASE_LABEL[item.phase]} · ${item.stage}`;
  const selected = ui.drawer?.kind === "item" && ui.drawer.projectId === project.id && ui.drawer.itemNumber === item.number;
  const id = cardId(project.id, runNumber, item.number);
  const actions = [button({ label: "Log", cls: "sm ghost", icon: "log", data: { "data-act": "open-item", "data-proj": project.id, "data-run": runNumber, "data-n": item.number } })];
  if (item.phase === "running") actions.push(button({ label: "Cancel", cls: "sm danger", data: { "data-act": "cancel", "data-proj": project.id, "data-n": item.number } }));
  if (item.phase === "parked" || item.phase === "waiting") {
    actions.push(button({ label: "Retry", cls: "sm", icon: "retry", data: { "data-act": "retry", "data-proj": project.id, "data-n": item.number } }));
  }
  const note = cardNote(item, ui.nowMs);
  const quiet = item.quiet ? `<span class="quiet-mark" title="No agent output for a while; the idle timeout parks the item">${esc(formatQuiet(item.quiet))}</span>` : "";
  const rework = item.reworkRound > 0 ? `<span class="tag wait" title="Rework round">rework ${item.reworkRound}/${item.reworkLimit}</span>` : "";
  return `<article${attrs({
    id,
    class: `card ${CARD_TONE[item.phase] ?? ""} ${selected ? "selected" : ""} ${ui.flash === id ? "flash" : ""}`.replace(/\s+/g, " ").trim(),
    "data-card": item.number,
    "data-proj": project.id,
    "data-run": runNumber,
  })}>
    <div class="top"><a href="${esc(item.issueUrl)}" target="_blank" rel="noreferrer">#${item.number}</a>${rework}<span class="repo">${esc(item.repo)}</span></div>
    <div class="ttl">${esc(item.title)}</div>
    <div class="st"><span class="dot ${PHASE_DOT[item.phase]}"></span>${esc(label)}${quiet}${clockFor(item, ui.nowMs)}</div>
    ${waitsOn(item)}
    ${note ? `<div class="note">${note}</div>` : ""}
    <div class="acts">${actions.join("")}</div>
  </article>`;
}

function mergedColumn(ui: BoardUi, project: BoardProject, run: UiRun, items: readonly UiItem[]): string {
  if (items.length === 0) return `<div class="empty">Nothing merged yet</div>`;
  const key = `${project.id}:${run.parent.number}`;
  const open = ui.doneOpen.has(key);
  const shown = open ? items : items.slice(-2);
  const rows = shown
    .map((item) => {
      const pr = item.pullRequestUrl ? externalLink(item.pullRequestUrl, esc(prLabel(item.pullRequestUrl))) : "";
      return `<li><a href="${esc(item.issueUrl)}" target="_blank" rel="noreferrer">#${item.number}</a><span>${esc(item.title)}</span>${pr}</li>`;
    })
    .join("");
  return `<button${attrs({ type: "button", class: "done-fold", "data-act": "fold", "data-proj": project.id, "data-run": run.parent.number, "aria-expanded": open })}>${icon("check")}${items.length} merged<span class="fold-state">${open ? "Hide" : "Show"}</span></button>
    <ul class="done-list">${rows}</ul>`;
}

function pipeline(ui: BoardUi, project: BoardProject, run: UiRun): string {
  const stages = project.state?.stages ?? [];
  const columns = groupByColumn(run.items, stages);
  const furthest = Math.max(0, ...stages.map((stage, index) => ((columns.get(stage)?.length ?? 0) > 0 ? index : 0)));
  const cols = stages
    .map((stage, index) => {
      const items = columns.get(stage) ?? [];
      const isLast = index === stages.length - 1;
      const nodeClass = items.length === 0 ? "" : isLast ? "has-done" : items.some((item) => item.phase === "parked") ? "has-park" : "has";
      const body = isLast
        ? mergedColumn(ui, project, run, items)
        : items.length > 0
          ? items.map((item) => itemCard(ui, project, run, item)).join("")
          : `<div class="empty">—</div>`;
      return `<section class="col" aria-label="${esc(stage)}"><div class="col-head ${index > 0 && index <= furthest ? "reached" : ""}"><span class="node ${nodeClass}"></span><h4>${esc(stage)}</h4><span class="n">${items.length}</span></div><div class="stack">${body}</div></section>`;
    })
    .join("");
  return `<div class="pipe-wrap"><div class="pipe" style="--cols:${stages.length}">${cols}</div></div>`;
}

function stepMarkup(step: LifecycleStep): string {
  return `<li class="step ${step.state}" title="${esc(step.detail)}"><span class="step-node" aria-hidden="true"></span><span class="step-label">${esc(step.label)}</span><span class="step-detail">${esc(step.detail)}</span></li>`;
}

function prLinks(urls: readonly string[]): string {
  if (urls.length === 0) return "";
  return `<div class="pr-links">${urls.map((url) => externalLink(url, `${icon("pr")}${esc(prLabel(url))}`)).join("")}</div>`;
}

function gateCards(run: UiRun, mode: BoardProject["mode"]): string {
  const { featureVerify: verify, polish } = runGates(run, mode);
  const verifyTone = { running: "run", fixing: "wait", waiting: "wait", green: "done", red: "park", skipped: "", idle: "" }[verify.phase];
  const polishTone = { running: "run", green: "done", reverted: "wait", skipped: "", idle: "" }[polish.phase];
  const round = verify.rework ? `<div class="gd">Fix round ${verify.rework.round}/${verify.rework.limit}</div>` : "";
  const scenarios =
    verify.phase === "idle" || verify.phase === "skipped"
      ? ""
      : `<div class="scen"><span><b>${verify.counts.pass}</b> pass</span><span class="f"><b>${verify.counts.fail}</b> fail</span><span><b>${verify.counts.requiresStg}</b> requires-STG</span></div>`;
  const verifyText = verify.reason ?? (verify.phase === "idle" ? `Starts when all ${run.items.length} items merge into ${run.parent.integrationBranch}.` : "");
  const polishText = polish.reason ?? (polish.phase === "idle" ? "Runs after Feature Verify is green." : "");
  return `<div class="gates">
    <div class="gate ${verify.phase}"><div class="gh">Feature Verify${tag(verify.phase, verifyTone)}</div>${scenarios}${round}${verifyText ? `<div class="gd">${esc(verifyText)}</div>` : ""}${prLinks(verify.pullRequests)}</div>
    <div class="gate ${polish.phase}"><div class="gh">Polish${tag(polish.phase, polishTone)}</div>${polishText ? `<div class="gd">${esc(polishText)}</div>` : ""}${prLinks(polish.pullRequests)}</div>
  </div>`;
}

function banners(run: UiRun, nowMs: number): string {
  const out: string[] = [];
  if (run.stalled) {
    const { parked, held, blocked } = run.stalled;
    out.push(`<div class="banner park">${icon("pause")}<span class="grow"><b>Stalled</b> — ${parked} parked, ${held} held, ${blocked} blocked. Nothing advances until you retry a parked item or clear a hold.</span></div>`);
  }
  if (run.hold) out.push(`<div class="banner wait">${icon("clock")}<span class="grow">${holdText(run.hold, nowMs)}</span></div>`);
  return out.join("");
}

function runBar(project: BoardProject, run: UiRun): string {
  const number = run.parent.number;
  const data = { "data-proj": project.id, "data-run": number };
  return `<div class="runbar">
      <div class="title">
        <h3>${externalLink(run.parent.url, `#${number} ${esc(run.parent.title)}`)}${run.paused ? tag("paused", "wait") : ""}</h3>
        <span class="branch mono">${icon("branch")}${esc(run.parent.integrationBranch)}</span>
      </div>
      <div class="ctrl">
        <span class="workers">${meter(run.running, run.cap)}<strong>${run.running}/${run.cap}</strong> workers</span>
        <label class="field">Run Cap <input${attrs({ type: "number", min: 1, value: run.cap, "aria-label": "Run Cap", "data-act": "run-cap", "data-focus": `run-cap-${number}`, ...data })} /></label>
        <span class="sep"></span>
        ${button({ label: run.paused ? "Resume new starts" : "Pause new starts", icon: run.paused ? "play" : "pause", disabled: !run.started || run.settled, data: { "data-act": run.paused ? "run-resume" : "run-pause", ...data } })}
        ${button({ label: "Stop run", icon: "stop", cls: "danger", disabled: run.settled, data: { "data-act": "run-stop", ...data } })}
      </div>
    </div>`;
}

function progress(run: UiRun): string {
  const counts = bucketCounts(run.items);
  const total = run.items.length;
  const segments = BUCKETS.filter((bucket) => counts[bucket] > 0)
    .map((bucket) => `<span class="${bucket}" style="flex:${counts[bucket]}"></span>`)
    .join("");
  return `<div class="progress">
      <div class="bar" role="img" aria-label="${counts.done} of ${total} merged">${segments}</div>
      <div class="legend">
        <span><b>${counts.done}/${total}</b> merged</span>
        <span><i class="dot run"></i><b>${counts.run}</b> running</span>
        <span><i class="dot wait"></i><b>${counts.wait}</b> waiting / blocked</span>
        <span><i class="dot park"></i><b>${counts.park}</b> parked</span>
        <span><i class="dot"></i><b>${counts.idle}</b> queued / held</span>
      </div>
    </div>`;
}

export function renderRunTabs(ui: BoardUi, project: BoardProject, selected: UiRun | undefined): string {
  const state = project.state;
  if (!state || state.runs.length === 0) return "";
  const tabs = state.runs
    .map((run) => {
      const counts = bucketCounts(run.items);
      const needsAttention =
        counts.park > 0 || run.stalled !== undefined || run.featureVerify.phase === "red" || run.polish.phase === "reverted" || run.items.some((item) => item.quiet);
      const dot = needsAttention ? "park" : run.running > 0 ? "run pulse" : "wait";
      const active = run.parent.number === selected?.parent.number;
      return `<button${attrs({ type: "button", class: "tab", role: "tab", "data-act": "select-run", "data-proj": project.id, "data-run": run.parent.number, "aria-selected": active, tabindex: active ? undefined : -1 })}>
        <span class="t"><span class="dot ${dot}"></span>#${run.parent.number} ${esc(run.parent.title)}</span>
        <span class="s">${esc(runHint(run))} · ${counts.done}/${run.items.length} merged${needsAttention ? " · needs attention" : ""}</span></button>`;
    })
    .join("");
  return `<div class="runs-head"><div class="tabs" role="tablist" aria-label="Active runs">${tabs}</div></div>`;
}

export function renderRunPanel(ui: BoardUi, project: BoardProject, run: UiRun): string {
  const steps = lifecycleSteps(run, project.mode);
  return `<div class="runpanel" role="tabpanel">
    ${runBar(project, run)}
    <ol class="lifecycle" aria-label="Run Lifecycle">${steps.map(stepMarkup).join("")}</ol>
    ${progress(run)}
    ${banners(run, ui.nowMs)}
    ${gateCards(run, project.mode)}
    ${pipeline(ui, project, run)}
  </div>`;
}
