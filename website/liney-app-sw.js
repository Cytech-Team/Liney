const CACHE = 'liney-web-local-v1';
const APP = '/app';
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll([APP, '/liney-manifest.webmanifest'])));
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then(names => Promise.all(names.filter(n => n.startsWith('liney-web-local-') && n !== CACHE).map(n => caches.delete(n)))));
  self.clients.claim();
});
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (url.pathname !== APP && !url.pathname.startsWith('/app-assets/') && url.pathname !== '/liney-manifest.webmanifest') return;
  event.respondWith(fetch(req).then(res => {
    if (res.ok) {
      const copy = res.clone();
      event.waitUntil(caches.open(CACHE).then(cache => cache.put(req, copy)));
    }
    return res;
  }).catch(async () => await caches.match(req) || (url.pathname === APP ? caches.match(APP) : Response.error())));
});
