import { projectApi } from "./api.js";

export function pushSupported(): boolean {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator && typeof PushManager !== "undefined" && typeof Notification !== "undefined";
}

function keyBytes(base64Url: string): Uint8Array<ArrayBuffer> {
  const padded = (base64Url + "=".repeat((4 - (base64Url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

/**
 * Registers this browser for web push so a parked item reaches it with the tab closed.
 * False when unsupported, not permitted, or the server has no push (older server, unusable keys): the caller keeps in-tab alerts.
 */
export async function ensurePushSubscription(): Promise<boolean> {
  if (!pushSupported() || Notification.permission !== "granted") return false;
  try {
    const keyResponse = await fetch("/push/key");
    if (!keyResponse.ok) return false;
    const publicKey = ((await keyResponse.json()) as { result?: { publicKey?: string } }).result?.publicKey;
    if (!publicKey) return false;
    const registration = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    const subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
    await projectApi("").send("POST", "/push/subscribe",{ subscription: subscription.toJSON() });
    return true;
  } catch {
    return false;
  }
}
