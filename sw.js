const CACHE_NAME = 'scientific-glossary-shell-v1';
const VENDOR_CACHE = 'scientific-glossary-vendor-v1';
const APP_SHELL = ['./','./index.html','./styles.css','./app.js','./manifest.webmanifest','./assets/dictionary.tsv','./assets/icon.svg','./assets/icon-192.png','./assets/icon-512.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => ![CACHE_NAME,VENDOR_CACHE].includes(k)).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET') return;
  if (url.origin !== self.location.origin) {
    if (req.destination === 'script' || req.destination === 'worker') {
      event.respondWith((async () => {
        const cache = await caches.open(VENDOR_CACHE);
        const cached = await cache.match(req);
        if (cached) return cached;
        try { const response = await fetch(req); if (response && (response.ok || response.type === 'opaque')) await cache.put(req, response.clone()); return response; }
        catch (e) { if (cached) return cached; throw e; }
      })());
    }
    return;
  }
  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    try { const response = await fetch(req); if (response && response.ok) { const cache = await caches.open(CACHE_NAME); cache.put(req,response.clone()); } return response; }
    catch (e) { return caches.match('./index.html'); }
  })());
});
