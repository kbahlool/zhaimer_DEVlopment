// Zhaimer service worker — minimal, safe caching for the PWA experience.
// Caches core app files so the game can open (and previously-viewed pages
// can load) even with a flaky or offline connection. Does NOT try to be
// clever about caching every asset — game.js changes often during active
// development, so a network-first strategy for it avoids serving stale
// game logic to players.

const CACHE_NAME = 'zhaimer-v1';
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

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // Network-first for game.js so players always get the latest game logic;
  // falls back to cache only if the network is unavailable.
  if (req.url.includes('game.js')) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Cache-first for everything else (static assets), falling back to network
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).catch(() => cached))
  );
});
