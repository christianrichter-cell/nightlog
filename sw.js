/* ═══════════════════════════════════════════
   NIGHTLOG – sw.js
   Service Worker  |  Cache-first strategy
   Bump CACHE_NAME version to force update.
═══════════════════════════════════════════ */

const CACHE_NAME = 'nightlog-v21';

// All local assets we want pre-cached at install time.
// Google Fonts are NOT listed here – they are cached at runtime
// on first fetch (network → cache fallback).
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];


// ── INSTALL ────────────────────────────────────────────────────────────────────
// Pre-cache all local assets. Skip waiting so the new SW activates immediately.

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_ASSETS))
      .then(() => self.skipWaiting())
  );
});


// ── ACTIVATE ───────────────────────────────────────────────────────────────────
// Remove any caches from older versions of this SW.

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames
            .filter((name) => name !== CACHE_NAME)
            .map((name) => caches.delete(name))
        )
      )
      .then(() => self.clients.claim())
  );
});


// ── FETCH ──────────────────────────────────────────────────────────────────────
// Strategy:
//   • Cache-first for same-origin assets (app shell + icons)
//   • Network-first for Google Fonts (cache on success)
//   • Opaque cross-origin responses are NOT cached (avoids quota errors)

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle GET requests
  if (request.method !== 'GET') return;

  // Google Fonts: network-first, cache on success
  if (
    url.hostname === 'fonts.googleapis.com' ||
    url.hostname === 'fonts.gstatic.com'
  ) {
    event.respondWith(networkFirstWithCache(request));
    return;
  }

  // Everything else (same-origin): cache-first
  event.respondWith(cacheFirstWithNetwork(request));
});


// ── STRATEGY: CACHE-FIRST ──────────────────────────────────────────────────────

async function cacheFirstWithNetwork(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);

    // Only cache valid same-origin responses
    if (response && response.status === 200 && response.type === 'basic') {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }

    return response;
  } catch {
    // If the network fails and we have no cache: return a minimal offline page
    return new Response(
      '<html><body style="background:#030311;color:#00E5FF;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><p>// OFFLINE – NightLog //</p></body></html>',
      { headers: { 'Content-Type': 'text/html' } }
    );
  }
}


// ── STRATEGY: NETWORK-FIRST ────────────────────────────────────────────────────

async function networkFirstWithCache(request) {
  try {
    const response = await fetch(request);

    if (response && response.status === 200) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }

    return response;
  } catch {
    const cached = await caches.match(request);
    return cached || new Response('', { status: 408 });
  }
}
