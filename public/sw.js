/* Minimal offline shell: cache the app skeleton so a saved ticket still opens with no signal.
 * Anything under /api/ always goes to the network — payments and tickets must never be served stale. */
const CACHE = 'pp-v5';
const SHELL = ['/', '/css/style.css', '/js/app.js', '/vendor/qrcode.min.js', '/assets/logo.jpg', '/assets/bg.jpg', '/assets/place.jpg', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Never touch API calls, the staff/admin pages, or the health check.
  if (e.request.method !== 'GET' || url.origin !== location.origin || /^\/(api|admin|door|health)(\/|$)/.test(url.pathname)) return;
  e.respondWith(
    fetch(e.request)
      // Only keep good full responses: never cache a 404/500/429 page as the offline copy.
      .then((res) => { if (res.ok && res.status === 200) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {}); } return res; })
      .catch(() => caches.match(e.request).then((r) => r || (e.request.mode === 'navigate' ? caches.match('/') : undefined)))
  );
});
