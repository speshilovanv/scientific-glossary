/* ScientificGlossary 2.3.1: complete versioned offline installation. */
const SHELL_CACHE = 'scientific-glossary-shell-2.3.1';
const SHELL = ['./', './index.html', './manifest.webmanifest', './assets/icon.svg', './assets/icon-192.png', './assets/icon-512.png', './vendor/manifest.json'];
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const response = await fetch('./vendor/manifest.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('Offline manifest unavailable');
    const manifest = await response.json();
    await cache.addAll(SHELL.map(path => new Request(path, { cache: 'reload' })));
    // Activate only when all components are saved. Previous install survives a failure.
    for (let i = 0; i < manifest.files.length; i += 12) {
      await cache.addAll(manifest.files.slice(i, i + 12).map(file => new Request('./' + file.path, { cache: 'reload' })));
    }
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('scientific-glossary-') && key !== SHELL_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Translation and dictionary services are never intercepted.
  if (url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // HTML and modules come from the same installed version during deployments too.
    const saved = await cache.match(request, { ignoreSearch: true });
    if (saved) return saved;
    if (request.mode === 'navigate') return (await cache.match('./index.html')) || fetch(request);
    return fetch(request);
  })());
});
