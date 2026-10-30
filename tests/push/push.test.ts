import express from "express";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AttentionPusher, type SendPush } from "../../src/push/notifier.js";
import { mountPushRoutes } from "../../src/push/routes.js";
import { parseSubscription, SubscriptionStore, SUBSCRIPTIONS_FILE, type PushSubscriptionRecord } from "../../src/push/subscriptions.js";
import { loadOrCreateVapid, VAPID_FILE } from "../../src/push/vapid.js";
import type { UiState } from "../../src/ui/state.js";
import { uiItem, uiRun, uiState } from "../ui/board/fixtures.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sc-push-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const subscription = (name: string): PushSubscriptionRecord => ({
  endpoint: `https://push.example.test/${name}`,
  keys: { p256dh: "p256dh-key", auth: "auth-key" },
});

function stateWith(...items: ReturnType<typeof uiItem>[]): UiState {
  return uiState([uiRun(10, items)]);
}

const parked = (number: number, reason = "develop failed") => uiItem(number, "parked", { stage: "develop", parkReason: reason });

describe("vapid keys", () => {
  it("generates once, then reuses the same pair", () => {
    const first = loadOrCreateVapid(dir);
    expect(first.publicKey).toMatch(/^[\w-]{80,}$/);
    expect(loadOrCreateVapid(dir)).toEqual(first);
  });

  it("refuses a corrupt key file instead of orphaning subscriptions", () => {
    writeFileSync(join(dir, VAPID_FILE), "{nope");
    expect(() => loadOrCreateVapid(dir)).toThrow(/not a valid VAPID key file/);
  });
});

describe("subscription store", () => {
  it("adds, replaces by endpoint and removes", () => {
    const store = new SubscriptionStore(dir);
    store.add(subscription("a"));
    store.add({ ...subscription("a"), keys: { p256dh: "new", auth: "new" } });
    store.add(subscription("b"));
    expect(store.list().map((known) => known.endpoint)).toEqual(["https://push.example.test/a", "https://push.example.test/b"]);
    expect(store.list()[0]?.keys.auth).toBe("new");
    store.remove("https://push.example.test/a");
    expect(store.list().map((known) => known.endpoint)).toEqual(["https://push.example.test/b"]);
  });

  it("is shared between store instances and survives a corrupt file", () => {
    new SubscriptionStore(dir).add(subscription("a"));
    expect(new SubscriptionStore(dir).list()).toHaveLength(1);
    writeFileSync(join(dir, SUBSCRIPTIONS_FILE), "garbage");
    expect(new SubscriptionStore(dir).list()).toEqual([]);
  });

  it("rejects malformed and non-https subscriptions", () => {
    expect(() => parseSubscription({ endpoint: "https://x.test/a" })).toThrow(/expected a push subscription/);
    expect(() => parseSubscription({ endpoint: "http://x.test/a", keys: { p256dh: "a", auth: "b" } })).toThrow(/https/);
    expect(() => parseSubscription({ endpoint: "not a url", keys: { p256dh: "a", auth: "b" } })).toThrow(/not a url/);
  });
});

describe("attention pusher", () => {
  function setup() {
    const store = new SubscriptionStore(dir);
    store.add(subscription("a"));
    const sent: { endpoint: string; payload: Record<string, unknown> }[] = [];
    let failWith: { statusCode: number } | undefined;
    const send: SendPush = (target, payload) => {
      if (failWith) return Promise.reject(Object.assign(new Error("push failed"), failWith));
      sent.push({ endpoint: target.endpoint, payload: JSON.parse(payload) as Record<string, unknown> });
      return Promise.resolve();
    };
    const errors: string[] = [];
    const pusher = new AttentionPusher({ store, send, projectId: "proj1", projectName: "Alpha", onError: (message) => errors.push(message) });
    return { store, sent, errors, pusher, failWith: (value: { statusCode: number } | undefined) => (failWith = value) };
  }

  it("seeds on the first state, then pushes once per new entry", async () => {
    const { pusher, sent } = setup();
    await pusher.update(stateWith(parked(1)));
    expect(sent).toEqual([]);
    await pusher.update(stateWith(parked(1), parked(2)));
    await pusher.update(stateWith(parked(1), parked(2)));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload).toMatchObject({ title: "Alpha: #2 item 2 parked at develop", projectId: "proj1", run: 10, item: 2, tag: "proj1:parked:10:2" });
  });

  it("pushes again when an entry clears and returns", async () => {
    const { pusher, sent } = setup();
    await pusher.update(stateWith(uiItem(2, "running")));
    await pusher.update(stateWith(parked(2)));
    await pusher.update(stateWith(uiItem(2, "running")));
    await pusher.update(stateWith(parked(2)));
    expect(sent).toHaveLength(2);
  });

  it("does not push entries on Hold, but does for a different failure", async () => {
    const { pusher, sent } = setup();
    await pusher.update(stateWith(uiItem(2, "running")));
    pusher.setHeld("proj1:parked:10:2", "develop failed");
    await pusher.update(stateWith(parked(2)));
    expect(sent).toHaveLength(0);
    await pusher.update(stateWith(uiItem(2, "running")));
    await pusher.update(stateWith(parked(2, "verify failed")));
    expect(sent).toHaveLength(1);
  });

  it("does not push rate-limit Holds", async () => {
    const { pusher, sent } = setup();
    await pusher.update(stateWith(uiItem(1, "running")));
    await pusher.update({ ...stateWith(uiItem(1, "running")), hold: { reason: "rate-limit" as never, until: undefined } });
    expect(sent).toEqual([]);
  });

  it("drops a subscription the push service reports gone, and reports other failures", async () => {
    const { pusher, store, errors, failWith } = setup();
    await pusher.update(stateWith(uiItem(2, "running")));
    failWith({ statusCode: 410 });
    await pusher.update(stateWith(parked(2)));
    expect(store.list()).toEqual([]);

    store.add(subscription("b"));
    await pusher.update(stateWith(uiItem(2, "running")));
    failWith({ statusCode: 500 });
    await pusher.update(stateWith(parked(2)));
    expect(store.list()).toHaveLength(1);
    expect(errors).toEqual(["web push failed (500)"]);
  });
});

describe("push routes", () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
  });

  async function boot(withPusher = false) {
    const keys = loadOrCreateVapid(dir);
    const store = new SubscriptionStore(dir);
    const send: SendPush = () => Promise.resolve();
    const pusher = new AttentionPusher({ store, send, projectId: "proj1", projectName: "Alpha" });
    const app = express();
    app.use(express.json());
    mountPushRoutes(app, { store, publicKey: keys.publicKey, ...(withPusher ? { pusher } : {}) });
    const base = await new Promise<string>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server!.address() as { port: number }).port}`));
    });
    return { keys, store, base };
  }

  const post = (url: string, body: unknown) =>
    fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("serves the public key and never the private one", async () => {
    const { keys, base } = await boot();
    const text = await (await fetch(`${base}/push/key`)).text();
    expect(text).toContain(keys.publicKey);
    expect(text).not.toContain(keys.privateKey);
    const worker = await (await fetch(`${base}/sw.js`)).text();
    expect(worker).not.toContain(keys.privateKey);
    expect(readFileSync(join(dir, VAPID_FILE), "utf8")).toContain(keys.privateKey);
  });

  it("serves the service worker with root scope", async () => {
    const { base } = await boot();
    const response = await fetch(`${base}/sw.js`);
    expect(response.headers.get("service-worker-allowed")).toBe("/");
    expect(response.headers.get("content-type")).toContain("javascript");
  });

  it("stores and removes subscriptions, rejecting bad ones", async () => {
    const { store, base } = await boot();
    expect((await post(`${base}/push/subscribe`, { subscription: subscription("a") })).status).toBe(200);
    expect(store.list()).toHaveLength(1);
    expect((await post(`${base}/push/subscribe`, { subscription: { endpoint: "http://x.test" } })).status).toBe(400);
    expect((await post(`${base}/push/unsubscribe`, { endpoint: subscription("a").endpoint })).status).toBe(200);
    expect(store.list()).toEqual([]);
  });

  it("accepts Hold reports and validates them", async () => {
    const { base } = await boot(true);
    expect((await post(`${base}/api/push/held`, { key: "k", reason: "r" })).status).toBe(200);
    expect((await post(`${base}/api/push/held`, { key: "k", reason: null })).status).toBe(200);
    expect((await post(`${base}/api/push/held`, { reason: "r" })).status).toBe(400);
  });
});
