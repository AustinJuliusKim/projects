// Service worker: receives Web Push events and shows OS notifications.
// Clicking a notification deep-links to the game.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Choices", body: event.data?.text() || "" };
  }
  const title = data.title || "Choices";
  const options = {
    body: data.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { url: data.url || "/" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url || "/";
  // The push payload sends a path like "/g/{id}"; convert to a hash route.
  const hashUrl = target.startsWith("/g/")
    ? `/#${target}`
    : target;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          client.navigate(hashUrl);
          return client.focus();
        }
      }
      return self.clients.openWindow(hashUrl);
    })
  );
});
