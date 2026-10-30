/** Served at `/sw.js` so its scope is the whole origin. Plain JS: a service worker cannot be bundled from the Board View. */
export const SERVICE_WORKER_SOURCE = `"use strict";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data;
  try {
    data = event.data ? event.data.json() : null;
  } catch (cause) {
    data = null;
  }
  if (!data || typeof data.title !== "string") return;
  const params = new URLSearchParams();
  if (data.projectId) params.set("project", String(data.projectId));
  if (data.run) params.set("run", String(data.run));
  if (data.item) params.set("item", String(data.item));
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: typeof data.body === "string" ? data.body : "",
      tag: typeof data.tag === "string" ? data.tag : undefined,
      data: { url: "/?" + params.toString() },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows.find((candidate) => new URL(candidate.url).origin === self.location.origin);
      if (!open) return self.clients.openWindow(target);
      return open.navigate(target).then((moved) => (moved || open).focus());
    }),
  );
});
`;
