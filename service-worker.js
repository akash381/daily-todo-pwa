/* ═══════════════════════════════════════════
   TICKER — Service Worker
   Caches the app shell so it loads offline
   ═══════════════════════════════════════════ */

   const CACHE_NAME    = 'ticker-v4';
   const OFFLINE_URL   = './offline.html';
   
   /* Files that make up the app shell —
      these are cached on install so the app
      loads instantly even with no internet */
   const SHELL_FILES = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@300;400;500&display=swap'
];
   
   /* ── Install: cache the shell ── */
   self.addEventListener('install', event => {
     event.waitUntil(
       caches.open(CACHE_NAME).then(cache => {
         return cache.addAll(SHELL_FILES);
       })
     );
     /* activate immediately, don't wait for old tabs to close */
     self.skipWaiting();
   });
   
   /* ── Activate: delete old caches ── */
   self.addEventListener('activate', event => {
     event.waitUntil(
       caches.keys().then(keys =>
         Promise.all(
           keys
             .filter(key => key !== CACHE_NAME)
             .map(key => caches.delete(key))
         )
       )
     );
     /* take control of all open pages immediately */
     self.clients.claim();
   });
   
   /* ── Fetch: serve from cache, fall back to network ── */
   self.addEventListener('fetch', event => {
     const { request } = event;
     const url = new URL(request.url);
   
     /* Strategy 1 — API calls (Alpha Vantage):
        Always go to network. Never cache live price data.
        If offline, return a clean JSON error so app.js
        can handle it gracefully. */
     if (url.hostname === 'www.alphavantage.co') {
       event.respondWith(
         fetch(request).catch(() =>
           new Response(
             JSON.stringify({ error: 'offline' }),
             { headers: { 'Content-Type': 'application/json' } }
           )
         )
       );
       return;
     }
   
     /* Strategy 2 — Google Fonts:
        Cache-first. Fonts don't change, no need to refetch. */
     if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
       event.respondWith(
         caches.match(request).then(cached =>
           cached || fetch(request).then(response => {
             const clone = response.clone();
             caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
             return response;
           })
         )
       );
       return;
     }
   
     /* Strategy 3 — App shell (HTML, CSS, JS):
        Cache-first, fall back to network.
        This is what makes the app load offline. */
     event.respondWith(
       caches.match(request).then(cached => {
         if (cached) return cached;
   
         return fetch(request).then(response => {
           /* only cache successful same-origin responses */
           if (!response || response.status !== 200 || response.type !== 'basic') {
             return response;
           }
           const clone = response.clone();
           caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
           return response;
         }).catch(() => {
           /* if completely offline and not in cache,
              return the index so the app still renders */
           if (request.destination === 'document') {
             return caches.match('/index.html');
           }
         });
       })
     );
   });
