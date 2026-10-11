// Service worker: network-first (always fresh online), cached app shell offline. Never touches /ws, /api or audio.
const CACHE = "unison-v1";
const SHELL = ["/", "/manifest.webmanifest", "/tap-worklet.js", "/icons/icon-192.png"];

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/") || url.pathname === "/ws") return;
  const key = url.pathname.startsWith("/r/") ? "/" : e.request; // every room page is the same HTML
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(key, copy));
        }
        return res;
      })
      .catch(async () => (await caches.match(key)) || Response.error()),
  );
});
