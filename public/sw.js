/*
 * Service worker for aderugy.fr — notifications only.
 *
 * There is deliberately no `fetch` handler: nothing is cached, every request
 * goes to the network exactly as without a service worker, so a deploy can
 * never be hidden behind a stale copy. Installing the app does not need one.
 *
 * Served with `Cache-Control: no-cache` (next.config.ts) so an edit here
 * reaches browsers on their next visit.
 */

self.addEventListener("install", () => {
  // A new version takes over at once; it holds no state worth waiting for.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "aderugy.fr";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      // Same tag ⇒ replaces the earlier notification for that block.
      tag: data.tag || undefined,
      renotify: Boolean(data.tag),
      icon: "/icons/icon-192.png",
      // Android draws the badge as a silhouette: white glyph, transparent ground.
      badge: "/icons/badge-96.png",
      data: { url: data.url || "/agenda" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/agenda", self.location.origin);

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Reuse an open window of the app rather than stacking new ones.
      for (const client of windows) {
        if (new URL(client.url).origin === target.origin && "focus" in client) {
          await client.focus();
          if ("navigate" in client && client.url !== target.href) {
            await client.navigate(target.href).catch(() => {});
          }
          return;
        }
      }
      await self.clients.openWindow(target.href);
    })(),
  );
});
