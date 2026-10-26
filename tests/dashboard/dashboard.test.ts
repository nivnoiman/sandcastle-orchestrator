import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDashboardApp } from "../../src/dashboard/app.js";
import { createProjectLauncher, SANDCASTLE_BIN, type SpawnFn } from "../../src/dashboard/launcher.js";
import { createInstanceRegistry, projectId, type InstanceRegistry } from "../../src/registry/index.js";
import { guardOrigin } from "../../src/ui/server.js";

interface Seen {
  method: string;
  url: string;
  host: string | undefined;
  header: string | undefined;
  body: string;
}

let registryDir: string;
let alive: Set<number>;
let registry: InstanceRegistry;
const servers: Server[] = [];

beforeEach(() => {
  registryDir = mkdtempSync(join(tmpdir(), "sc-dash-"));
  alive = new Set();
  registry = createInstanceRegistry({ registryDir, isAlive: (pid) => alive.has(pid) });
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
  rmSync(registryDir, { recursive: true, force: true });
});

function listen(server: Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

/** A stand-in Project Server with the real Host/header guard. */
async function fakeProject(dir: string, pid: number): Promise<{ port: number; seen: Seen[]; endEvents(): void }> {
  const seen: Seen[] = [];
  let events: express.Response | undefined;
  const app = express();
  app.use(guardOrigin);
  app.use(express.text({ type: "*/*" }));
  app.use((request, _response, next) => {
    seen.push({ method: request.method, url: request.url, host: request.headers.host, header: request.get("x-sandcastle"), body: typeof request.body === "string" ? request.body : "" });
    next();
  });
  app.get("/api/state", (_request, response) => response.json({ ok: true, dir }));
  app.get("/legacy", (_request, response) => response.type("html").send('<script>fetch("/api/state")</script>'));
  app.get("/api/events", (_request, response) => {
    response.set({ "content-type": "text/event-stream", "cache-control": "no-cache" });
    response.flushHeaders();
    response.write("event: state\ndata: {\"n\":1}\n\n");
    events = response;
  });
  app.post("/api/pause", (_request, response) => response.json({ ok: true, result: null }));
  const port = await listen(createServer(app));
  alive.add(pid);
  registry.register({ dir, name: dir, pid, port, mode: "real" });
  return { port, seen, endEvents: () => events?.end() };
}

async function dashboard(startProject: (id: string) => Promise<unknown> = async () => undefined): Promise<number> {
  return listen(createServer(createDashboardApp({ registry, startProject, isAlive: (pid) => alive.has(pid) })));
}

interface Reply {
  status: number;
  body: string;
}

function call(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (reply) => {
      let text = "";
      reply.on("data", (chunk) => (text += chunk));
      reply.on("end", () => resolve({ status: reply.statusCode ?? 0, body: text }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

const WRITE = { "x-sandcastle": "1", "content-type": "text/plain" };

describe("dashboard proxy guard", () => {
  it("refuses a foreign Host before reaching any Project Server", async () => {
    const project = await fakeProject("/work/a", 100);
    const port = await dashboard();
    const reply = await call(port, "GET", `/p/${projectId("/work/a")}/api/state`, { host: "evil.example.com" });
    expect(reply.status).toBe(403);
    expect(project.seen).toHaveLength(0);
  });

  it("refuses a write without the x-sandcastle header on the first hop", async () => {
    const project = await fakeProject("/work/a", 100);
    const port = await dashboard();
    const reply = await call(port, "POST", `/p/${projectId("/work/a")}/api/pause`, { "content-type": "text/plain" }, "{}");
    expect(reply.status).toBe(403);
    expect(project.seen).toHaveLength(0);
  });

  it("forwards the header and rewrites Host to the upstream port, adding no authority", async () => {
    const project = await fakeProject("/work/a", 100);
    const port = await dashboard();
    const id = projectId("/work/a");
    const written = await call(port, "POST", `/p/${id}/api/pause`, WRITE, "{}");
    expect(written.status).toBe(200);
    expect(project.seen[0]).toMatchObject({ method: "POST", url: "/api/pause", host: `127.0.0.1:${project.port}`, header: "1", body: "{}" });

    const read = await call(port, "GET", `/p/${id}/api/state`);
    expect(read.status).toBe(200);
    expect(project.seen[1]?.header).toBeUndefined();
  });

  it("proxies only api and legacy paths", async () => {
    const project = await fakeProject("/work/a", 100);
    const port = await dashboard();
    const reply = await call(port, "GET", `/p/${projectId("/work/a")}/board/board.js`);
    expect(reply.status).toBe(404);
    expect(project.seen).toHaveLength(0);
  });

  it("points the legacy page's api calls back through the proxy", async () => {
    await fakeProject("/work/a", 100);
    const port = await dashboard();
    const id = projectId("/work/a");
    const reply = await call(port, "GET", `/p/${id}/legacy`);
    expect(reply.body).toContain(`fetch("/p/${id}/api/state")`);
  });
});

describe("dashboard SSE passthrough", () => {
  it("streams events as they arrive instead of buffering", async () => {
    const project = await fakeProject("/work/a", 100);
    const port = await dashboard();
    const chunks: string[] = [];
    const head = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = httpRequest({ host: "127.0.0.1", port, path: `/p/${projectId("/work/a")}/api/events`, headers: { host: `127.0.0.1:${port}` } }, resolve);
      request.on("error", reject);
      request.end();
    });
    expect(head.headers["content-type"]).toContain("text/event-stream");
    const first = new Promise<void>((resolve) => head.on("data", (chunk) => {
      chunks.push(String(chunk));
      if (chunks.join("").includes('{"n":1}')) resolve();
    }));
    await first;
    expect(chunks.join("")).toContain("event: state");
    const ended = new Promise((resolve) => head.on("end", resolve));
    project.endEvents();
    await ended;
  });
});

describe("dashboard with dead servers", () => {
  it("answers 502 with a clear error when the port refuses connections", async () => {
    const project = await fakeProject("/work/a", 100);
    const port = await dashboard();
    const down = servers[0] as Server;
    down.closeAllConnections();
    await new Promise((done) => down.close(done));
    expect(project.port).toBeGreaterThan(0);
    const reply = await call(port, "GET", `/p/${projectId("/work/a")}/api/state`);
    expect(reply.status).toBe(502);
    expect(JSON.parse(reply.body).error).toMatch(/not reachable/);
  });

  it("answers 404 for an unknown project and 502 for a stopped one", async () => {
    await fakeProject("/work/a", 100);
    registry.deregister("/work/a", 100);
    const port = await dashboard();
    expect((await call(port, "GET", "/p/deadbeef/api/state")).status).toBe(404);
    expect((await call(port, "GET", `/p/${projectId("/work/a")}/api/state`)).status).toBe(502);
  });

  it("lists a killed server as died and a cleanly stopped one as stopped", async () => {
    await fakeProject("/work/killed", 100);
    await fakeProject("/work/stopped", 200);
    registry.deregister("/work/stopped", 200);
    alive.delete(100);
    const port = await dashboard();
    const reply = await call(port, "GET", "/dashboard/api/projects");
    const sources = JSON.parse(reply.body).result as { id: string; status: string; apiBase: string }[];
    expect(Object.fromEntries(sources.map((source) => [source.id, source.status]))).toEqual({
      [projectId("/work/killed")]: "died",
      [projectId("/work/stopped")]: "stopped",
    });
    expect(sources[0]?.apiBase).toBe(`/p/${sources[0]?.id}`);
    const again = JSON.parse((await call(port, "GET", "/dashboard/api/projects")).body).result as { id: string; status: string }[];
    expect(again.find((source) => source.id === projectId("/work/killed"))?.status).toBe("died");
  });
});

describe("dashboard pause all", () => {
  it("fans out a pause to every running Project Server", async () => {
    const a = await fakeProject("/work/a", 100);
    const b = await fakeProject("/work/b", 200);
    const port = await dashboard();
    const reply = await call(port, "POST", "/dashboard/api/pause-all", WRITE, "{}");
    expect(JSON.parse(reply.body).result.paused).toHaveLength(2);
    for (const project of [a, b]) expect(project.seen[0]).toMatchObject({ url: "/api/pause", header: "1" });
  });
});

describe("dashboard project launcher", () => {
  interface SpawnCall {
    command: string;
    args: string[];
    cwd: unknown;
    shell: unknown;
  }

  function spy(register?: (dir: string) => void): { spawnProcess: SpawnFn; calls: SpawnCall[] } {
    const calls: SpawnCall[] = [];
    const spawnProcess: SpawnFn = (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd, shell: options.shell });
      register?.(String(options.cwd));
      return Object.assign(new EventEmitter(), { unref: () => undefined }) as never;
    };
    return { spawnProcess, calls };
  }

  it("spawns exactly `sandcastle ui` in the Known Project's directory, by id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sc-known-"));
    try {
      registry.register({ dir, name: "known", pid: 100, port: 7001, mode: "real" });
      registry.deregister(dir, 100);
      const { spawnProcess, calls } = spy((cwd) => {
        alive.add(300);
        registry.register({ dir: cwd, pid: 300, port: 7002, mode: "real" });
      });
      const start = createProjectLauncher({ registry, spawnProcess, startTimeoutMs: 2000, pollMs: 10 });
      const port = await dashboard(start);
      const reply = await call(port, "POST", `/dashboard/api/projects/${projectId(dir)}/start`, WRITE, JSON.stringify({ args: ["--dry"], dir: "/etc", command: "rm" }));
      expect(reply.status).toBe(200);
      expect(calls).toEqual([{ command: process.execPath, args: [SANDCASTLE_BIN, "ui"], cwd: registry.get(projectId(dir))?.dir, shell: undefined }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never spawns for an unknown id, a path, or an already running project", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sc-known-"));
    try {
      alive.add(100);
      registry.register({ dir, pid: 100, port: 7001, mode: "real" });
      const { spawnProcess, calls } = spy();
      const start = createProjectLauncher({ registry, spawnProcess, startTimeoutMs: 100, pollMs: 10 });
      const port = await dashboard(start);
      expect((await call(port, "POST", "/dashboard/api/projects/nope/start", WRITE, "{}")).status).toBe(404);
      expect((await call(port, "POST", `/dashboard/api/projects/${encodeURIComponent(dir)}/start`, WRITE, "{}")).status).toBe(404);
      expect((await call(port, "POST", `/dashboard/api/projects/${projectId(dir)}/start`, WRITE, "{}")).status).toBe(409);
      expect((await call(port, "POST", `/dashboard/api/projects/${projectId(dir)}/start`, { "content-type": "text/plain" }, "{}")).status).toBe(403);
      expect(calls).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
