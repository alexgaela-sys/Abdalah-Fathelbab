/*
 * SnakDip ERP service worker — MINIMAL & SAFE.
 *
 * Purpose: PWA installability (Chrome requires a fetch handler for the
 * install prompt). It intentionally does NOT cache any runtime responses,
 * so the ERP's localStorage-backed database, sessions, and all mutations
 * are untouched. Offline behavior is identical to today (browser cache).
 */
const CACHE_NAME = 'snakdip-erp-static-v1';
const APP_SHELL = ['/', '/index.html', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => undefined)
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first for navigations with a shell fallback; pass-through for
// everything else. No mutable ERP data is ever stored.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put('/index.html', copy)).catch(() => undefined);
          return res;
        })
        .catch(() => caches.match('/index.html').then((r) => r || Response.error()))
    );
    return;
  }

  event.respondWith(fetch(req).catch(() => caches.match(req)));
});
