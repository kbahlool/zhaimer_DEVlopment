// Zhaimer service worker — minimal, safe caching for the PWA experience.
// Caches core app files so the game can open (and previously-viewed pages
// can load) even with a flaky or offline connection. Does NOT try to be
// clever about caching every asset — game.js changes often during active
// development, so a network-first strategy for it avoids serving stale
// game logic to players.
//
// v3 fix: CSS files (style.css, etc.) now use network-first too — they were
// previously cache-first, meaning a player who had ever loaded the site
// would keep seeing an old stylesheet forever after a style update, even
// after a manual hard refresh (hard refresh clears the browser HTTP cache,
// but never touches the Service Worker's own Cache Storage). CACHE_NAME is
// also bumped so every existing installed copy is forced to drop its old
// cached style.css immediately instead of waiting for it to expire.

const CACHE_NAME = 'zhaimer-v11';
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

  // Network-first for page navigations (HTML documents), game.js, CSS, and
  // images — players should always see the current content when online.
  // Falls back to the last cached copy only if the network is unavailable.
  const isNavigation = req.mode === 'navigate';
  const isImage = req.destination === 'image';
  const isCSS = req.destination === 'style' || req.url.endsWith('.css');
  if (isNavigation || isImage || isCSS || req.url.includes('game.js')) {
    event.respondWith(networkFirst(req));
    return;
  }

  // Cache-first for everything else (fonts, icons, manifest — rarely
  // change), falling back to network.
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).catch(() => cached))
  );
});
