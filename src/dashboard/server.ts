import { createServer, request as httpRequest } from "node:http";
import type { Socket } from "node:net";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { processIsAlive } from "../real/lock.js";
import { warmBoardAssets } from "../ui/board/assets.js";
import { UI_HOST } from "../ui/server.js";
import { createDashboardApp, type DashboardDeps } from "./app.js";

export const DEFAULT_DASHBOARD_PORT = 7700;
const DASHBOARD_FILE = "dashboard.json";

export interface DashboardServer {
  port: number;
  url: string;
  close(): Promise<void>;
}

export function startDashboardServer(deps: DashboardDeps, port = DEFAULT_DASHBOARD_PORT): Promise<DashboardServer> {
  warmBoardAssets();
  const server = createServer(createDashboardApp(deps));
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, UI_HOST, () => {
      server.off("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("dashboard bound to a pipe instead of a tcp port"));
        return;
      }
      resolve({
        port: address.port,
        url: `http://${UI_HOST}:${address.port}`,
        close: () =>
          new Promise<void>((done, failed) => {
            for (const socket of sockets) socket.destroy();
            server.close((cause) => (cause ? failed(cause) : done()));
          }),
      });
    });
  });
}

/** `dashboard.json` beside the registry: lets a repeated `sandcastle dashboard` reuse the running one. */
export interface DashboardRecord {
  pid: number;
  port: number;
  startedAt: string;
}

export function dashboardFile(registryDir: string): string {
  return join(registryDir, DASHBOARD_FILE);
}

export function writeDashboardRecord(file: string, record: DashboardRecord): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(record)}\n`);
}

export function removeDashboardRecord(file: string, pid: number): void {
  if (readDashboardRecord(file)?.pid !== pid) return;
  rmSync(file, { force: true });
}

function isRecord(value: unknown): value is DashboardRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record["pid"] === "number" && typeof record["port"] === "number" && typeof record["startedAt"] === "string";
}

export function readDashboardRecord(file: string): DashboardRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function answers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = httpRequest({ host: UI_HOST, port, path: "/dashboard/api/projects", timeout: 1500 }, (reply) => {
      reply.resume();
      resolve(reply.statusCode === 200);
    });
    probe.on("timeout", () => probe.destroy());
    probe.on("error", () => resolve(false));
    probe.end();
  });
}

/** The live Dashboard recorded in `file`, if its process is alive and answers; a dead record is removed. */
export async function runningDashboard(file: string, isAlive: (pid: number) => boolean = processIsAlive): Promise<DashboardRecord | undefined> {
  const record = readDashboardRecord(file);
  if (!record) return undefined;
  if (isAlive(record.pid) && (await answers(record.port))) return record;
  rmSync(file, { force: true });
  return undefined;
}
