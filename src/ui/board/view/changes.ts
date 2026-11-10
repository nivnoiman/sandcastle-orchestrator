import type { ChangesResult } from "../../changesRoutes.js";
import type { DiffFile, DiffHunk, DiffLine } from "../../changes/diff.js";
import { esc } from "../format.js";
import { isMarkdownPath, markdownToHtml } from "../mdPreview.js";
import { attrs, button } from "./html.js";
import { icon } from "./icons.js";

export type ChangesLayout = "unified" | "split";

export interface FilePreview {
  status: "loading" | "ready" | "error";
  text: string;
  note: string;
}

/** State of the drawer's Changes tab; the diff is fetched on demand and never part of the polled state. */
export interface ChangesState {
  status: "idle" | "loading" | "ready" | "error";
  data: ChangesResult | undefined;
  error: string | undefined;
  filter: string;
  layout: ChangesLayout;
  /** Paths whose diff is folded. */
  collapsed: string[];
  showGenerated: boolean;
  /** Markdown files shown rendered instead of as a diff. */
  previewing: string[];
  previews: Record<string, FilePreview>;
  /** Bumped per diff load; responses from an older load are dropped. */
  generation: number;
}

export function emptyChanges(): ChangesState {
  return { status: "idle", data: undefined, error: undefined, filter: "", layout: "unified", collapsed: [], showGenerated: false, previewing: [], previews: {}, generation: 0 };
}

const STATUS_LABEL: Record<DiffFile["status"], string> = { A: "Added", M: "Modified", D: "Removed", R: "Renamed" };
const STATUS_TONE: Record<DiffFile["status"], string> = { A: "add", M: "mod", D: "del", R: "ren" };
const SOURCE_LABEL: Record<ChangesResult["source"], string> = {
  worktree: "live worktree (includes uncommitted edits)",
  branch: "committed branch",
  "pull-request": "pull request",
};

export function fileId(path: string): string {
  let hash = 5381;
  for (let index = 0; index < path.length; index += 1) hash = (Math.imul(hash, 33) ^ path.charCodeAt(index)) >>> 0;
  return `df-${path.replace(/[^A-Za-z0-9]+/g, "-")}-${hash.toString(36)}`;
}

export function matchesFilter(file: DiffFile, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  if (needle === "") return true;
  return file.path.toLowerCase().includes(needle) || (file.oldPath?.toLowerCase().includes(needle) ?? false);
}

function counts(additions: number, deletions: number): string {
  return `<span class="df-counts mono"><span class="p">+${additions}</span> <span class="m">−${deletions}</span></span>`;
}

function statusChip(file: DiffFile): string {
  return `<span class="df-st ${STATUS_TONE[file.status]}" title="${STATUS_LABEL[file.status]}" aria-label="${STATUS_LABEL[file.status]}">${file.status}</span>`;
}

function summary(file: DiffFile): string {
  return file.status === "R" && file.oldPath ? `${esc(file.oldPath)} → ${esc(file.path)}` : esc(file.path);
}

function overview(data: ChangesResult, visible: DiffFile[]): string {
  const rows = visible
    .map(
      (file) =>
        `<li><button${attrs({ type: "button", class: "df-row", "data-act": "changes-jump", "data-path": file.path, title: `${STATUS_LABEL[file.status]}: ${file.path}` })}>${statusChip(file)}<span class="df-path mono">${summary(file)}</span>${file.binary ? '<span class="df-note">binary</span>' : counts(file.additions, file.deletions)}</button></li>`,
    )
    .join("");
  return `<ul class="df-list" aria-label="Changed files">${rows || '<li class="muted df-none">No file matches the filter.</li>'}</ul>`;
}

function unifiedRow(line: DiffLine): string {
  if (line.kind === "note") return `<tr class="l note"><td class="n"></td><td class="n"></td><td class="c">${esc(line.text)}</td></tr>`;
  const sign = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
  return `<tr class="l ${line.kind}"><td class="n">${line.old ?? ""}</td><td class="n">${line.new ?? ""}</td><td class="c"><span class="sg" aria-hidden="true">${sign}</span>${esc(line.text)}</td></tr>`;
}

interface SplitPair {
  left: DiffLine | undefined;
  right: DiffLine | undefined;
}

export function splitPairs(lines: DiffLine[]): SplitPair[] {
  const pairs: SplitPair[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line) break;
    if (line.kind === "ctx" || line.kind === "note") {
      pairs.push({ left: line, right: line });
      index += 1;
      continue;
    }
    const removed: DiffLine[] = [];
    const added: DiffLine[] = [];
    while (lines[index]?.kind === "del") removed.push(lines[index++] as DiffLine);
    while (lines[index]?.kind === "add") added.push(lines[index++] as DiffLine);
    for (let row = 0; row < Math.max(removed.length, added.length); row += 1) pairs.push({ left: removed[row], right: added[row] });
  }
  return pairs;
}

function splitCells(line: DiffLine | undefined, side: "old" | "new"): string {
  if (!line) return '<td class="n empty"></td><td class="c empty"></td>';
  const { kind } = line;
  return `<td class="n ${kind}">${line[side] ?? ""}</td><td class="c ${kind}">${esc(line.text)}</td>`;
}

function hunkMarkup(hunk: DiffHunk, layout: ChangesLayout): string {
  const head = `<tr class="l hunk"><td class="c" colspan="${layout === "split" ? 4 : 3}">${esc(hunk.header)}</td></tr>`;
  if (layout === "unified") return head + hunk.lines.map(unifiedRow).join("");
  return head + splitPairs(hunk.lines).map((pair) => `<tr class="l sp">${splitCells(pair.left, "old")}${splitCells(pair.right, "new")}</tr>`).join("");
}

function diffTable(file: DiffFile, layout: ChangesLayout, label: string): string {
  if (file.hunks.length === 0) return "";
  const body = file.hunks.map((hunk) => hunkMarkup(hunk, layout)).join("");
  return `<div class="df-scroll" tabindex="0" role="region" aria-label="${esc(label)}" data-scroll="${esc(fileId(file.path))}"><table class="df ${layout}">${body}</table></div>`;
}

function previewMarkup(path: string, preview: FilePreview | undefined): string {
  if (!preview || preview.status === "loading") return '<div class="df-msg muted">Loading preview…</div>';
  if (preview.status === "error") return `<div class="df-msg muted">${esc(preview.note)}</div>`;
  const clipped = preview.note ? `<div class="df-msg muted">${esc(preview.note)}</div>` : "";
  return `<div class="md-preview" tabindex="0" role="region" aria-label="Preview of ${esc(path)}">${markdownToHtml(preview.text)}</div>${clipped}`;
}

function fileBody(file: DiffFile, state: ChangesState): string {
  if (state.previewing.includes(file.path)) return previewMarkup(file.path, state.previews[file.path]);
  if (file.binary) return '<div class="df-msg muted">Binary file not shown.</div>';
  if (file.generated && file.hunks.length === 0) return '<div class="df-msg muted">Lockfile or generated file hidden. Use “Show lockfiles” to see it.</div>';
  if (file.hunks.length === 0) return `<div class="df-msg muted">${file.status === "R" ? "Renamed without content changes." : "No textual changes (mode change only)."}</div>`;
  const cut = file.truncated ? '<div class="df-msg warn">Large file: the rest of this diff was cut.</div>' : "";
  return diffTable(file, state.layout, `Diff of ${file.path}`) + cut;
}

function fileSection(file: DiffFile, state: ChangesState): string {
  const folded = state.collapsed.includes(file.path);
  const id = fileId(file.path);
  const canPreview = isMarkdownPath(file.path) && file.status !== "D" && !file.binary;
  const previewing = state.previewing.includes(file.path);
  const toggle = canPreview
    ? button({ label: previewing ? "Show diff" : "Preview", cls: "ghost sm", ariaLabel: previewing ? `Show diff of ${file.path}` : `Preview ${file.path} rendered`, data: { "data-act": "changes-preview", "data-path": file.path } })
    : "";
  return `<section class="df-file" id="${esc(id)}" data-path="${esc(file.path)}">
      <header class="df-head">
        <button${attrs({ type: "button", class: "df-fold", "data-act": "changes-fold", "data-path": file.path, "aria-expanded": !folded, "aria-controls": `${id}-body`, title: folded ? "Expand" : "Collapse" })}>${icon("chev")}</button>
        ${statusChip(file)}<span class="df-title mono" title="${esc(file.path)}">${summary(file)}</span>
        ${file.binary ? '<span class="df-note">binary</span>' : counts(file.additions, file.deletions)}${toggle}
      </header>
      <div class="df-body" id="${esc(id)}-body"${folded ? " hidden" : ""}>${folded ? "" : fileBody(file, state)}</div>
    </section>`;
}

function toolbar(state: ChangesState, data: ChangesResult | undefined): string {
  const busy = state.status === "loading";
  const layoutButton = (layout: ChangesLayout, label: string): string =>
    `<button${attrs({ type: "button", class: "seg", "data-act": "changes-layout", "data-layout": layout, "aria-pressed": state.layout === layout })}>${label}</button>`;
  return `<div class="df-bar">
      <input${attrs({ type: "search", class: "df-filter", placeholder: "Filter files…", value: state.filter, "aria-label": "Filter changed files", "data-act": "changes-filter", "data-focus": "changes-filter", autocomplete: "off", spellcheck: false })} />
      <span class="seg-group" role="group" aria-label="Diff layout">${layoutButton("unified", "Unified")}${layoutButton("split", "Split")}</span>
      <label class="df-toggle"><input${attrs({ type: "checkbox", "data-act": "changes-generated", checked: state.showGenerated })} /> Show lockfiles</label>
      ${button({ label: busy ? "Refreshing…" : "Refresh", icon: "retry", cls: "ghost sm", disabled: busy, data: { "data-act": "changes-refresh" } })}
      ${data ? `<span class="df-meta muted" title="Branch compared with its base">${esc(data.branch)} ← ${esc(data.base)} · ${SOURCE_LABEL[data.source]}</span>` : ""}
    </div>`;
}

/** Tab body of an item or feature drawer: toolbar, file overview, one collapsible section per file. */
export function renderChanges(state: ChangesState): string {
  const { data } = state;
  const bar = toolbar(state, data);
  if (state.status === "error") return `${bar}<div class="df-msg warn" role="alert">${esc(state.error ?? "Could not read the changes.")}</div>`;
  if (!data) return `${bar}<div class="df-msg muted">Loading changes…</div>`;
  const visible = data.files.filter((file) => matchesFilter(file, state.filter));
  const hiddenByCap = data.totals.files - data.files.length;
  const head = `<p class="df-sum"><b>${data.totals.files}</b> file${data.totals.files === 1 ? "" : "s"} changed ${counts(data.totals.additions, data.totals.deletions)}</p>`;
  const warn = data.truncated
    ? `<div class="df-msg warn">Showing a capped diff${hiddenByCap > 0 ? ` (${hiddenByCap} more file${hiddenByCap === 1 ? "" : "s"} not listed)` : ""}; open the branch or pull request for everything.</div>`
    : "";
  if (data.files.length === 0) return `${bar}${head}<div class="df-msg muted">No changes against ${esc(data.base)} yet.</div>`;
  return `${bar}${head}${warn}${overview(data, visible)}<div class="df-files">${visible.map((file) => fileSection(file, state)).join("")}</div>`;
}
