// The service worker: shows push notifications (src/worker/push.ts sends them) and opens the
// page one is about when it is tapped. It caches nothing; the site always loads from the network.
// Kept in plain JavaScript so it is served as it is, at the root, and covers the whole site.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let message = {};
  try {
    message = event.data ? event.data.json() : {};
  } catch {
    // Not one of ours; show something rather than nothing (browsers require a notification).
  }
  const staging = self.location.hostname.startsWith("staging.");
  event.waitUntil(
    self.registration.showNotification(message.title || "wisesplit", {
      body: message.body || "",
      tag: message.tag || undefined,
      // A newer message about the same expense or payment replaces the old one, and still alerts.
      renotify: Boolean(message.tag),
      icon: staging ? "/icons/staging-icon-192.png" : "/icons/icon-192.png",
      data: { url: message.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin);
  if (url.origin !== self.location.origin) return;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window" });
      // An open tab of the site goes to the page; otherwise (or if that tab can't be sent there,
      // as one the service worker doesn't control yet) a new one opens there.
      for (const client of windows)
        if (new URL(client.url).origin === url.origin && "navigate" in client)
          try {
            await (await client.navigate(url.href))?.focus();
            return;
          } catch {
            // Try the next one.
          }
      await self.clients.openWindow(url.href);
    })(),
  );
});

// The browser renewed the subscription by itself: tell the server the new one, as the person
// whose browser it is (the request carries the sign-in cookie).
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const old = event.oldSubscription;
      const renewed =
        event.newSubscription ||
        (old?.options && (await self.registration.pushManager.subscribe(old.options).catch(() => null)));
      if (old)
        await fetch("/api/push/unsubscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: old.endpoint }),
        }).catch(() => {});
      if (renewed)
        await fetch("/api/push/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(renewed.toJSON()),
        }).catch(() => {});
    })(),
  );
});
