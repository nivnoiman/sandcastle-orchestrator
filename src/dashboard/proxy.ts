import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import type { Request, RequestHandler, Response } from "express";
import { isTcpPort } from "../project/projectConfig.js";
import { isRunning, type InstanceRegistry } from "../registry/index.js";
import { SANDCASTLE_HEADER, UI_HOST } from "../ui/server.js";

const FORWARDED_HEADERS = ["content-type", "content-length", "accept", "cache-control", "last-event-id", SANDCASTLE_HEADER];
const FORWARDED_PATH = /^\/(api\/|legacy$)/;
const LEGACY_API_REFERENCE = /(["'`])\/api\//g;

function forwardedHeaders(headers: IncomingHttpHeaders, port: number): IncomingHttpHeaders {
  const forwarded: IncomingHttpHeaders = { host: `${UI_HOST}:${port}` };
  for (const name of FORWARDED_HEADERS) {
    const value = headers[name];
    if (value !== undefined) forwarded[name] = value;
  }
  return forwarded;
}

function unreachable(response: Response, name: string, cause: string): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.status(502).json({ ok: false, error: `${name} is not reachable (${cause}) — its Project Server may have died` });
}

/**
 * `/p/:id/<api/... | legacy>` -> the registered Project Server on loopback. Only the port recorded in the
 * Instance Registry is ever dialled, the host is fixed, and the `x-sandcastle` header is passed on, never added.
 */
export function projectProxy(registry: InstanceRegistry): RequestHandler {
  return (request: Request, response: Response) => {
    const id = request.params["id"];
    const segments = request.params["rest"];
    const rest = `/${Array.isArray(segments) ? segments.join("/") : String(segments ?? "")}`;
    const entry = typeof id === "string" ? registry.get(id) : undefined;
    if (!entry) {
      response.status(404).json({ ok: false, error: `unknown project ${String(id)}` });
      return;
    }
    if (!isRunning(entry) || !isTcpPort(entry.port)) {
      response.status(502).json({ ok: false, error: `${entry.name} has no running Project Server` });
      return;
    }
    if (!FORWARDED_PATH.test(rest)) {
      response.status(404).json({ ok: false, error: `${rest} is not proxied` });
      return;
    }

    const query = request.url.includes("?") ? request.url.slice(request.url.indexOf("?")) : "";
    const upstream = httpRequest(
      { host: UI_HOST, port: entry.port, method: request.method, path: `${rest}${query}`, headers: forwardedHeaders(request.headers, entry.port) },
      (reply) => {
        const type = String(reply.headers["content-type"] ?? "");
        if (rest === "/legacy" && type.startsWith("text/html")) {
          const chunks: Buffer[] = [];
          reply.on("data", (chunk: Buffer) => chunks.push(chunk));
          reply.on("end", () => {
            const html = Buffer.concat(chunks).toString("utf8").replace(LEGACY_API_REFERENCE, `$1/p/${entry.id}/api/`);
            response.status(reply.statusCode ?? 200).type("html").send(html);
          });
          return;
        }
        response.status(reply.statusCode ?? 502);
        for (const [name, value] of Object.entries(reply.headers)) {
          if (value !== undefined && name !== "transfer-encoding" && name !== "connection") response.setHeader(name, value);
        }
        if (type.startsWith("text/event-stream")) response.flushHeaders();
        reply.pipe(response);
        reply.on("error", () => response.end());
      },
    );
    upstream.on("error", (cause) => unreachable(response, entry.name, cause.message));
    response.on("close", () => upstream.destroy());
    request.pipe(upstream);
  };
}
