// Zhaimer service worker — minimal, safe caching for the PWA experience.
// Caches core app files so the game can open (and previously-viewed pages
// can load) even with a flaky or offline connection. Does NOT try to be
// clever about caching every asset — game.js changes often during active
// development, so a network-first strategy for it avoids serving stale
// game logic to players.
//
// v2 fix: HTML pages and images now use network-first (falling back to
// cache only when offline) instead of cache-first. Previously, an old or
// broken cached copy of a page — e.g. a version of index.html captured
// before an asset path was fixed — could get stuck being served forever
// on every in-app navigation (clicking the ZHAIMER logo, etc.), only
// clearing on a manual hard reload. Network-first means players always get
// the current version when they're online, and offline support is kept as
// a fallback rather than the default.

const CACHE_NAME = 'zhaimer-v2';
const CORE_ASSETS = [
  './',
  './index.html',
  './game.html',
  './style.css',
  './manifest.json',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

function networkFirst(req){
  return fetch(req)
    .then((res) => {
      const resClone = res.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone)).catch(() => {});
      return res;
    })
    .catch(() => caches.match(req));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // Network-first for page navigations (HTML documents), game.js, and
  // images — players should always see the current content when online.
  // Falls back to the last cached copy only if the network is unavailable.
  const isNavigation = req.mode === 'navigate';
  const isImage = req.destination === 'image';
  if (isNavigation || isImage || req.url.includes('game.js')) {
    event.respondWith(networkFirst(req));
    return;
  }

  // Cache-first for everything else (fonts, icons, manifest — rarely
  // change), falling back to network.
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).catch(() => cached))
  );
});
