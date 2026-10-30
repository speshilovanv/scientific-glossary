/* ScientificGlossary Reader 1.8 — offline application shell. */
const SHELL_CACHE = 'scientific-glossary-shell-1.8.0';
const VENDOR_CACHE = 'scientific-glossary-vendor-1.8.0';
const SHELL = ['./', './index.html', './manifest.webmanifest', './assets/icon.svg', './assets/icon-192.png', './assets/icon-512.png'];
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(SHELL);
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('scientific-glossary-') && key !== SHELL_CACHE && key !== VENDOR_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    // Never cache translation queries or unrelated network requests.
    if (!['cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'tessdata.projectnaptha.com'].includes(url.hostname)) return;
    event.respondWith((async () => {
      const cache = await caches.open(VENDOR_CACHE);
      const hit = await cache.match(request);
      if (hit) return hit;
      const response = await fetch(request);
      if (response.ok || response.type === 'opaque') await cache.put(request, response.clone());
      return response;
    })());
    return;
  }
  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    try {
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    } catch (error) {
      const saved = await cache.match(request);
      if (saved) return saved;
      if (request.mode === 'navigate') return (await cache.match('./index.html')) || Response.error();
      throw error;
    }
  })());
});
