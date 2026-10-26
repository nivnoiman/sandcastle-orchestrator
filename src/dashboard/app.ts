import express, { type Express } from "express";
import { request as httpRequest } from "node:http";
import { isOperatorError } from "../engine/operatorError.js";
import { messageOf } from "../messageOf.js";
import type { InstanceRegistry } from "../registry/index.js";
import { boardPage, mountBoardAssets } from "../ui/board/assets.js";
import { guardOrigin, SANDCASTLE_HEADER, UI_HOST } from "../ui/server.js";
import { createCatalog } from "./catalog.js";
import { projectProxy } from "./proxy.js";

export interface DashboardDeps {
  registry: InstanceRegistry;
  /** Starts a stopped Known Project by id (`sandcastle ui` in its directory). */
  startProject: (id: string) => Promise<unknown>;
  isAlive?: (pid: number) => boolean;
}

const PROJECT_POLL_MS = 3000;

const MOUNT = `
const post = async (path) => {
  const response = await fetch(path, { method: "POST", headers: { "x-sandcastle": "1", "content-type": "application/json" }, body: "{}" });
  const payload = await response.json().catch(() => ({ error: "unreadable response" }));
  if (!response.ok) throw new Error(payload.error || path + " failed");
  return payload.result;
};
SandcastleBoard.mountBoard({
  root: document.getElementById("board"),
  scope: "dashboard",
  refreshProjectsMs: ${PROJECT_POLL_MS},
  projects: async () => {
    const response = await fetch("/dashboard/api/projects");
    return (await response.json()).result;
  },
  onAction: async (action, id) => {
    if (action === "restart") {
      await post("/dashboard/api/projects/" + encodeURIComponent(id) + "/start");
      return "Project Server started";
    }
    const result = await post("/dashboard/api/pause-all");
    if (result.failed.length > 0) throw new Error("Pause failed for: " + result.failed.map((f) => f.name + " (" + f.error + ")").join(", "));
    return result.paused.length === 0 ? "No running Project Server to pause" : "Paused " + result.paused.length + " Project Server" + (result.paused.length === 1 ? "" : "s");
  },
});`;

export interface PauseOutcome {
  paused: string[];
  failed: { id: string; name: string; error: string }[];
}

function postPause(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const upstream = httpRequest(
      { host: UI_HOST, port, method: "POST", path: "/api/pause", headers: { host: `${UI_HOST}:${port}`, [SANDCASTLE_HEADER]: "1", "content-type": "application/json", "content-length": 2 } },
      (reply) => {
        reply.resume();
        reply.on("end", () => ((reply.statusCode ?? 500) < 300 ? resolve() : reject(new Error(`HTTP ${reply.statusCode}`))));
      },
    );
    upstream.setTimeout(5000, () => upstream.destroy(new Error("timed out")));
    upstream.on("error", reject);
    upstream.end("{}");
  });
}

function startStatus(cause: unknown): number {
  if (!isOperatorError(cause)) return 500;
  return messageOf(cause).startsWith("unknown project") ? 404 : 409;
}

export function createDashboardApp(deps: DashboardDeps): Express {
  const { registry } = deps;
  const catalog = createCatalog(registry, deps.isAlive);
  const app = express();
  app.use(guardOrigin);

  app.get("/", (_request, response) => {
    response.type("html").set("cache-control", "no-cache").send(boardPage({ title: "Sandcastle dashboard", mountScript: MOUNT }));
  });
  mountBoardAssets(app);

  app.all("/p/:id/*rest", projectProxy(registry));

  app.use(express.json());

  app.get("/dashboard/api/projects", (_request, response) => {
    response.json({ ok: true, result: catalog.sources() });
  });

  app.post("/dashboard/api/projects/:id/start", (request, response) => {
    deps.startProject(request.params["id"] ?? "").then(
      () => response.json({ ok: true, result: null }),
      (cause: unknown) => response.status(startStatus(cause)).json({ ok: false, error: messageOf(cause) }),
    );
  });

  app.post("/dashboard/api/pause-all", (_request, response) => {
    const running = registry.running();
    Promise.allSettled(running.map((entry) => postPause(entry.port))).then((results) => {
      const outcome: PauseOutcome = { paused: [], failed: [] };
      results.forEach((result, index) => {
        const entry = running[index];
        if (!entry) return;
        if (result.status === "fulfilled") outcome.paused.push(entry.id);
        else outcome.failed.push({ id: entry.id, name: entry.name, error: messageOf(result.reason) });
      });
      response.json({ ok: true, result: outcome });
    });
  });

  return app;
}
