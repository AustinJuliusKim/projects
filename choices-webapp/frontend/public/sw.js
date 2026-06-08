// Service worker: receives Web Push events and shows OS notifications.
// Clicking a notification opens the app (which resumes from stored identity).

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
  // Resolve against the SW scope so the target is always absolute and in-scope.
  const target = new URL(event.notification.data?.url || "/", self.registration.scope).href;
  const inScope = (url) => url.startsWith(self.registration.scope);

  // Identity is restored from localStorage on boot. For an already-open window,
  // focusing is enough (PlayView's poll resumes the game); navigate() is flaky in
  // iOS standalone PWAs, so only attempt it when the window is out of scope.
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
      const client = clients.find((c) => "focus" in c);
      if (client) {
        if (!inScope(client.url) && "navigate" in client) {
          try {
            await client.navigate(target);
          } catch {
            // Ignore: focus still brings the app forward where it resumes itself.
          }
        }
        return client.focus();
      }
      return self.clients.openWindow(target);
    })
  );
});
