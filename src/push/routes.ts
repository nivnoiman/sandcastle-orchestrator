import type { Express, Request, Response } from "express";
import { messageOf } from "../messageOf.js";
import type { AttentionPusher } from "./notifier.js";
import { SERVICE_WORKER_SOURCE } from "./serviceWorker.js";
import { parseSubscription, type SubscriptionStore } from "./subscriptions.js";

export interface PushRouteDeps {
  store: SubscriptionStore;
  /** The VAPID public key; the private key is never handed to routes. */
  publicKey: string;
  /** Present on a Project Server only: the Board View reports Holds so they are not pushed. */
  pusher?: AttentionPusher;
}

function reply(response: Response, run: () => unknown): void {
  try {
    response.json({ ok: true, result: run() ?? null });
  } catch (cause) {
    response.status(400).json({ ok: false, error: messageOf(cause) });
  }
}

function body(request: Request): Record<string, unknown> {
  const value: unknown = request.body;
  if (typeof value !== "object" || value === null) throw new Error("expected a JSON body");
  return value as Record<string, unknown>;
}

/** `/sw.js` plus `/push/key|subscribe|unsubscribe`, and `/api/push/held` (under `/api/` so the Dashboard proxy reaches it). Mount after `express.json()`. */
export function mountPushRoutes(app: Express, deps: PushRouteDeps): void {
  app.get("/sw.js", (_request, response) => {
    response.type("application/javascript").set({ "cache-control": "no-cache", "service-worker-allowed": "/" }).send(SERVICE_WORKER_SOURCE);
  });

  app.get("/push/key", (_request, response) => {
    response.json({ ok: true, result: { publicKey: deps.publicKey } });
  });

  app.post("/push/subscribe", (request, response) => {
    reply(response, () => deps.store.add(parseSubscription(body(request)["subscription"])));
  });

  app.post("/push/unsubscribe", (request, response) => {
    reply(response, () => {
      const endpoint = body(request)["endpoint"];
      if (typeof endpoint !== "string") throw new Error("expected an endpoint");
      deps.store.remove(endpoint);
    });
  });

  app.post("/api/push/held", (request, response) => {
    reply(response, () => {
      const { key, reason } = body(request);
      if (typeof key !== "string") throw new Error("expected a key");
      if (reason !== null && typeof reason !== "string") throw new Error("reason must be a string or null");
      deps.pusher?.setHeld(key, reason ?? undefined);
    });
  });
}
