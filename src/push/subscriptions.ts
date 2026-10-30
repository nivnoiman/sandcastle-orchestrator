import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SUBSCRIPTIONS_FILE = "push-subscriptions.json";
const MAX_SUBSCRIPTIONS = 50;

/** A browser's PushSubscription as `toJSON()` gives it. */
export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Subscription bodies come from a browser page, so shape is checked before it is stored or dialled. */
export function parseSubscription(value: unknown): PushSubscriptionRecord {
  const body = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  const endpoint = body?.endpoint;
  const p256dh = body?.keys?.p256dh;
  const auth = body?.keys?.auth;
  if (typeof endpoint !== "string" || typeof p256dh !== "string" || typeof auth !== "string" || !p256dh || !auth) {
    throw new Error("expected a push subscription with endpoint and keys.p256dh/keys.auth");
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("subscription endpoint is not a url");
  }
  if (url.protocol !== "https:") throw new Error("subscription endpoint must be https");
  return { endpoint, keys: { p256dh, auth } };
}

/** Shared by every Project Server and the Dashboard through one file, re-read on each use so a subscription made anywhere reaches every sender. */
export class SubscriptionStore {
  private readonly file: string;

  constructor(private readonly dir: string) {
    this.file = join(dir, SUBSCRIPTIONS_FILE);
  }

  list(): PushSubscriptionRecord[] {
    if (!existsSync(this.file)) return [];
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      if (!Array.isArray(raw)) return [];
      return raw.flatMap((candidate) => {
        try {
          return [parseSubscription(candidate)];
        } catch {
          return [];
        }
      });
    } catch {
      return [];
    }
  }

  add(subscription: PushSubscriptionRecord): void {
    const others = this.list().filter((known) => known.endpoint !== subscription.endpoint);
    this.write([...others, subscription].slice(-MAX_SUBSCRIPTIONS));
  }

  remove(endpoint: string): void {
    const all = this.list();
    const kept = all.filter((known) => known.endpoint !== endpoint);
    if (kept.length !== all.length) this.write(kept);
  }

  private write(subscriptions: PushSubscriptionRecord[]): void {
    mkdirSync(this.dir, { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(subscriptions, null, 2), { mode: 0o600 });
    renameSync(temp, this.file);
  }
}
