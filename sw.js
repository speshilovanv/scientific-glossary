/* ScientificGlossary Web service worker v0.2 */
const CACHE_NAME = 'scientific-glossary-shell-v2';
const VENDOR_CACHE = 'scientific-glossary-vendor-v2';
const APP_SHELL = ['./', './index.html', './styles.css', './app.js', './manifest.webmanifest',
                   './assets/dictionary.tsv', './assets/icon.svg', './assets/icon-192.png', './assets/icon-512.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(k => ![CACHE_NAME, VENDOR_CACHE].includes(k)).map(k => caches.delete(k))
  )).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) {
    if (req.destination === 'script' || req.destination === 'worker') {
      event.respondWith((async () => {
        const cache = await caches.open(VENDOR_CACHE);
        try {
          const response = await fetch(req);
          if (response && (response.ok || response.type === 'opaque')) await cache.put(req, response.clone());
          return response;
        } catch (error) {
          const cached = await cache.match(req);
          if (cached) return cached;
          throw error;
        }
      })());
    }
    return;
  }
  // Network first for local files: a GitHub Pages update should not remain stale.
  // Offline fallback serves previously cached files.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const response = await fetch(req);
      if (response.ok) await cache.put(req, response.clone());
      return response;
    } catch (error) {
      const cached = await cache.match(req);
      if (cached) return cached;
      if (req.mode === 'navigate') {
        const index = await cache.match('./index.html');
        if (index) return index;
      }
      throw error;
    }
  })());
});
