import type { UiFeedLine, UiState } from "../state.js";
import type { AttemptChunk, AttemptRecord } from "../../real/attemptLog.js";
import type { ResetPlan, ResetReport } from "../../real/reset.js";
import { buildAttention, type AttentionEntry } from "./attention.js";
import { alertText, holdReasonOf, isHeld, newlyNeedingAttention, pageTitle, parseHeld, type HeldMap } from "./humanAlerts.js";
import { messageOf, projectApi, type ProjectApi } from "./api.js";
import { patch, patchLog, readStorage, writeStorage } from "./dom.js";
import { formatClock, formatCountdown } from "./format.js";
import type { BoardProject, ParentOption, ProjectStatus } from "./model.js";
import { chooseRun, shouldAdopt } from "./model.js";
import { planLines, reportLines } from "./resetText.js";
import { ICON_SPRITE } from "./view/icons.js";
import { renderDrawer } from "./view/drawer.js";
import { renderMain, renderSide } from "./view/main.js";
import { renderRail } from "./view/rail.js";
import { renderDialog, renderSwitcher, renderToasts, switchTargets } from "./view/chrome.js";
import { cardId } from "./view/run.js";
import { currentProject, type BoardScope, type BoardUi, type DialogState, type DrawerState, type NotifyPermission, type Theme } from "./view/ui.js";

const FEED_LIMIT = 200;
const PARENT_REFRESH_MS = 60_000;
const SSE_FALLBACK_STATE_POLL_MS = 5000;
const DRAWER_POLL_MS = 1500;
const TOAST_MS = { error: 12_000, info: 5000 } as const;
const THEME_KEY = "sandcastle.theme";
const FEED_KEY = "sandcastle.feed";
const HELD_KEY = "sandcastle.held";
const THEMES: readonly Theme[] = ["auto", "light", "dark"];
const DEFAULT_DASHBOARD_URL = "http://127.0.0.1:7700/";

function notifyPermission(): NotifyPermission {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

export interface ProjectSource {
  id: string;
  name: string;
  hub?: string;
  /** URL prefix of the Project Server's API ("" when this page is served by it). */
  apiBase: string;
  legacyHref: string;
  status?: ProjectStatus;
  idle?: boolean;
}

export type BoardAction = "restart" | "pause-all";

export interface BoardOptions {
  root: HTMLElement;
  scope?: BoardScope;
  /** Defaults to the Project Server serving this page (read from /api/instance). */
  projects?: ProjectSource[] | (() => Promise<ProjectSource[]>);
  /** Re-run a `projects` function this often; Dashboards pass their poll interval. */
  refreshProjectsMs?: number;
  dashboardUrl?: string;
  /** Called for actions the board cannot perform itself, e.g. restarting a Project Server. A returned message is shown as a toast; a rejection as an error. */
  onAction?: (action: BoardAction, projectId: string) => void | string | Promise<void | string>;
}

export interface BoardHandle {
  setProjects(sources: ProjectSource[]): void;
  destroy(): void;
}

interface Connection {
  api: ProjectApi;
  source: EventSource | undefined;
  parentsTimer: ReturnType<typeof setInterval> | undefined;
  stateTimer: ReturnType<typeof setInterval> | undefined;
}

interface InstanceInfo {
  dir: string;
  name: string;
  mode: "dry" | "real";
  idle: boolean;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
}

function applyTheme(theme: Theme): void {
  if (theme === "auto") delete document.documentElement.dataset["theme"];
  else document.documentElement.dataset["theme"] = theme;
}

function initialTheme(): Theme {
  const stored = readStorage(THEME_KEY);
  return THEMES.find((theme) => theme === stored) ?? "auto";
}

async function instanceSource(): Promise<ProjectSource> {
  const info = await projectApi("")
    .get("/api/instance")
    .then((payload) => payload["result"] as InstanceInfo | null)
    .catch(() => null);
  const name = info?.name ?? "project";
  return { id: slug(name), name, apiBase: "", legacyHref: "/legacy", status: "running", idle: info?.idle ?? false };
}

export function mountBoard(options: BoardOptions): BoardHandle {
  const { root } = options;
  const scope: BoardScope = options.scope ?? "project";
  const search = new URLSearchParams(location.search);

  const doneOpen = new Set<string>();
  const ui: BoardUi = {
    scope,
    projects: [],
    currentId: search.get("project") ?? readStorage("sandcastle.project") ?? "",
    selectedRuns: {},
    feedAll: false,
    feedOpen: readStorage(FEED_KEY) === "1",
    doneOpen,
    parentQuery: "",
    selectedParent: "",
    startCap: undefined,
    theme: initialTheme(),
    dashboard: scope === "project" ? { url: options.dashboardUrl ?? DEFAULT_DASHBOARD_URL, up: undefined } : undefined,
    nowMs: Date.now(),
    localFeed: {},
    drawer: undefined,
    switcher: undefined,
    toasts: [],
    dialog: undefined,
    held: [],
    notifyPermission: notifyPermission(),
    busy: new Set(),
    flash: undefined,
  };
  const requestedRun = Number(search.get("run")) || undefined;
  const connections = new Map<string, Connection>();
  let toastSeq = 0;
  let heldMap: HeldMap = parseHeld(readStorage(HELD_KEY));
  /** Counted attention keys already announced, per project; absent until the project's first state. */
  const announced = new Map<string, Set<string>>();
  let renderQueued = false;
  const logState = { attempt: undefined as string | undefined, offset: 0, text: "" };
  let drawerTimer: ReturnType<typeof setInterval> | undefined;
  let destroyed = false;
  const timers: ReturnType<typeof setInterval>[] = [];

  applyTheme(ui.theme);
  root.innerHTML = `${ICON_SPRITE}
    <div class="app with-side">
      <nav class="rail" data-zone="rail" aria-label="Projects"></nav>
      <main class="main" data-zone="main"></main>
      <aside class="side" data-zone="side" aria-label="Feed and queue"></aside>
    </div>
    <div data-zone="scrim" class="scrim" data-act="drawer-close" hidden></div>
    <aside class="drawer" data-zone="drawer" hidden>
      <div data-zone="d-head"></div>
      <div class="attempts" data-zone="d-att"></div>
      <div class="log" data-zone="d-body" tabindex="0"></div>
    </aside>
    <div data-zone="switcher"></div>
    <div data-zone="dialog"></div>
    <div class="toasts" data-zone="toasts" aria-live="polite"></div>`;
  const zone = (name: string): HTMLElement => {
    const element = root.querySelector<HTMLElement>(`[data-zone="${name}"]`);
    if (!element) throw new Error(`board zone ${name} missing`);
    return element;
  };
  const zones = {
    rail: zone("rail"),
    main: zone("main"),
    side: zone("side"),
    scrim: zone("scrim"),
    drawer: zone("drawer"),
    dHead: zone("d-head"),
    dAtt: zone("d-att"),
    dBody: zone("d-body"),
    switcher: zone("switcher"),
    dialog: zone("dialog"),
    toasts: zone("toasts"),
  };

  const projectById = (id: string | undefined): BoardProject | undefined => ui.projects.find((project) => project.id === id);
  const targetProject = (element: Element | null): BoardProject | undefined => {
    const id = element?.closest<HTMLElement>("[data-proj]")?.dataset["proj"];
    return projectById(id) ?? currentProject(ui);
  };

  function render(): void {
    if (renderQueued || destroyed) return;
    renderQueued = true;
    queueMicrotask(() => {
      renderQueued = false;
      renderNow();
    });
  }

  function renderNow(): void {
    if (destroyed) return;
    ui.nowMs = Date.now();
    const everything = buildAttention(ui.projects, ui.currentId);
    const attention = everything.filter((entry) => !isHeld(heldMap, entry));
    ui.held = everything.filter((entry) => isHeld(heldMap, entry));
    announceNew(everything);
    patch(zones.rail, renderRail(ui, attention));
    patch(zones.main, renderMain(ui, attention));
    patch(zones.side, renderSide(ui));
    renderDrawerZones();
    patch(zones.switcher, renderSwitcher(ui));
    patch(zones.dialog, renderDialog(ui));
    patch(zones.toasts, renderToasts(ui.toasts));
    const counted = attention.filter((entry) => entry.counted).length;
    document.title = pageTitle(counted, currentProject(ui)?.name);
  }

  /** A toast and, when allowed, a desktop notification for each entry that appeared since the last state of its project. */
  function announceNew(entries: readonly AttentionEntry[]): void {
    for (const project of ui.projects) {
      if (!project.state) continue;
      const own = entries.filter((entry) => entry.projectId === project.id);
      const fresh = newlyNeedingAttention(announced.get(project.id), own).filter((entry) => !isHeld(heldMap, entry));
      announced.set(project.id, new Set(own.filter((entry) => entry.counted).map((entry) => entry.key)));
      for (const entry of fresh) {
        const text = alertText(entry);
        toast("error", `${text.title}. ${text.body.split("\n")[0] ?? ""}`.slice(0, 280));
        desktopNotify(entry, text);
      }
    }
  }

  function desktopNotify(entry: AttentionEntry, text: { title: string; body: string }): void {
    if (notifyPermission() !== "granted") return;
    try {
      const note = new Notification(text.title, { body: text.body.slice(0, 200), tag: entry.key });
      note.onclick = () => {
        window.focus();
        setCurrent(entry.projectId, entry.runNumber);
        note.close();
      };
    } catch {
      // some browsers only allow notifications from a service worker; the in-page toast still shows
    }
  }

  function renderDrawerZones(): void {
    const drawer = ui.drawer;
    const project = drawer ? projectById(drawer.projectId) : undefined;
    const open = drawer !== undefined && project !== undefined;
    zones.drawer.hidden = !open;
    zones.scrim.hidden = !open;
    if (!open || !drawer || !project) return;
    const parts = renderDrawer(ui, project, drawer, logState.text);
    zones.drawer.setAttribute("aria-label", parts.label);
    patch(zones.dHead, parts.head);
    patch(zones.dAtt, parts.attempts);
    zones.dAtt.hidden = parts.attempts === "";
    if (drawer.kind === "item") {
      zones.dBody.className = "log";
      patchLog(zones.dBody, parts.body);
    } else {
      zones.dBody.className = "d-scroll";
      patch(zones.dBody, parts.body);
    }
  }

  function toast(tone: "error" | "info", message: string): void {
    const id = ++toastSeq;
    ui.toasts = [...ui.toasts.slice(-3), { id, tone, message }];
    render();
    setTimeout(() => dismissToast(id), TOAST_MS[tone]);
  }

  function dismissToast(id: number): void {
    ui.toasts = ui.toasts.filter((candidate) => candidate.id !== id);
    render();
  }

  function localLine(project: BoardProject, kind: UiFeedLine["kind"], message: string): void {
    const line: UiFeedLine = { at: new Date().toISOString(), kind, itemNumber: undefined, message };
    ui.localFeed[project.id] = [...(ui.localFeed[project.id] ?? []), line].slice(-FEED_LIMIT);
  }

  /** Errors are a toast plus a feed line, so they survive the toast. */
  function fail(project: BoardProject, cause: unknown): void {
    const message = messageOf(cause);
    localLine(project, "warn", message);
    toast("error", message);
  }

  function apiOf(project: BoardProject): ProjectApi {
    return connections.get(project.id)?.api ?? projectApi(project.apiBase);
  }

  async function refreshState(project: BoardProject): Promise<void> {
    const payload = await apiOf(project).get("/api/state");
    adoptState(project, payload as unknown as UiState);
  }

  function adoptState(project: BoardProject, state: UiState): void {
    if (!shouldAdopt(project.state, state)) {
      if (project.connected) return;
      project.connected = true;
      render();
      return;
    }
    project.state = state;
    project.hub = state.hubRepo;
    project.mode = state.mode;
    project.connected = true;
    if (ui.selectedParent === "" && state.preselectedParent) ui.selectedParent = String(state.preselectedParent);
    const requested = requestedRun && state.runs.some((run) => run.parent.number === requestedRun) ? requestedRun : undefined;
    if (requested && ui.selectedRuns[project.id] === undefined) ui.selectedRuns[project.id] = requested;
    if (ui.selectedRuns[project.id] === undefined) {
      const stored = Number(readStorage(`sandcastle.run.${project.id}`)) || undefined;
      if (stored !== undefined) ui.selectedRuns[project.id] = stored;
    }
    render();
  }

  async function loadParents(project: BoardProject): Promise<void> {
    try {
      const payload = await apiOf(project).get("/api/parents");
      project.parents = (payload["parents"] as ParentOption[] | undefined) ?? [];
      render();
    } catch (cause) {
      fail(project, cause);
    }
  }

  const polling = new Set<string>();

  async function pollState(project: BoardProject): Promise<void> {
    if (polling.has(project.id)) return;
    polling.add(project.id);
    try {
      let payload: Record<string, unknown>;
      try {
        payload = await apiOf(project).get("/api/state");
      } catch (cause) {
        console.warn(`[board] state poll failed for ${project.id}`, cause);
        if (!project.connected) return;
        project.connected = false;
        render();
        return;
      }
      try {
        adoptState(project, payload as unknown as UiState);
      } catch (cause) {
        console.warn(`[board] adopting polled state failed for ${project.id}`, cause);
      }
    } finally {
      polling.delete(project.id);
    }
  }

  function pollVisible(): void {
    if (document.hidden) return;
    for (const project of ui.projects) if (connections.has(project.id)) void pollState(project);
  }

  function connect(project: BoardProject): void {
    if (connections.has(project.id) || project.status !== "running") return;
    const api = projectApi(project.apiBase);
    const connection: Connection = { api, source: undefined, parentsTimer: undefined, stateTimer: undefined };
    connections.set(project.id, connection);
    const source = new EventSource(api.eventsUrl());
    connection.source = source;
    source.addEventListener("state", (event) => adoptState(project, (JSON.parse((event as MessageEvent<string>).data) as { state: UiState }).state));
    source.addEventListener("feed", (event) => {
      const line = (JSON.parse((event as MessageEvent<string>).data) as { line: UiFeedLine }).line;
      if (project.state) project.state = { ...project.state, feed: [...project.state.feed, line].slice(-FEED_LIMIT) };
      render();
    });
    source.onopen = () => {
      project.connected = true;
      render();
    };
    source.onerror = () => {
      project.connected = false;
      render();
    };
    void refreshState(project).catch((cause: unknown) => fail(project, cause));
    void loadParents(project);
    connection.stateTimer = setInterval(() => {
      if (!document.hidden) void pollState(project);
    }, SSE_FALLBACK_STATE_POLL_MS);
    connection.parentsTimer = setInterval(() => {
      if (!document.hidden) void loadParents(project);
    }, PARENT_REFRESH_MS);
  }

  function disconnect(id: string): void {
    const connection = connections.get(id);
    if (!connection) return;
    connection.source?.close();
    if (connection.parentsTimer) clearInterval(connection.parentsTimer);
    if (connection.stateTimer) clearInterval(connection.stateTimer);
    connections.delete(id);
  }

  function applySources(sources: ProjectSource[]): void {
    const previous = new Map(ui.projects.map((project) => [project.id, project]));
    ui.projects = sources.map((source) => {
      const known = previous.get(source.id);
      const status = source.status ?? "running";
      const project: BoardProject = {
        id: source.id,
        name: source.name,
        hub: source.hub ?? known?.hub ?? "",
        apiBase: source.apiBase,
        legacyHref: source.legacyHref,
        status,
        idle: source.idle ?? known?.idle ?? false,
        mode: known?.mode ?? "real",
        state: known?.state,
        parents: known?.parents ?? [],
        connected: known?.connected ?? false,
      };
      return project;
    });
    for (const id of [...connections.keys()]) {
      const project = projectById(id);
      if (!project || project.status !== "running") disconnect(id);
    }
    for (const project of ui.projects) connect(project);
    if (!projectById(ui.currentId)) ui.currentId = ui.projects[0]?.id ?? "";
    render();
  }

  async function loadSources(): Promise<void> {
    const given = options.projects;
    const sources = typeof given === "function" ? await given() : (given ?? [await instanceSource()]);
    if (!destroyed) applySources(sources);
  }

  function setCurrent(projectId: string, run?: number): void {
    ui.currentId = projectId;
    writeStorage("sandcastle.project", scope === "dashboard" ? projectId : undefined);
    if (run !== undefined) {
      ui.selectedRuns[projectId] = run;
      writeStorage(`sandcastle.run.${projectId}`, String(run));
    }
    if (ui.drawer && ui.drawer.projectId !== projectId) closeDrawer();
    render();
  }

  // ---- drawers ----

  function stopDrawerPolling(): void {
    if (drawerTimer) clearInterval(drawerTimer);
    drawerTimer = undefined;
  }

  function closeDrawer(): void {
    stopDrawerPolling();
    ui.drawer = undefined;
    logState.attempt = undefined;
    logState.offset = 0;
    logState.text = "";
    render();
  }

  function focusDrawer(): void {
    setTimeout(() => zones.drawer.querySelector<HTMLElement>("[data-act=drawer-close]")?.focus({ preventScroll: true }), 0);
  }

  function openItem(project: BoardProject, itemNumber: number): void {
    stopDrawerPolling();
    logState.attempt = undefined;
    logState.offset = 0;
    logState.text = "";
    ui.drawer = { kind: "item", projectId: project.id, itemNumber, attempts: [], attemptId: undefined, raw: false, loaded: false };
    render();
    focusDrawer();
    void loadAttempts(project, true);
    drawerTimer = setInterval(() => void loadAttempts(project, false), DRAWER_POLL_MS);
  }

  function itemDrawer(): Extract<DrawerState, { kind: "item" }> | undefined {
    return ui.drawer?.kind === "item" ? ui.drawer : undefined;
  }

  async function loadAttempts(project: BoardProject, selectLatest: boolean): Promise<void> {
    const drawer = itemDrawer();
    if (!drawer) return;
    try {
      const payload = await apiOf(project).get(`/api/items/${drawer.itemNumber}/attempts`);
      const records = (payload["result"] as AttemptRecord[] | null) ?? [];
      const current = itemDrawer();
      if (!current || current.itemNumber !== drawer.itemNumber) return;
      current.attempts = records.map((record) => ({
        id: record.id,
        stage: record.stage,
        attempt: record.attempt,
        outcome: record.outcome,
        live: record.endedAt === undefined || record.endedAt === null,
        bytes: record.bytes,
        startedAt: record.startedAt,
      }));
      current.loaded = true;
      const known = current.attempts.some((attempt) => attempt.id === current.attemptId);
      const latest = current.attempts[current.attempts.length - 1];
      if (latest && (selectLatest || !known)) selectAttempt(project, latest.id);
      else void pollLog(project);
      render();
    } catch (cause) {
      stopDrawerPolling();
      fail(project, cause);
    }
  }

  function selectAttempt(project: BoardProject, id: string): void {
    const drawer = itemDrawer();
    if (!drawer) return;
    drawer.attemptId = id;
    logState.attempt = id;
    logState.offset = 0;
    logState.text = "";
    render();
    void pollLog(project);
  }

  async function pollLog(project: BoardProject): Promise<void> {
    const id = logState.attempt;
    if (!id) return;
    try {
      const payload = await apiOf(project).get(`/api/attempts/${id}/log?from=${logState.offset}`);
      if (id !== logState.attempt) return;
      const chunk = payload["result"] as AttemptChunk;
      if (chunk.next === logState.offset && logState.text.length > 0) return;
      logState.offset = chunk.next;
      logState.text += chunk.chunk;
      render();
    } catch (cause) {
      stopDrawerPolling();
      fail(project, cause);
    }
  }

  async function openReset(project: BoardProject): Promise<void> {
    stopDrawerPolling();
    const run = chooseRun(project.state, ui.selectedRuns[project.id]);
    const picked = Number(root.querySelector<HTMLSelectElement>(".start-form select")?.value) || undefined;
    const parent = run?.parent.number ?? picked ?? project.state?.parent?.number;
    if (!parent) {
      toast("error", "Pick an Orchestration Issue first — reset needs to know whose run to clear.");
      return;
    }
    ui.drawer = { kind: "reset", projectId: project.id, parent, reset: { title: `Reset #${parent} — reading`, text: "…", canApply: false, busy: false } };
    render();
    focusDrawer();
    try {
      const payload = await apiOf(project).send("POST", "/api/reset", { parent });
      if (ui.drawer?.kind !== "reset") return;
      ui.drawer.reset = { title: `Reset #${parent} — dry run, nothing changed yet`, text: planLines(payload["result"] as ResetPlan), canApply: true, busy: false };
    } catch (cause) {
      closeDrawer();
      fail(project, cause);
      return;
    }
    render();
  }

  async function applyReset(project: BoardProject): Promise<void> {
    const drawer = ui.drawer;
    if (drawer?.kind !== "reset" || drawer.parent === undefined) return;
    const parent = drawer.parent;
    drawer.reset = { ...drawer.reset, busy: true };
    render();
    try {
      const payload = await apiOf(project).send("POST", "/api/reset", { parent, apply: true });
      if (ui.drawer?.kind !== "reset") return;
      ui.drawer.reset = { title: `Reset #${parent} — applied`, text: reportLines(payload["result"] as ResetReport), canApply: false, busy: false };
      localLine(project, "note", `reset #${parent} applied`);
      await refreshState(project);
    } catch (cause) {
      if (ui.drawer?.kind === "reset") ui.drawer.reset = { ...ui.drawer.reset, busy: false };
      fail(project, cause);
    }
    render();
  }

  async function submitAdd(project: BoardProject): Promise<void> {
    const drawer = ui.drawer;
    if (drawer?.kind !== "add" || drawer.busy) return;
    drawer.busy = true;
    render();
    try {
      const payload = await apiOf(project).send("POST", "/api/parents", { text: drawer.text });
      const checks = (payload["result"] as { ok: boolean; number?: number; title?: string; input: string; error?: string }[] | null) ?? [];
      if (ui.drawer?.kind === "add") {
        ui.drawer.result = checks.map((check) => (check.ok ? `ok    #${check.number} ${check.title}` : `FAIL  ${check.input} — ${check.error}`)).join("\n");
      }
      await loadParents(project);
    } catch (cause) {
      fail(project, cause);
    }
    if (ui.drawer?.kind === "add") ui.drawer.busy = false;
    render();
  }

  // ---- project actions ----

  async function act(project: BoardProject, run: (api: ProjectApi) => Promise<unknown>): Promise<boolean> {
    try {
      await run(apiOf(project));
      await refreshState(project);
      return true;
    } catch (cause) {
      fail(project, cause);
      render();
      return false;
    }
  }

  function positive(project: BoardProject, raw: string, what: string): number | undefined {
    const value = Number(raw);
    if (Number.isInteger(value) && value > 0) return value;
    fail(project, `${what} must be a positive whole number`);
    render();
    return undefined;
  }

  function formParent(element: Element): number | undefined {
    const form = element.closest(".start-form");
    const chosen = form?.querySelector<HTMLSelectElement>("select")?.value ?? element.closest<HTMLElement>("[data-parent]")?.dataset["parent"] ?? "";
    return Number(chosen) || undefined;
  }

  function startCapOf(project: BoardProject): number | undefined {
    return positive(project, ui.startCap ?? String(project.state?.queueSettings.parentCap ?? 1), "Run Cap");
  }

  async function startNow(project: BoardProject, parent: number): Promise<void> {
    const cap = startCapOf(project);
    if (cap === undefined) return;
    const key = `start:${project.id}`;
    ui.busy = new Set(ui.busy).add(key);
    render();
    const ok = await act(project, (api) => api.send("POST", "/api/run", { parent, cap }));
    const next = new Set(ui.busy);
    next.delete(key);
    ui.busy = next;
    if (ok) toast("info", `Started #${parent}`);
    render();
  }

  function reorderQueue(project: BoardProject, index: number, offset: number): void {
    const order = [...(project.state?.queue ?? [])];
    const [moved] = order.splice(index, 1);
    if (moved === undefined) return;
    order.splice(index + offset, 0, moved);
    void act(project, (api) => api.send("POST", "/api/queue/reorder", { parents: order }));
  }

  function jumpTo(element: Element, blocker: number): void {
    const card = element.closest<HTMLElement>("[data-card]");
    const projectId = card?.dataset["proj"];
    const run = Number(card?.dataset["run"]);
    if (!projectId || !run) return;
    const id = cardId(projectId, run, blocker);
    const target = document.getElementById(id);
    if (!target) return;
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ block: "center", inline: "center", behavior: calm ? "auto" : "smooth" });
    ui.flash = id;
    render();
    setTimeout(() => {
      if (ui.flash === id) {
        ui.flash = undefined;
        render();
      }
    }, 1800);
  }

  function openRun(projectId: string, run: number | undefined): void {
    setCurrent(projectId, run);
    window.scrollTo({ top: 0 });
  }

  function cycleTheme(): void {
    const next = THEMES[(THEMES.indexOf(ui.theme) + 1) % THEMES.length] ?? "auto";
    ui.theme = next;
    applyTheme(next);
    writeStorage(THEME_KEY, next === "auto" ? undefined : next);
    render();
  }

  function openSwitcher(): void {
    ui.switcher = { query: "", index: 0 };
    render();
    setTimeout(() => zones.switcher.querySelector<HTMLElement>("[data-focus=switcher-input]")?.focus(), 0);
  }

  function closeSwitcher(): void {
    ui.switcher = undefined;
    render();
  }

  function goSwitch(index: number): void {
    const switcher = ui.switcher;
    if (!switcher) return;
    const target = switchTargets(ui.projects, switcher.query)[index];
    ui.switcher = undefined;
    if (target) setCurrent(target.projectId, target.runNumber);
    else render();
  }

  function setFeedOpen(open: boolean): void {
    ui.feedOpen = open;
    writeStorage(FEED_KEY, open ? "1" : undefined);
  }

  // ---- events ----

  function runAction(action: BoardAction, projectId: string): void {
    if (!options.onAction) return toast("info", 'Run "sandcastle ui" inside the project directory to restart it.');
    Promise.resolve(options.onAction(action, projectId)).then(
      (message) => {
        if (typeof message === "string") toast("info", message);
      },
      (cause: unknown) => toast("error", cause instanceof Error ? cause.message : String(cause)),
    );
  }

  function parkedEntry(project: BoardProject, itemNumber: number): AttentionEntry | undefined {
    return buildAttention([project], project.id).find((entry) => entry.kind === "parked" && entry.itemNumber === itemNumber);
  }

  function openDialog(project: BoardProject, kind: DialogState["kind"], itemNumber: number, runNumber: number | undefined): void {
    const entry = parkedEntry(project, itemNumber);
    ui.dialog = {
      kind,
      projectId: project.id,
      itemNumber,
      runNumber,
      title: entry?.title ?? `#${itemNumber}`,
      stage: entry?.park?.stage,
      reason: entry?.park?.reason ?? "",
      text: "",
      busy: false,
      result: undefined,
    };
    render();
    setTimeout(() => zones.dialog.querySelector<HTMLElement>("[data-focus]")?.focus(), 0);
  }

  function closeDialog(): void {
    ui.dialog = undefined;
    render();
  }

  function setHeld(entry: AttentionEntry, hold: boolean): void {
    heldMap = { ...heldMap };
    if (hold) heldMap[entry.key] = holdReasonOf(entry);
    else delete heldMap[entry.key];
    writeStorage(HELD_KEY, Object.keys(heldMap).length ? JSON.stringify(heldMap) : undefined);
  }

  async function confirmDialog(): Promise<void> {
    const dialog = ui.dialog;
    const project = dialog ? projectById(dialog.projectId) : undefined;
    if (!dialog || !project || dialog.busy) return;
    if (dialog.kind === "hold") {
      const entry = parkedEntry(project, dialog.itemNumber);
      if (entry) setHeld(entry, true);
      dialog.result = { ok: true, message: `#${dialog.itemNumber} is on Hold. It stays parked; use Unhold to show it again.` };
      render();
      return;
    }
    dialog.busy = true;
    dialog.result = undefined;
    render();
    const api = apiOf(project);
    try {
      if (dialog.kind === "requeue") {
        await api.send("POST", `/api/items/${dialog.itemNumber}/retry`);
        dialog.result = { ok: true, message: `Re-queued #${dialog.itemNumber}: ready-for-human flipped to ready-for-agent. It restarts shortly.` };
      } else {
        await api.send("POST", `/api/items/${dialog.itemNumber}/comment`, { body: dialog.text });
        dialog.result = { ok: true, message: `Comment posted on #${dialog.itemNumber}.` };
      }
      toast("info", dialog.result.message);
      await refreshState(project).catch(() => undefined);
    } catch (cause) {
      dialog.result = { ok: false, message: messageOf(cause) };
      localLine(project, "warn", messageOf(cause));
    }
    dialog.busy = false;
    render();
  }

  async function enableDesktopAlerts(): Promise<void> {
    if (notifyPermission() === "unsupported") return;
    try {
      await Notification.requestPermission();
    } catch {
      // older browsers use a callback form; the state below re-reads the permission either way
    }
    ui.notifyPermission = notifyPermission();
    render();
  }

  function onAttentionAction(act_: string, element: HTMLElement, project: BoardProject): void {
    const itemNumber = Number(element.dataset["n"]) || undefined;
    const runNumber = Number(element.dataset["run"]) || undefined;
    if (act_ === "att-requeue" && itemNumber) return openDialog(project, "requeue", itemNumber, runNumber);
    if (act_ === "att-hold" && itemNumber) return openDialog(project, "hold", itemNumber, runNumber);
    if (act_ === "att-comment" && itemNumber) return openDialog(project, "comment", itemNumber, runNumber);
    if (act_ === "att-unhold") {
      const entry = ui.held.find((candidate) => candidate.key === element.dataset["key"]);
      if (entry) setHeld(entry, false);
      return render();
    }
    if (act_ === "att-log" && itemNumber) {
      setCurrent(project.id, runNumber);
      openItem(project, itemNumber);
    } else if (act_ === "att-cancel" && itemNumber) {
      void act(project, (api) => api.send("POST", `/api/items/${itemNumber}/cancel`));
    } else if (act_ === "att-open-run") {
      openRun(project.id, runNumber);
    } else if (act_ === "att-feed") {
      setCurrent(project.id);
      if (!ui.feedOpen) {
        setFeedOpen(true);
        renderNow();
      }
      const feed = Array.from(root.querySelectorAll<HTMLElement>(".feed-panel")).find((panel) => panel.offsetParent !== null);
      feed?.scrollIntoView({ block: "center" });
    } else if (act_ === "att-restart") {
      runAction("restart", project.id);
    }
  }

  function onClick(event: MouseEvent): void {
    const origin = event.target instanceof Element ? event.target : null;
    const element = origin?.closest<HTMLElement>("[data-act]") ?? null;
    if (!element) {
      const card = origin?.closest<HTMLElement>("[data-card]");
      if (card && !origin?.closest("a, button")) {
        const project = projectById(card.dataset["proj"]);
        if (project) openItem(project, Number(card.dataset["card"]));
      }
      return;
    }
    const action = element.dataset["act"] ?? "";
    const project = targetProject(element);
    const itemNumber = Number(element.dataset["n"]) || undefined;
    const runNumber = Number(element.dataset["run"]) || undefined;
    if (action === "switcher-close" || action === "drawer-close" || action === "toast-dismiss") {
      if (action === "switcher-close") closeSwitcher();
      else if (action === "drawer-close") closeDrawer();
      else if (itemNumber) dismissToast(itemNumber);
      return;
    }
    if (action === "dialog-close") return closeDialog();
    if (action === "dialog-confirm") return void confirmDialog();
    if (action === "notify-enable") return void enableDesktopAlerts();
    if (action === "switch-go") {
      const index = Array.from(element.parentElement?.children ?? []).indexOf(element);
      goSwitch(index);
      return;
    }
    if (action === "theme") return cycleTheme();
    if (action === "pause-all") return runAction("pause-all", "");
    if (action === "switch") return openSwitcher();
    if (action === "toggle-feed") {
      setFeedOpen(!ui.feedOpen);
      return render();
    }
    if (action === "feed-scope") {
      ui.feedAll = element.dataset["scope"] === "all";
      return render();
    }
    if (action === "select-project") {
      if (element.dataset["proj"]) setCurrent(element.dataset["proj"]);
      return;
    }
    if (action.startsWith("att-") && project) return onAttentionAction(action, element, project);
    if (!project) return;
    if (action === "select-run" && runNumber) return setCurrent(project.id, runNumber);
    if (action === "fold" && runNumber) {
      const key = `${project.id}:${runNumber}`;
      if (doneOpen.has(key)) doneOpen.delete(key);
      else doneOpen.add(key);
      return render();
    }
    if (action === "open-item" && itemNumber) return openItem(project, itemNumber);
    if (action === "jump" && itemNumber) return jumpTo(element, itemNumber);
    if (action === "retry" && itemNumber) return void act(project, (api) => api.send("POST", `/api/items/${itemNumber}/retry`));
    if (action === "cancel" && itemNumber) return void act(project, (api) => api.send("POST", `/api/items/${itemNumber}/cancel`));
    if (action === "run-pause" && runNumber) return void act(project, (api) => api.send("POST", `/api/runs/${runNumber}/pause`));
    if (action === "run-resume" && runNumber) return void act(project, (api) => api.send("POST", `/api/runs/${runNumber}/resume`));
    if (action === "run-stop" && runNumber) return void act(project, (api) => api.send("POST", `/api/runs/${runNumber}/stop`));
    if (action === "pause-project") return void act(project, (api) => api.send("POST", "/api/pause"));
    if (action === "resume-project") return void act(project, (api) => api.send("POST", "/api/resume"));
    if (action === "queue-mode") {
      const mode = element.dataset["mode"];
      return void act(project, (api) => api.send("PUT", "/api/queue/mode", { mode }));
    }
    if (action === "queue-resume") return void act(project, (api) => api.send("POST", "/api/queue/resume"));
    if (action === "queue-clear") return void act(project, (api) => api.send("POST", "/api/queue/clear"));
    if (action === "queue-up" || action === "queue-down") {
      return reorderQueue(project, Number(element.dataset["index"]), action === "queue-up" ? -1 : 1);
    }
    if (action === "queue-remove" && itemNumber) return void act(project, (api) => api.send("DELETE", `/api/queue/${itemNumber}`));
    if (action === "start-now") {
      const parent = formParent(element);
      if (parent) void startNow(project, parent);
      return;
    }
    if (action === "queue-next") {
      const parent = formParent(element);
      const cap = startCapOf(project);
      if (parent && cap !== undefined) void act(project, (api) => api.send("POST", "/api/queue", { parents: [parent], cap }));
      return;
    }
    if (action === "open-add") {
      stopDrawerPolling();
      ui.drawer = { kind: "add", projectId: project.id, text: "", busy: false, result: undefined };
      render();
      focusDrawer();
      return;
    }
    if (action === "open-reset") return void openReset(project);
    if (action === "reset-apply") return void applyReset(project);
    if (action === "add-submit-btn") return void submitAdd(project);
    if (action === "select-attempt") {
      const id = element.dataset["attempt"];
      if (id) selectAttempt(project, id);
      return;
    }
    if (action === "restart") runAction("restart", project.id);
  }

  function onChange(event: Event): void {
    const element = event.target instanceof HTMLElement ? event.target : null;
    const action = element?.dataset["act"];
    if (!element || !action) return;
    const project = targetProject(element);
    if (!project) return;
    const value = (element as HTMLInputElement | HTMLSelectElement).value;
    if (action === "parent-select") {
      ui.selectedParent = value;
      return render();
    }
    if (action === "raw-toggle") {
      const drawer = itemDrawer();
      if (drawer) drawer.raw = (element as HTMLInputElement).checked;
      return render();
    }
    if (action === "run-cap") {
      const cap = positive(project, value, "Run Cap");
      const run = Number(element.dataset["run"]);
      if (cap !== undefined && run) void act(project, (api) => api.send("POST", `/api/runs/${run}/cap`, { cap }));
      return;
    }
    if (action === "project-cap") {
      const cap = positive(project, value, "Project Cap");
      if (cap !== undefined) void act(project, (api) => api.send("POST", "/api/cap", { value: cap }));
      return;
    }
    if (action === "queue-max") {
      const max = positive(project, value, "Max parallel runs");
      if (max !== undefined) void act(project, (api) => api.send("PUT", "/api/queue/mode", { mode: "parallel", maxParallel: max }));
    }
  }

  function onInput(event: Event): void {
    const element = event.target instanceof HTMLElement ? event.target : null;
    const action = element?.dataset["act"];
    if (!element || !action) return;
    const value = (element as HTMLInputElement).value;
    if (action === "parent-filter") {
      ui.parentQuery = value;
      render();
    } else if (action === "start-cap") {
      ui.startCap = value;
    } else if (action === "switcher-query" && ui.switcher) {
      ui.switcher = { query: value, index: 0 };
      render();
    } else if (action === "dialog-text" && ui.dialog?.kind === "comment") {
      ui.dialog.text = value;
      render();
    } else if (action === "add-text" && ui.drawer?.kind === "add") {
      ui.drawer.text = value;
      render();
    }
  }

  function onSubmit(event: Event): void {
    event.preventDefault();
    const project = targetProject(event.target instanceof Element ? event.target : null);
    if (project) void submitAdd(project);
  }

  function onKeydown(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      if (ui.switcher) closeSwitcher();
      else openSwitcher();
      return;
    }
    if (ui.dialog && event.key === "Escape") {
      event.preventDefault();
      closeDialog();
      return;
    }
    if (ui.switcher) {
      const count = switchTargets(ui.projects, ui.switcher.query).length;
      if (event.key === "Escape") {
        event.preventDefault();
        closeSwitcher();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        ui.switcher = { ...ui.switcher, index: count === 0 ? 0 : (ui.switcher.index + step + count) % count };
        render();
      } else if (event.key === "Enter") {
        event.preventDefault();
        goSwitch(ui.switcher.index);
      }
      return;
    }
    if (event.key === "Escape" && ui.drawer) {
      closeDrawer();
      return;
    }
    const tab = event.target instanceof Element ? event.target.closest<HTMLElement>("[role=tab]") : null;
    if (tab && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
      const tabs = Array.from(tab.parentElement?.querySelectorAll<HTMLElement>("[role=tab]") ?? []);
      const next = tabs[(tabs.indexOf(tab) + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
      next?.click();
      setTimeout(() => root.querySelector<HTMLElement>("[role=tab][aria-selected=true]")?.focus(), 0);
    }
  }

  root.addEventListener("click", onClick);
  root.addEventListener("change", onChange);
  root.addEventListener("input", onInput);
  root.addEventListener("submit", onSubmit);
  document.addEventListener("keydown", onKeydown);
  document.addEventListener("visibilitychange", pollVisible);

  // ---- clocks and probes ----

  timers.push(
    setInterval(() => {
      const now = Date.now();
      ui.nowMs = now;
      root.querySelectorAll<HTMLElement>("[data-since]").forEach((node) => {
        node.textContent = formatClock(node.dataset["since"] ?? "", now);
      });
      root.querySelectorAll<HTMLElement>("[data-until]").forEach((node) => {
        node.textContent = formatCountdown(node.dataset["until"] ?? "", now);
      });
    }, 1000),
  );

  async function probeDashboard(): Promise<void> {
    const dashboard = ui.dashboard;
    if (!dashboard) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const up = await fetch(dashboard.url, { mode: "no-cors", signal: controller.signal }).then(
      () => true,
      () => false,
    );
    clearTimeout(timeout);
    if (dashboard.up !== up) {
      dashboard.up = up;
      render();
    }
  }
  void probeDashboard();
  if (ui.dashboard) timers.push(setInterval(() => void probeDashboard(), 15_000));

  const refreshMs = options.refreshProjectsMs;
  if (typeof options.projects === "function" && refreshMs) {
    timers.push(setInterval(() => void loadSources().catch((cause: unknown) => toast("error", messageOf(cause))), refreshMs));
  }
  void loadSources().catch((cause: unknown) => toast("error", messageOf(cause)));
  renderNow();

  return {
    setProjects: applySources,
    destroy() {
      destroyed = true;
      for (const id of [...connections.keys()]) disconnect(id);
      stopDrawerPolling();
      for (const timer of timers) clearInterval(timer);
      document.removeEventListener("keydown", onKeydown);
      document.removeEventListener("visibilitychange", pollVisible);
      root.removeEventListener("click", onClick);
      root.removeEventListener("change", onChange);
      root.removeEventListener("input", onInput);
      root.removeEventListener("submit", onSubmit);
    },
  };
}
