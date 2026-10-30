import webpush from "web-push";
import { buildAttention, type AttentionEntry } from "../ui/board/attention.js";
import { alertText, alertable, holdReasonOf } from "../ui/board/humanAlerts.js";
import type { BoardProject } from "../ui/board/model.js";
import type { UiState } from "../ui/state.js";
import type { PushSubscriptionRecord, SubscriptionStore } from "./subscriptions.js";
import type { VapidKeys } from "./vapid.js";

const BODY_LIMIT = 200;
const PUSH_TTL_SECONDS = 60 * 60;

/** What the service worker receives; carries nothing beyond what the notification shows. */
export interface PushPayload {
  title: string;
  body: string;
  /** Entry key: a repeat notification for the same entry replaces the earlier one. */
  tag: string;
  projectId: string;
  run?: number;
  item?: number;
}

export type SendPush = (subscription: PushSubscriptionRecord, payload: string) => Promise<void>;

export function webPushSender(keys: VapidKeys): SendPush {
  return async (subscription, payload) => {
    await webpush.sendNotification(subscription, payload, {
      vapidDetails: { subject: keys.subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
      TTL: PUSH_TTL_SECONDS,
    });
  };
}

export interface AttentionPusherDeps {
  store: SubscriptionStore;
  send: SendPush;
  /** Registry id of this Project; the Board View selects it from the notification url. */
  projectId: string;
  projectName: string;
  onError?: (message: string) => void;
}

function payloadOf(entry: AttentionEntry): PushPayload {
  const text = alertText(entry);
  return {
    title: text.title,
    body: text.body.slice(0, BODY_LIMIT),
    tag: entry.key,
    projectId: entry.projectId,
    ...(entry.runNumber === undefined ? {} : { run: entry.runNumber }),
    ...(entry.itemNumber === undefined ? {} : { item: entry.itemNumber }),
  };
}

function statusOf(cause: unknown): number | undefined {
  if (typeof cause !== "object" || cause === null || !("statusCode" in cause)) return undefined;
  return Number((cause as { statusCode: unknown }).statusCode);
}

/** Sends one push per newly needing-attention entry; mirrors the Board View's in-tab announcements. */
export class AttentionPusher {
  private seen: Set<string> | undefined;
  private readonly held = new Map<string, string>();

  constructor(private readonly deps: AttentionPusherDeps) {}

  /** The Board View tells the server which parked entries are on Hold; they are never pushed. */
  setHeld(key: string, reason: string | undefined): void {
    if (reason === undefined) this.held.delete(key);
    else this.held.set(key, reason);
  }

  /** Feed each state; the first one only seeds, so a restart does not re-announce what already waited. */
  update(state: UiState): Promise<void> {
    const project: BoardProject = {
      id: this.deps.projectId,
      name: this.deps.projectName,
      hub: state.hubRepo,
      apiBase: "",
      legacyHref: "/legacy",
      status: "running",
      idle: false,
      mode: state.mode,
      state,
      parents: [],
      connected: true,
    };
    const entries = alertable(buildAttention([project], project.id));
    const previous = this.seen;
    this.seen = new Set(entries.map((entry) => entry.key));
    if (previous === undefined) return Promise.resolve();
    return this.deliver(entries.filter((entry) => !previous.has(entry.key) && !this.isHeld(entry)));
  }

  private isHeld(entry: AttentionEntry): boolean {
    return entry.kind === "parked" && this.held.get(entry.key) === holdReasonOf(entry);
  }

  private async deliver(entries: readonly AttentionEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const subscriptions = this.deps.store.list();
    for (const entry of entries) {
      const payload = JSON.stringify(payloadOf(entry));
      await Promise.all(subscriptions.map((subscription) => this.sendOne(subscription, payload)));
    }
  }

  private async sendOne(subscription: PushSubscriptionRecord, payload: string): Promise<void> {
    try {
      await this.deps.send(subscription, payload);
    } catch (cause) {
      const status = statusOf(cause);
      if (status === 404 || status === 410) {
        this.deps.store.remove(subscription.endpoint);
        return;
      }
      this.deps.onError?.(`web push failed${status ? ` (${status})` : ""}`);
    }
  }
}
