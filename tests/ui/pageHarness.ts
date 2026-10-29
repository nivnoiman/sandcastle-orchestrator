import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import type { ParentSummary } from "../../src/gh/parents.js";
import type { TargetRepo } from "../../src/model/runModel.js";
import { PAGE_FILE } from "../../src/ui/server.js";
import { idleFeatureVerify, idlePolish, phaseCounts, type UiItem, type UiRun, type UiState } from "../../src/ui/state.js";

type InputHandler = (event: { target: { value: string } }) => void;

export class FakeText {
  constructor(private readonly text: string) {}

  get textContent(): string {
    return this.text;
  }
}

export type FakeNode = FakeElement | FakeText;

export class FakeElement {
  className = "";
  hidden = false;
  disabled = false;
  label = "";
  href = "";
  target = "";
  title = "";
  onclick: (() => void) | null = null;
  oninput: InputHandler | null = null;
  onchange: InputHandler | null = null;
  children: FakeNode[] = [];
  private ownText = "";
  private ownValue = "";

  constructor(readonly tag: string) {}

  get textContent(): string {
    if (this.children.length === 0) return this.ownText;
    return this.children.map((child) => child.textContent).join("");
  }

  set textContent(text: string) {
    this.children = [];
    this.ownText = String(text);
  }

  get value(): string {
    return this.ownValue;
  }

  set value(next: string) {
    const wanted = String(next);
    const missing = this.tag === "select" && !this.options.some((option) => option.value === wanted);
    this.ownValue = missing ? "" : wanted;
  }

  get options(): FakeElement[] {
    return this.descendants().filter((node) => node.tag === "option");
  }

  get childElementCount(): number {
    return this.elementChildren().length;
  }

  append(...nodes: FakeNode[]): void {
    this.children.push(...nodes);
  }

  prepend(...nodes: FakeNode[]): void {
    this.children.unshift(...nodes);
  }

  replaceChildren(...nodes: FakeNode[]): void {
    this.ownText = "";
    this.children = [...nodes];
  }

  elementChildren(): FakeElement[] {
    return this.children.filter((child): child is FakeElement => child instanceof FakeElement);
  }

  descendants(): FakeElement[] {
    return this.elementChildren().flatMap((child) => [child, ...child.descendants()]);
  }

  texts(): string[] {
    return this.elementChildren().map((child) => child.textContent);
  }
}

class FakeDocument {
  readonly activeElement = null;
  private readonly registry = new Map<string, FakeElement>();

  constructor(page: string) {
    for (const match of page.matchAll(/<(\w+)[^>]*\sid="([^"]+)"/g)) {
      this.registry.set(match[2] ?? "", new FakeElement(match[1] ?? "div"));
    }
  }

  createElement(tag: string): FakeElement {
    return new FakeElement(tag);
  }

  createTextNode(text: string): FakeText {
    return new FakeText(text);
  }

  getElementById(id: string): FakeElement {
    const found = this.registry.get(id);
    if (!found) throw new Error(`the page asked for #${id}, which the page shim does not know`);
    return found;
  }
}

export function pageState(overrides: Partial<UiState> = {}): UiState {
  const inFlight = (overrides.started ?? false) && !(overrides.complete ?? false);
  return {
    version: 2,
    rev: 1,
    boot: "test-boot",
    stages: ["queued", "develop", "simplify", "review", "verify", "merged"],
    mode: "dry",
    tracker: "github",
    hubRepo: "example-org/hub",
    startCap: 1,
    preselectedParent: undefined,
    parent: undefined,
    cap: 1,
    paused: false,
    started: false,
    complete: false,
    running: 0,
    stalled: undefined,
    hold: undefined,
    canStart: !inFlight,
    featureVerify: idleFeatureVerify(),
    polish: idlePolish(),
    canReset: false,
    resetting: false,
    phaseCounts: phaseCounts([]),
    queue: [],
    queueCap: 1,
    queueSettings: { mode: "sequential", maxParallel: 2, globalCap: 1, parentCap: 1, paused: false },
    runs: [],
    globalRunning: 0,
    items: [],
    feed: [],
    ...overrides,
  };
}

export function pageRun(number: number, items: UiItem[], overrides: Partial<UiRun> = {}): UiRun {
  return {
    parent: {
      number,
      title: `parent ${number}`,
      feature: `feature-${number}`,
      integrationBranch: `integration/feature-${number}`,
      url: `https://github.com/example-org/hub/issues/${number}`,
    },
    cap: 1,
    paused: false,
    started: true,
    complete: false,
    settled: false,
    running: 0,
    stalled: undefined,
    hold: undefined,
    featureVerify: idleFeatureVerify(),
    polish: idlePolish(),
    phaseCounts: phaseCounts(items),
    items,
    ...overrides,
  };
}

export function pageItem(number: number, repo: string, phase: string): UiItem {
  return {
    number,
    title: `item ${number}`,
    repo: repo as TargetRepo,
    phase: phase as UiItem["phase"],
    stage: undefined,
    stageIndex: 0,
    branch: `sandcastle/${number}`,
    dependsOn: [],
    blockers: [],
    parkReason: undefined,
    waitReason: undefined,
    resumeAt: undefined,
    pullRequestUrl: undefined,
    reworkRound: 0,
    reworkLimit: 3,
    phaseSince: "2026-10-21T09:00:00.000Z",
    quiet: undefined,
    issueUrl: `https://github.com/example-org/hub/issues/${number}`,
  };
}

export interface PageOptions {
  parents?: ParentSummary[];
  state?: UiState;
  startRun?: () => Promise<unknown>;
  resetPlan?: unknown;
  resetReport?: unknown;
}

export interface SentRequest {
  method: string;
  path: string;
  body: unknown;
}

export interface Page {
  el(id: string): FakeElement;
  requests(): SentRequest[];
  click(element: FakeElement | undefined): Promise<void>;
  change(id: string, value: string): Promise<void>;
  read<T>(expression: string): T;
  parentsCalls(): number;
  runCalls(): { parent: number; cap: number }[];
  setParents(parents: ParentSummary[]): void;
  emitState(state: UiState): Promise<void>;
  poll(): Promise<void>;
  filter(query: string): Promise<void>;
  pick(value: string): Promise<void>;
  clickStart(): Promise<void>;
  resetCalls(): { parent: number; apply: boolean }[];
  clickReset(): Promise<void>;
  clickResetApply(): Promise<void>;
  clickResetClose(): Promise<void>;
  clickDoneChip(column: FakeElement): Promise<void>;
  columns(): FakeElement[];
  settle(): Promise<void>;
}

function jsonResponse(payload: unknown): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: () => Promise.resolve(payload) };
}

export async function openPage(options: PageOptions = {}): Promise<Page> {
  const html = readFileSync(PAGE_FILE, "utf8");
  const document = new FakeDocument(html);
  let parents = options.parents ?? [];
  const state = options.state ?? pageState();
  let parentsCalls = 0;
  const runCalls: { parent: number; cap: number }[] = [];
  const resetCalls: { parent: number; apply: boolean }[] = [];
  const requests: SentRequest[] = [];
  const streamed = new Map<string, (event: { data: string }) => void>();
  const intervals: (() => void)[] = [];

  const fetchShim = (path: string, init?: { method?: string; body?: string }): Promise<unknown> => {
    if (init?.method !== undefined) requests.push({ method: init.method, path, body: JSON.parse(init.body ?? "{}") });
    if (init?.method === "PUT" || init?.method === "DELETE") return Promise.resolve(jsonResponse({ ok: true, result: null }));
    if (init?.method === "POST") {
      if (path === "/api/reset") {
        const body = JSON.parse(init.body ?? "{}") as { parent: number; apply?: boolean };
        const applied = body.apply === true;
        resetCalls.push({ parent: body.parent, apply: applied });
        return Promise.resolve(
          jsonResponse({ ok: true, result: applied ? options.resetReport : options.resetPlan, applied }),
        );
      }
      if (path === "/api/run") runCalls.push(JSON.parse(init.body ?? "{}") as { parent: number; cap: number });
      const pending = options.startRun && path === "/api/run" ? options.startRun() : Promise.resolve(null);
      return pending.then(() => jsonResponse({ ok: true, result: null }));
    }
    if (path === "/api/parents") {
      parentsCalls += 1;
      return Promise.resolve(jsonResponse({ parents }));
    }
    return Promise.resolve(jsonResponse(state));
  };

  class FakeEventSource {
    constructor(readonly url: string) {}

    addEventListener(name: string, handler: (event: { data: string }) => void): void {
      streamed.set(name, handler);
    }
  }

  const context = createContext({
    document,
    fetch: fetchShim,
    EventSource: FakeEventSource,
    setTimeout,
    clearTimeout,
    setInterval: (handler: () => void) => {
      intervals.push(handler);
      return intervals.length;
    },
    clearInterval: () => undefined,
    console,
  });

  const script = html.slice(html.indexOf("<script>") + "<script>".length, html.lastIndexOf("</script>"));
  runInContext(script, context);

  const settle = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  await settle();

  const el = (id: string): FakeElement => document.getElementById(id);
  const fire = async (handler: (() => void) | null): Promise<void> => {
    handler?.();
    await settle();
  };

  return {
    el,
    requests: () => requests,
    click: (element) => fire(element?.onclick ?? null),
    change: async (id, value) => {
      const input = el(id);
      input.value = value;
      input.onchange?.({ target: { value } });
      await settle();
    },
    read: <T,>(expression: string): T => runInContext(expression, context) as T,
    parentsCalls: () => parentsCalls,
    runCalls: () => runCalls,
    setParents: (next) => {
      parents = next;
    },
    emitState: async (next) => {
      streamed.get("state")?.({ data: JSON.stringify({ state: next }) });
      await settle();
    },
    poll: async () => {
      for (const handler of intervals) handler();
      await settle();
    },
    filter: async (query) => {
      const input = el("parent-filter");
      input.value = query;
      input.oninput?.({ target: { value: query } });
      await settle();
    },
    pick: async (value) => {
      const select = el("parent");
      select.value = value;
      select.onchange?.({ target: { value } });
      await settle();
    },
    clickStart: () => fire(el("start").onclick),
    resetCalls: () => resetCalls,
    clickReset: () => fire(el("reset").onclick),
    clickResetApply: () => fire(el("reset-apply").onclick),
    clickResetClose: () => fire(el("reset-close").onclick),
    clickDoneChip: (column) => {
      const chip = column.elementChildren().find((child) => child.className === "done-chip");
      return fire(chip?.onclick ?? null);
    },
    columns: () => el("board").elementChildren(),
    settle,
  };
}
