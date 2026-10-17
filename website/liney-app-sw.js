// Historical Liney Web App service worker retirement shim.
// Once fetched by a previously installed PWA, stop interception permanently.
self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith("liney-web-local-"))
      .map((name) => caches.delete(name)));
    await self.registration.unregister();
    await self.clients.claim();
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    await Promise.all(clients.filter((client) =>
      new URL(client.url).pathname.startsWith("/app"))
      .map((client) => client.navigate("/download.html").catch(() => undefined)));
  })());
});
