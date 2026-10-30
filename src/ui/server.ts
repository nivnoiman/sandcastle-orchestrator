import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { isOperatorError } from "../engine/operatorError.js";
import { parseAttemptId } from "../real/attemptLog.js";
import type { UiController } from "./controller.js";
import { isQueueMode, QUEUE_MODES, type QueueMode } from "./runQueue.js";
import { messageOf } from "../messageOf.js";
import { DEFAULT_UI_PORT, isTcpPort, tcpPort } from "../project/projectConfig.js";
import { boardPage, mountBoardAssets, warmBoardAssets } from "./board/assets.js";
import { mountPushRoutes, type PushRouteDeps } from "../push/routes.js";

export const PAGE_FILE = join(import.meta.dirname, "page.html");

function portSetting(raw: string, where: string): number {
  const port = Number(raw);
  if (raw.trim().length === 0 || !isTcpPort(port)) {
    throw new Error(`${where}="${raw}" is not a tcp port (1-65535)`);
  }
  return port;
}

/** The control plane port: `--port=N`, then `SANDCASTLE_UI_PORT`, then the project's `ui.port` (default 7777). */
export function resolveUiPort(args: readonly string[], env: NodeJS.ProcessEnv, configured: number = DEFAULT_UI_PORT): number {
  const flag = args.find((arg) => arg.startsWith("--port="));
  if (flag !== undefined) return portSetting(flag.slice("--port=".length), "--port");
  const fromEnv = env["SANDCASTLE_UI_PORT"];
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return portSetting(fromEnv, "SANDCASTLE_UI_PORT");
  return tcpPort(configured, "ui.port");
}

export const UI_HOST = "127.0.0.1";
export const SANDCASTLE_HEADER = "x-sandcastle";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const READ_METHODS = new Set(["GET", "HEAD"]);

class BadRequest extends Error {}

function requiredInteger(value: unknown, name: string): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new BadRequest(`${name} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

function bodyField(request: Request, name: string): unknown {
  const body: unknown = request.body;
  if (typeof body !== "object" || body === null) throw new BadRequest(`expected a JSON body with "${name}"`);
  return (body as Record<string, unknown>)[name];
}

function parentList(request: Request): number[] {
  const value = bodyField(request, "parents");
  if (!Array.isArray(value)) throw new BadRequest('expected a JSON body with "parents"');
  return value.map((parent) => requiredInteger(parent, "parent"));
}

function queueMode(value: unknown): QueueMode {
  if (!isQueueMode(value)) throw new BadRequest(`mode must be one of ${QUEUE_MODES.join(", ")}, got ${JSON.stringify(value)}`);
  return value;
}

function optionalInteger(value: unknown, name: string): number | undefined {
  return value === undefined ? undefined : requiredInteger(value, name);
}

function routeParent(request: Request): number {
  const value = request.params.parent;
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    throw new BadRequest(`parent must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return requiredInteger(value, "parent");
}

function send(response: Response, run: () => unknown): void {
  try {
    response.json({ ok: true, result: run() ?? null });
  } catch (cause) {
    fail(response, cause);
  }
}

function statusFor(cause: unknown): number {
  if (cause instanceof BadRequest) return 400;
  if (isOperatorError(cause)) return 409;
  return 500;
}

function fail(response: Response, cause: unknown): void {
  const message = messageOf(cause);
  response.status(statusFor(cause)).json({ ok: false, error: message });
}

export function hostIsLocal(hostHeader: string | undefined): boolean {
  if (hostHeader === undefined) return false;
  const withoutPort = hostHeader.startsWith("[") ? hostHeader.replace(/\]:\d+$/, "]") : hostHeader.replace(/:\d+$/, "");
  return LOCAL_HOSTS.has(withoutPort.toLowerCase());
}

export function guardOrigin(request: Request, response: Response, next: NextFunction): void {
  if (!hostIsLocal(request.headers.host)) {
    response.status(403).json({ ok: false, error: "sandcastle only answers requests addressed to 127.0.0.1" });
    return;
  }
  if (!READ_METHODS.has(request.method) && request.get(SANDCASTLE_HEADER) !== "1") {
    response.status(403).json({ ok: false, error: `commands must carry the ${SANDCASTLE_HEADER}: 1 header` });
    return;
  }
  next();
}

/** Identity of this Project Server, served at `/api/instance` (for the Dashboard and the idle-mode picker). */
export interface InstanceInfo {
  dir: string;
  name: string;
  mode: "dry" | "real";
  tracker?: "github" | "local";
  /** True while started without a parent: the operator picks one in the UI. */
  idle: boolean;
  pid: number;
}

export function createUiApp(controller: UiController, instance?: InstanceInfo, push?: PushRouteDeps): Express {
  const app = express();
  app.use(guardOrigin);
  app.use(express.json());
  if (push) mountPushRoutes(app, push);

  app.get("/", (_request, response) => {
    response.type("html").set("cache-control", "no-cache").send(boardPage());
  });

  app.get("/legacy", (_request, response) => {
    response.sendFile(PAGE_FILE);
  });

  mountBoardAssets(app);

  app.get("/api/instance", (_request, response) => {
    response.json({ ok: true, result: instance ?? null });
  });

  app.get("/api/state", (_request, response) => {
    response.json(controller.state());
  });

  app.get("/api/parents", (_request, response) => {
    controller.parents().then(
      (parents) => response.json({ parents }),
      (cause: unknown) => fail(response, cause),
    );
  });

  app.get("/api/events", (request, response) => {
    response.set({
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    response.flushHeaders();
    const write = (kind: string, payload: unknown): void => {
      response.write(`event: ${kind}\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    write("state", { kind: "state", state: controller.state() });
    const unsubscribe = controller.subscribe((event) => write(event.kind, event));
    request.on("close", () => {
      unsubscribe();
      response.end();
    });
  });

  app.post("/api/run", (request, response) => {
    let parent: number;
    let cap: number;
    try {
      parent = requiredInteger(bodyField(request, "parent"), "parent");
      cap = requiredInteger(bodyField(request, "cap"), "cap");
    } catch (cause) {
      fail(response, cause);
      return;
    }
    controller.startRun({ parent, cap }).then(
      () => response.json({ ok: true, result: null }),
      (cause: unknown) => fail(response, cause),
    );
  });

  app.post("/api/parents", (request, response) => {
    let text: string;
    try {
      const value = bodyField(request, "text");
      if (typeof value !== "string") throw new BadRequest('expected a JSON body with "text"');
      text = value;
    } catch (cause) {
      fail(response, cause);
      return;
    }
    controller.addParents(text).then(
      (checked) => response.json({ ok: true, result: checked }),
      (cause: unknown) => fail(response, cause),
    );
  });

  app.post("/api/parents/local", (request, response) => {
    send(response, () => {
      const title = bodyField(request, "title");
      const body = bodyField(request, "body");
      if (typeof title !== "string" || title.trim().length === 0) throw new BadRequest("title must be a non-empty string");
      if (body !== undefined && typeof body !== "string") throw new BadRequest("body must be a string");
      return controller.createLocalParent({ title, ...(body === undefined ? {} : { body }) });
    });
  });

  app.post("/api/queue", (request, response) => {
    let parents: number[];
    let cap: number;
    try {
      parents = parentList(request);
      cap = requiredInteger(bodyField(request, "cap"), "cap");
    } catch (cause) {
      fail(response, cause);
      return;
    }
    controller.queueRuns(parents, cap).then(
      () => response.json({ ok: true, result: null }),
      (cause: unknown) => fail(response, cause),
    );
  });

  app.post("/api/queue/clear", (_request, response) => {
    send(response, () => controller.clearQueue());
  });

  app.post("/api/queue/reorder", (request, response) => {
    send(response, () => controller.reorderQueue(parentList(request)));
  });

  app.put("/api/queue/mode", (request, response) => {
    send(response, () =>
      controller.setQueueMode(
        queueMode(bodyField(request, "mode")),
        optionalInteger(bodyField(request, "maxParallel"), "maxParallel"),
      ),
    );
  });

  app.post("/api/queue/resume", (_request, response) => {
    send(response, () => controller.resumeQueue());
  });

  app.delete("/api/queue/:parent", (request, response) => {
    send(response, () => controller.removeQueued(routeParent(request)));
  });

  app.post("/api/runs/:parent/stop", (request, response) => {
    send(response, () => controller.stopRun(routeParent(request)));
  });

  app.post("/api/runs/:parent/pause", (request, response) => {
    send(response, () => controller.pauseRun(routeParent(request)));
  });

  app.post("/api/runs/:parent/resume", (request, response) => {
    send(response, () => controller.resumeRun(routeParent(request)));
  });

  app.post("/api/runs/:parent/cap", (request, response) => {
    send(response, () => controller.setRunCap(routeParent(request), requiredInteger(bodyField(request, "cap"), "cap")));
  });

  app.post("/api/runs/:parent/auth/recheck", (request, response) => {
    let parent: number;
    try {
      parent = routeParent(request);
    } catch (cause) {
      fail(response, cause);
      return;
    }
    controller.recheckAuth(parent).then(
      (result) => response.json({ ok: true, result }),
      (cause: unknown) => fail(response, cause),
    );
  });

  app.post("/api/reset", (request, response) => {
    let parent: number;
    let apply: boolean;
    try {
      parent = requiredInteger(bodyField(request, "parent"), "parent");
      apply = bodyField(request, "apply") === true;
    } catch (cause) {
      fail(response, cause);
      return;
    }
    const work = apply ? controller.resetApply(parent) : controller.resetPlan(parent);
    work.then(
      (result) => response.json({ ok: true, result, applied: apply }),
      (cause: unknown) => fail(response, cause),
    );
  });

  app.get("/api/items/:itemNumber/attempts", (request, response) => {
    send(response, () => controller.attempts(requiredInteger(request.params.itemNumber, "item number")));
  });

  app.get("/api/attempts/:id/log", (request, response) => {
    send(response, () => {
      const from = request.query["from"];
      const parsed = from === undefined ? 0 : Number(from);
      if (!Number.isInteger(parsed) || parsed < 0) throw new BadRequest(`from must be a byte offset, got ${String(from)}`);
      const id = request.params.id;
      if (!parseAttemptId(id)) throw new BadRequest(`${id} is not an attempt id (item-stage-attempt)`);
      return controller.attemptLog(id, parsed);
    });
  });

  app.post("/api/items/:itemNumber/cancel", (request, response) => {
    send(response, () => controller.cancelItem(requiredInteger(request.params.itemNumber, "item number")));
  });

  app.post("/api/items/:itemNumber/retry", (request, response) => {
    send(response, () => controller.retryItem(requiredInteger(request.params.itemNumber, "item number")));
  });

  app.post("/api/items/:itemNumber/comment", (request, response) => {
    send(response, () => {
      const body = bodyField(request, "body");
      if (typeof body !== "string") throw new BadRequest("body must be a string");
      controller.commentItem(requiredInteger(request.params.itemNumber, "item number"), body);
    });
  });

  app.post("/api/pause", (_request, response) => {
    send(response, () => controller.pause());
  });

  app.post("/api/resume", (_request, response) => {
    send(response, () => controller.resume());
  });

  app.post("/api/cap", (request, response) => {
    send(response, () => controller.setCap(requiredInteger(bodyField(request, "value"), "cap")));
  });

  return app;
}

export interface UiServer {
  port: number;
  url: string;
  close(): Promise<void>;
}

export function startUiServer(
  controller: UiController,
  port = DEFAULT_UI_PORT,
  host = UI_HOST,
  instance?: InstanceInfo,
  push?: PushRouteDeps,
): Promise<UiServer> {
  warmBoardAssets();
  const server: Server = createServer(createUiApp(controller, instance, push));
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return new Promise<UiServer>((resolve, reject) => {
    const rejectStartup = (cause: Error): void => reject(cause);
    server.once("error", rejectStartup);
    server.listen(port, host, () => {
      server.off("error", rejectStartup);
      server.on("error", (cause) => controller.noteError(`ui server error: ${cause.message}`));
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("ui server bound to a pipe instead of a tcp port"));
        return;
      }
      resolve({
        port: address.port,
        url: `http://${host}:${address.port}`,
        close: () =>
          new Promise<void>((done, failed) => {
            for (const socket of sockets) socket.destroy();
            server.close((cause) => (cause ? failed(cause) : done()));
          }),
      });
    });
  });
}
