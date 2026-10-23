import { request as httpRequest } from "node:http";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { STAGE_CHAIN } from "../../src/engine/adapters.js";
import type { ItemPhase } from "../../src/engine/engine.js";
import type { ParentSummary } from "../../src/gh/parents.js";
import type { RunSnapshot } from "../../src/gh/snapshot.js";
import type { ResetPlan, ResetReport } from "../../src/real/reset.js";
import { UiController, type AttemptReader, type ResetOps, type StartSessionRequest } from "../../src/ui/controller.js";
import { hostIsLocal, PAGE_FILE, SANDCASTLE_HEADER, startUiServer, type UiServer } from "../../src/ui/server.js";
import { dryRunSession } from "../../src/ui/sessions.js";
import { AttemptLogStore } from "../../src/real/attemptLog.js";
import { MemoryFileSystem } from "../../src/real/fileSystem.js";
import { testLayout } from "../real/support.js";
import { ITEM_PHASES, phaseCounts, UI_STAGE_CHAIN, type UiState } from "../../src/ui/state.js";
import { snapshot } from "../fixtures.js";

const PARENTS = [{ number: 16, title: "demo: toy feature", subIssues: 3, completedSubIssues: 0 }];

interface BootOptions {
  loadSnapshot?: () => Promise<RunSnapshot>;
  listParents?: () => Promise<ParentSummary[]>;
  startCap?: number;
  preselectedParent?: number;
  reset?: ResetOps;
  attempts?: AttemptReader;
}

export function testResetPlan(): ResetPlan {
  return {
    lock: { path: "/w/sandcastle/.orchestrator.lock", reclaim: true, pid: 4242 },
    labels: [{ itemNumber: 17, remove: ["sc:needs-human"], swapToAgent: true }],
    branches: [
      {
        repo: "api",
        branch: "feat/17-toy-slice",
        localExists: true,
        remoteExists: false,
        commitsAhead: 0,
        removable: true,
        verdict: "empty beyond origin/integration/toy-demo",
      },
    ],
    orphans: { containers: ["sc-demo-develop-17-a"], networks: [], volumes: [], worktrees: [], failures: [] },
  };
}

export function testResetReport(): ResetReport {
  return {
    gc: { containers: ["sc-demo-develop-17-a"], networks: [], volumes: [], worktrees: [], failures: [] },
    lockReclaimed: true,
    labelled: [17],
    deletedBranches: ["[api] feat/17-toy-slice"],
    failures: [],
  };
}

interface RecordingResetOptions {
  plans?: ResetPlan[];
  report?: ResetReport;
}

function recordingReset(options: RecordingResetOptions = {}) {
  const calls: string[] = [];
  const applied: ResetPlan[] = [];
  const queued = [...(options.plans ?? [])];
  const nextPlan = (): ResetPlan => queued.shift() ?? testResetPlan();
  const ops: ResetOps = {
    plan: (parent) => {
      calls.push(`plan #${parent}`);
      return Promise.resolve(nextPlan());
    },
    apply: (parent) => {
      calls.push(`apply #${parent}`);
      applied.push(nextPlan());
      return Promise.resolve(options.report ?? testResetReport());
    },
  };
  return { calls, applied, ops };
}

function gatedReset() {
  let open = (): void => undefined;
  let began = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const ops: ResetOps = {
    plan: () => Promise.resolve(testResetPlan()),
    apply: () => {
      began();
      return gate.then(() => testResetReport());
    },
  };
  return { ops, started, release: () => open() };
}

interface Booted {
  server: UiServer;
  controller: UiController;
  advance: (ms: number) => void;
  get: (path: string) => Promise<{ status: number; body: unknown }>;
  post: (path: string, body?: unknown) => Promise<{ status: number; body: unknown }>;
  command: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: unknown }>;
  rawPost: (path: string, headers: Record<string, string>) => Promise<{ status: number; body: unknown }>;
  raw: (method: string, path: string, headers: Record<string, string>) => Promise<{ status: number; body: unknown }>;
  state: () => Promise<UiState>;
}

let booted: Booted | undefined;

async function boot(options: BootOptions = {}): Promise<Booted> {
  let clock = 0;
  const controller = new UiController({
    mode: "dry",
    hubRepo: "example-org/hub",
    startCap: options.startCap ?? 1,
    preselectedParent: options.preselectedParent,
    listParents: options.listParents ?? (() => Promise.resolve(PARENTS)),
    loadSnapshot: options.loadSnapshot ?? (() => Promise.resolve(snapshot())),
    startSession: (request: StartSessionRequest) => ({
      ...dryRunSession(request, { now: () => clock, delayMs: () => 1000 }),
      ...(options.attempts ? { attempts: options.attempts } : {}),
    }),
    reset: options.reset,
    now: () => new Date("2026-08-15T09:00:00.000Z"),
  });
  const server = await startUiServer(controller, 0);
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${server.url}${path}`, {
      method,
      headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text.startsWith("{") ? (JSON.parse(text) as unknown) : text };
  };
  const command = (method: string, path: string, body?: unknown) =>
    call(method, path, body ?? {}, { [SANDCASTLE_HEADER]: "1" });
  const raw = (method: string, path: string, headers: Record<string, string>) =>
    rawRequest(server.port, method, path, headers);
  booted = {
    server,
    controller,
    advance: (ms: number) => {
      clock += ms;
      controller.tick();
    },
    get: (path) => call("GET", path),
    post: (path, body) => command("POST", path, body),
    command,
    rawPost: (path, headers) => raw("POST", path, headers),
    raw,
    state: async () => (await call("GET", "/api/state")).body as UiState,
  };
  return booted;
}

function rawRequest(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ host: "127.0.0.1", port, method, path, headers }, (response) => {
      let text = "";
      response.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
      });
      response.on("end", () =>
        resolve({ status: response.statusCode ?? 0, body: text.startsWith("{") ? (JSON.parse(text) as unknown) : text }),
      );
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

async function bootRunning(cap = 2): Promise<Booted> {
  const running = await boot();
  const started = await running.post("/api/run", { parent: 16, cap });
  expect(started.status).toBe(200);
  return running;
}

afterEach(async () => {
  await booted?.server.close();
  booted = undefined;
});

describe("reset from the control plane", () => {
  it("returns the plan and changes nothing until apply is asked for", async () => {
    const { calls, ops } = recordingReset();
    const { post } = await boot({ reset: ops });
    const response = await post("/api/reset", { parent: 16 });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, result: testResetPlan(), applied: false });
    expect(calls).toEqual(["plan #16"]);
  });

  it("applies the plan it reads at apply time, not the one the browser is holding", async () => {
    const stale = testResetPlan();
    const fresh = testResetPlan();
    fresh.branches[0]!.removable = false;
    fresh.branches[0]!.commitsAhead = 2;
    fresh.branches[0]!.verdict = "2 commit(s) beyond origin/integration/toy-demo — somebody's work, keeping it";
    const { calls, applied, ops } = recordingReset({ plans: [stale, fresh] });
    const { post } = await boot({ reset: ops });

    const read = await post("/api/reset", { parent: 16 });
    expect(read.body).toEqual({ ok: true, result: stale, applied: false });

    const response = await post("/api/reset", { parent: 16, apply: true });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, result: testResetReport(), applied: true });
    expect(calls).toEqual(["plan #16", "apply #16"]);
    expect(applied).toEqual([fresh]);
  });

  it("refuses while a run is in flight, so it cannot reap that run's own containers", async () => {
    const { calls, ops } = recordingReset();
    const running = await boot({ reset: ops });
    expect((await running.post("/api/run", { parent: 16, cap: 1 })).status).toBe(200);
    const response = await running.post("/api/reset", { parent: 16 });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ ok: false });
    expect(String((response.body as { error: string }).error)).toMatch(/stop it before resetting/);
    expect(calls).toEqual([]);
  });

  it("refuses when the ui has no reset wired, which is every dry run", async () => {
    const { post } = await boot();
    const response = await post("/api/reset", { parent: 16 });
    expect(response.status).toBe(409);
    expect(String((response.body as { error: string }).error)).toMatch(/only available in real mode/);
  });

  it("rejects a missing or nonsense parent before touching anything", async () => {
    const { calls, ops } = recordingReset();
    const { post } = await boot({ reset: ops });
    expect((await post("/api/reset", {})).status).toBe(400);
    expect((await post("/api/reset", { parent: 0 })).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("advertises whether reset is available so the page can gate the button", async () => {
    const { calls: _calls, ops } = recordingReset();
    const withReset = await boot({ reset: ops });
    expect((await withReset.state()).canReset).toBe(true);
    expect((await withReset.post("/api/run", { parent: 16, cap: 1 })).status).toBe(200);
    expect((await withReset.state()).canReset).toBe(false);
  });

  it("holds the door shut while it works — no run may start, no second reset may begin", async () => {
    const { ops, started, release } = gatedReset();
    const { post, state } = await boot({ reset: ops });
    const applying = post("/api/reset", { parent: 16, apply: true });
    await started;

    const held = await state();
    expect(held.resetting).toBe(true);
    expect(held.canReset).toBe(false);

    const refusedRun = await post("/api/run", { parent: 16, cap: 1 });
    expect(refusedRun.status).toBe(409);
    expect(String((refusedRun.body as { error: string }).error)).toMatch(/a reset is in flight/);

    const refusedReset = await post("/api/reset", { parent: 16, apply: true });
    expect(refusedReset.status).toBe(409);
    expect(String((refusedReset.body as { error: string }).error)).toMatch(/already in flight/);

    release();
    expect((await applying).status).toBe(200);
    const settled = await state();
    expect(settled.resetting).toBe(false);
    expect(settled.canReset).toBe(true);
  });

  it("counts a gc failure as a failure, rather than reporting a clean sweep", async () => {
    const report = testResetReport();
    report.gc.failures = ["docker rm sc-demo-develop-17-a failed: device busy"];
    const { ops } = recordingReset({ report });
    const { post, state } = await boot({ reset: ops });
    await post("/api/reset", { parent: 16, apply: true });
    const feed = (await state()).feed;
    expect(feed.some((line) => line.kind === "warn" && line.message.includes("1 failure(s)"))).toBe(true);
    expect(feed.some((line) => line.kind === "warn" && line.message.includes("device busy"))).toBe(true);
  });

  it("reports what it did into the run feed", async () => {
    const { ops } = recordingReset();
    const { post, state } = await boot({ reset: ops });
    await post("/api/reset", { parent: 16, apply: true });
    const feed = (await state()).feed.map((line) => line.message);
    expect(feed.some((message) => message.includes("reset #16") && message.includes("1 branch(es) deleted"))).toBe(true);
  });
});

describe("the page and the read endpoints", () => {
  it("serves the control-plane page", async () => {
    const { get } = await boot();
    const page = await get("/");
    expect(page.status).toBe(200);
    expect(String(page.body)).toContain("sandcastle");
  });

  it("reports an empty run before anything starts", async () => {
    const { state } = await boot();
    const current = await state();

    expect(current).toMatchObject({ mode: "dry", started: false, items: [], complete: false });
    expect(current.parent).toBeUndefined();
  });

  it("lists the sandcastle parents the operator can pick", async () => {
    const { get } = await boot();
    expect((await get("/api/parents")).body).toEqual({ parents: PARENTS });
  });

  it("streams the current state to a fresh event-stream subscriber", async () => {
    const { server } = await bootRunning();
    const aborter = new AbortController();
    const response = await fetch(`${server.url}/api/events`, { signal: aborter.signal });
    const chunk = await response.body!.getReader().read();
    aborter.abort();

    const text = new TextDecoder().decode(chunk.value);
    expect(text).toContain("event: state");
    expect(text).toContain('"number":17');
  });
});

describe("starting a run", () => {
  it("loads the run model, starts the paced session, and reports the parent", async () => {
    const { state } = await bootRunning();
    const current = await state();

    expect(current).toMatchObject({ started: true, cap: 2, running: 1 });
    expect(current.parent).toMatchObject({ number: 16, feature: "toy-demo", integrationBranch: "integration/toy-demo" });
    expect(current.items.map((item) => [item.number, item.phase])).toEqual([
      [17, "running"],
      [18, "blocked"],
      [19, "held"],
    ]);
  });

  it("advances the stage chain as the paced clock moves", async () => {
    const { state, advance } = await bootRunning();
    advance(1000);

    expect((await state()).items[0]).toMatchObject({ phase: "running", stage: "simplify" });
  });

  it("refuses a second run while one is in flight", async () => {
    const { post } = await bootRunning();
    const second = await post("/api/run", { parent: 16, cap: 1 });

    expect(second.status).toBe(409);
    expect((second.body as { error: string }).error).toBe("a run is already in flight — queue it instead");
  });

  it("refuses a second run that arrives while the first one is still loading its snapshot", async () => {
    let arrived: (() => void) | undefined;
    let release: (() => void) | undefined;
    const reached = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { post, state } = await boot({
      loadSnapshot: async () => {
        arrived?.();
        await gate;
        return snapshot();
      },
    });

    const first = post("/api/run", { parent: 16, cap: 1 });
    await reached;
    const second = await post("/api/run", { parent: 16, cap: 2 });
    expect(second.status).toBe(409);
    expect((second.body as { error: string }).error).toBe("a run is already in flight — queue it instead");

    release?.();
    expect((await first).status).toBe(200);
    expect((await state()).cap).toBe(1);
  });

  it("frees the start lock again when the snapshot cannot be loaded", async () => {
    let attempts = 0;
    const { post } = await boot({
      loadSnapshot: () => {
        attempts += 1;
        return attempts === 1 ? Promise.reject(new Error("gh is down")) : Promise.resolve(snapshot());
      },
    });

    expect((await post("/api/run", { parent: 16, cap: 1 })).status).toBe(500);
    expect((await post("/api/run", { parent: 16, cap: 1 })).status).toBe(200);
  });

  it("reports an unexpected failure as a 500 rather than a conflict", async () => {
    const { get } = await boot({ listParents: () => Promise.reject(new Error("gh exploded")) });
    const listed = await get("/api/parents");

    expect(listed.status).toBe(500);
    expect(listed.body).toMatchObject({ error: "gh exploded" });
  });

  it("rejects a request that does not name a parent and a cap", async () => {
    const { post } = await boot();
    expect((await post("/api/run", { parent: 16 })).status).toBe(400);
    expect((await post("/api/run", { parent: 0, cap: 1 })).status).toBe(400);
  });
});

describe("operator commands", () => {
  it("cancels a running item into a parked one and retries it back onto its stage", async () => {
    const { post, state } = await bootRunning();

    expect((await post("/api/items/17/cancel")).status).toBe(200);
    const parked = (await state()).items[0];
    expect(parked).toMatchObject({ phase: "parked", parkReason: "cancelled by operator" });

    expect((await post("/api/items/17/retry")).status).toBe(200);
    expect((await state()).items[0]).toMatchObject({ phase: "running", stage: "develop" });
  });

  it("refuses to cancel an item that is not running", async () => {
    const { post } = await bootRunning();
    const rejected = await post("/api/items/18/cancel");

    expect(rejected.status).toBe(409);
    expect(rejected.body).toMatchObject({ error: "#18 is blocked, not running — only a running item can be cancelled" });
  });

  it("pauses and resumes new starts", async () => {
    const { post, state } = await bootRunning();

    await post("/api/pause");
    expect((await state()).paused).toBe(true);

    await post("/api/resume");
    expect((await state()).paused).toBe(false);
  });

  it("sets the global worker cap and rejects an impossible one", async () => {
    const { post, state } = await bootRunning(1);

    expect((await post("/api/cap", { value: 3 })).status).toBe(200);
    expect((await state()).queueSettings.globalCap).toBe(3);
    expect((await state()).cap).toBe(1);
    expect((await post("/api/cap", { value: 0 })).status).toBe(400);
  });

  it("refuses every command until a run has started", async () => {
    const { post } = await boot();
    const rejected = await post("/api/pause");

    expect(rejected.status).toBe(409);
    expect(rejected.body).toMatchObject({ error: "no run has started yet" });
  });
});

describe("event fan-out", () => {
  it("keeps the command working when one subscriber throws, and drops that subscriber", async () => {
    const { controller, post, state } = await bootRunning();
    let brokenCalls = 0;
    const seen: string[] = [];
    controller.subscribe(() => {
      brokenCalls += 1;
      throw new Error("the socket is gone");
    });
    controller.subscribe((event) => seen.push(event.kind));

    expect((await post("/api/pause")).status).toBe(200);
    expect((await post("/api/resume")).status).toBe(200);

    expect(brokenCalls).toBe(1);
    expect(seen.length).toBeGreaterThan(1);
    expect((await state()).paused).toBe(false);
  });
});

describe("hardening against other pages on the machine", () => {
  it("refuses a command that does not carry the sandcastle header", async () => {
    const { rawPost } = await bootRunning();
    const forged = await rawPost("/api/pause", { "content-type": "text/plain" });

    expect(forged.status).toBe(403);
    expect(forged.body).toMatchObject({ error: `commands must carry the ${SANDCASTLE_HEADER}: 1 header` });
  });

  it("refuses a DELETE or PUT that does not carry the sandcastle header", async () => {
    const { raw, post, state } = await bootRunning();
    await post("/api/queue", { parents: [99], cap: 1 });
    const deleted = await raw("DELETE", "/api/queue/99", {});
    const put = await raw("PUT", "/api/queue/mode", { "content-type": "application/json" });
    const options = await raw("OPTIONS", "/api/queue/99", {});

    for (const forged of [deleted, put, options]) {
      expect(forged.status).toBe(403);
      expect(forged.body).toMatchObject({ error: `commands must carry the ${SANDCASTLE_HEADER}: 1 header` });
    }
    expect((await state()).queue).toEqual([99]);
  });

  it("refuses a request addressed to any host but the loopback one", async () => {
    const { rawPost } = await bootRunning();
    const forged = await rawPost("/api/pause", { host: "sandcastle.example", [SANDCASTLE_HEADER]: "1" });

    expect(forged.status).toBe(403);
  });

  it("accepts the loopback names the page is served from", () => {
    expect(hostIsLocal("127.0.0.1:7777")).toBe(true);
    expect(hostIsLocal("localhost:7777")).toBe(true);
    expect(hostIsLocal("[::1]:7777")).toBe(true);
    expect(hostIsLocal("sandcastle.example")).toBe(false);
    expect(hostIsLocal(undefined)).toBe(false);
  });
});

describe("the start form", () => {
  it("hands the page the cap and the parent the cli was started with", async () => {
    const { state } = await boot({ startCap: 3, preselectedParent: 16 });
    const current = await state();

    expect(current).toMatchObject({ startCap: 3, preselectedParent: 16, cap: 3 });
  });

  it("keeps the page's stage chain in step with the engine's", () => {
    const page = readFileSync(PAGE_FILE, "utf8");
    const declared = /const UI_STAGES = (\[[^\]]*\]);/.exec(page);

    expect(declared).not.toBeNull();
    expect(JSON.parse(declared?.[1] ?? "[]") as string[]).toEqual([...UI_STAGE_CHAIN]);
    expect([...UI_STAGE_CHAIN]).toEqual(["queued", ...STAGE_CHAIN, "merged"]);
  });
});

function pageConstant(name: string): string[] {
  const page = readFileSync(PAGE_FILE, "utf8");
  const declared = new RegExp(`const ${name} = (\\[[^\\]]*\\]);`).exec(page);
  expect(declared, `${name} is missing from the page`).not.toBeNull();
  return JSON.parse(declared?.[1] ?? "[]") as string[];
}

describe("the board filter", () => {
  it("splits every phase the engine can report into active or collapsed", () => {
    const active = pageConstant("ACTIVE_PHASES");
    const collapsed = pageConstant("COLLAPSED_PHASES");

    expect(collapsed).toEqual(["done"]);
    expect([...active, ...collapsed].sort()).toEqual([...ITEM_PHASES].sort());
    expect(active.filter((phase) => collapsed.includes(phase))).toEqual([]);
    expect(active).toContain("parked");
    expect(active).toContain("held");
  });

  it("keeps the phase list in step with the engine's union and with the counters the page reads", () => {
    const everyPhase: Record<ItemPhase, true> = {
      held: true,
      blocked: true,
      queued: true,
      running: true,
      awaiting: true,
      waiting: true,
      parked: true,
      done: true,
    };

    expect([...ITEM_PHASES].sort()).toEqual(Object.keys(everyPhase).sort());
    expect(Object.keys(phaseCounts([]))).toEqual([...ITEM_PHASES]);
  });
});

describe("the parent picker", () => {
  it("groups parents as ready-to-merge, working and todo, in that order", () => {
    const page = readFileSync(PAGE_FILE, "utf8");
    const declared = /const PARENT_GROUPS = \[([\s\S]*?)\n\];/.exec(page);

    expect(declared).not.toBeNull();
    const states = [...(declared?.[1] ?? "").matchAll(/state: "([a-z-]+)"/g)].map((match) => match[1]);
    expect(states).toEqual(["ready-to-merge", "working", "todo"]);
    expect(page).toContain("waiting for your merge");
  });

  it("hands the page the sub-issue counts the three states are derived from", async () => {
    const { get } = await boot();
    const listed = (await get("/api/parents")).body as { parents: ParentSummary[] };

    expect(listed.parents[0]).toMatchObject({ subIssues: 3, completedSubIssues: 0 });
  });
});

describe("the feed", () => {
  it("keeps the run notes an operator needs after a reload", async () => {
    const { post, state } = await bootRunning();
    await post("/api/pause");

    const messages = (await state()).feed.map((line) => line.message);
    expect(messages.some((message) => message.includes("dry run started"))).toBe(true);
    expect(messages.at(-1)).toContain("new starts paused");
  });
});

describe("agent transcripts", () => {
  it("answers with no attempts for a run that keeps none", async () => {
    const { get } = await bootRunning();
    const response = await get("/api/items/17/attempts");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, result: [] });
  });

  it("says plainly that a dry run has no transcript to read", async () => {
    const { get } = await bootRunning();
    const response = await get("/api/attempts/17-develop-1/log");

    expect(response.status).toBe(409);
    expect((response.body as { error: string }).error).toContain("no agent transcripts");
  });

  it("refuses a from offset that is not a byte count", async () => {
    const { get } = await bootRunning();
    const response = await get("/api/attempts/17-develop-1/log?from=-5");

    expect(response.status).toBe(400);
  });

  it("serves the attempts and the log a real session records", async () => {
    const logs = new AttemptLogStore({ fs: new MemoryFileSystem(), layout: testLayout(), parentNumber: 16 });
    const writer = logs.begin(17, "develop");
    writer.write('{"type":"system","subtype":"init"}\n');
    const running = await boot({
      attempts: { list: (item?: number) => logs.list(item), read: (id: string, from?: number) => logs.read(id, from) },
    });
    expect((await running.post("/api/run", { parent: 16, cap: 2 })).status).toBe(200);
    const { get } = running;

    const attempts = (await get("/api/items/17/attempts")).body as { result: { id: string; stage: string }[] };
    expect(attempts.result[0]).toMatchObject({ id: "17-develop-1", stage: "develop" });

    const log = (await get("/api/attempts/17-develop-1/log")).body as { result: { chunk: string; running: boolean } };
    expect(log.result.chunk).toContain('"subtype":"init"');
    expect(log.result.running).toBe(true);
  });
});

describe("adding parents and queueing runs over http", () => {
  it("checks each pasted line and answers per line", async () => {
    const { post } = await boot();
    const response = await post("/api/parents", { text: "16\nnot-an-issue" });

    expect(response.status).toBe(200);
    const result = (response.body as { result: { ok: boolean }[] }).result;
    expect(result[0]).toMatchObject({ ok: true, number: 16 });
    expect(result[1]).toMatchObject({ ok: false });
  });

  it("refuses a body without text", async () => {
    const { post } = await boot();
    expect((await post("/api/parents", { parents: [16] })).status).toBe(400);
  });

  it("queues a parent behind the run in flight and can drop the queue again", async () => {
    const { post, state } = await bootRunning();

    expect((await post("/api/queue", { parents: [16], cap: 2 })).status).toBe(409);
    expect((await post("/api/queue", { parents: [99], cap: 2 })).status).toBe(200);
    expect((await state()).queue).toEqual([99]);

    expect((await post("/api/queue/clear")).status).toBe(200);
    expect((await state()).queue).toEqual([]);
  });

  it("refuses a queue call without a parent list", async () => {
    const { post } = await bootRunning();
    expect((await post("/api/queue", { cap: 1 })).status).toBe(400);
  });

  it("removes one queued parent and rejects a junk or unqueued one", async () => {
    const { post, command, state } = await bootRunning();
    await post("/api/queue", { parents: [98, 99], cap: 1 });

    expect((await command("DELETE", "/api/queue/98")).status).toBe(200);
    expect((await state()).queue).toEqual([99]);
    expect((await command("DELETE", "/api/queue/abc")).status).toBe(400);
    expect((await command("DELETE", "/api/queue/0x63")).status).toBe(400);
    expect((await command("DELETE", "/api/queue/9e1")).status).toBe(400);
    expect((await command("DELETE", "/api/queue/98")).status).toBe(409);
  });

  it("reorders the queue and rejects a body without a parent list", async () => {
    const { post, state } = await bootRunning();
    await post("/api/queue", { parents: [98, 99], cap: 1 });

    expect((await post("/api/queue/reorder", { parents: [99, 98] })).status).toBe(200);
    expect((await state()).queue).toEqual([99, 98]);
    expect((await post("/api/queue/reorder", { parents: "99,98" })).status).toBe(400);
    expect((await post("/api/queue/reorder", { parents: [99] })).status).toBe(409);
  });

  it("sets the queue mode and rejects an unknown mode or a bad limit", async () => {
    const { command, state } = await boot();

    expect((await command("PUT", "/api/queue/mode", { mode: "parallel", maxParallel: 3 })).status).toBe(200);
    expect((await state()).queueSettings).toMatchObject({ mode: "parallel", maxParallel: 3 });
    expect((await command("PUT", "/api/queue/mode", { mode: "sequential" })).status).toBe(200);
    expect((await state()).queueSettings).toMatchObject({ mode: "sequential", maxParallel: 3 });
    expect((await command("PUT", "/api/queue/mode", { mode: "bogus" })).status).toBe(400);
    expect((await command("PUT", "/api/queue/mode", { mode: "parallel", maxParallel: 0 })).status).toBe(400);
  });

  it("resumes a paused queue", async () => {
    const { post, state } = await boot();

    expect((await post("/api/queue/resume")).status).toBe(200);
    expect((await state()).queueSettings.paused).toBe(false);
  });
});

describe("per-run commands over http", () => {
  it("pauses, resumes, caps and stops one run", async () => {
    const { post, state } = await bootRunning();
    const run = async () => (await state()).runs.find((entry) => entry.parent.number === 16);

    expect((await post("/api/runs/16/pause")).status).toBe(200);
    expect((await run())?.paused).toBe(true);
    expect((await post("/api/runs/16/resume")).status).toBe(200);
    expect((await run())?.paused).toBe(false);
    expect((await post("/api/runs/16/cap", { cap: 3 })).status).toBe(200);
    expect((await run())?.cap).toBe(3);
    expect((await post("/api/runs/16/stop")).status).toBe(200);
  });

  it("rejects a junk parent, a bad cap and a parent without a run", async () => {
    const { post } = await bootRunning();

    expect((await post("/api/runs/abc/stop")).status).toBe(400);
    expect((await post("/api/runs/16/cap", { cap: 0 })).status).toBe(400);
    expect((await post("/api/runs/99/pause")).status).toBe(409);
  });
});
