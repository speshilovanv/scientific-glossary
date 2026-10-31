import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { chromium } from 'playwright';

test('Interrupted upgrade preserves offline app and data; retry replaces stale HTTP HTML', { timeout: 120000 }, async () => {
  let legacy = true, blockUpgrade = true;
  const root = resolve('.'), currentHtml = await readFile('index.html', 'utf8'), currentSw = await readFile('sw.js', 'utf8');
  const legacyHtml = '<!doctype html><title>Previous installation</title><script>navigator.serviceWorker.register("sw.js")</script>';
  const cacheName = /const SHELL_CACHE = '([^']+)'/.exec(currentSw)[1];
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      let file = resolve(root, '.' + pathname);
      if (!file.startsWith(root + '/') && file !== root) { res.writeHead(403).end(); return; }
      if ((await stat(file)).isDirectory()) file += '/index.html';
      if (!legacy && blockUpgrade && pathname.endsWith('/vendor/pdfjs/pdf.min.mjs')) {
        res.writeHead(503).end('Interrupted component download'); return;
      }
      const html = file.endsWith('/index.html'), worker = file.endsWith('/sw.js');
      res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream',
        // The HTML is still fresh in the browser cache when the server changes version.
        'Cache-Control': html ? 'public, max-age=86400' : 'no-store' });
      res.end(html ? (legacy ? legacyHtml : currentHtml) : worker ? (legacy ? currentSw.replaceAll(cacheName, cacheName + '-previous') : currentSw) : await readFile(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const launch = { headless: true };
  if (process.env.CHROMIUM_EXECUTABLE) launch.executablePath = process.env.CHROMIUM_EXECUTABLE;
  const browser = await chromium.launch(launch);
  try {
    const page = await browser.newPage();
    await page.goto(origin);
    assert.equal(await page.title(), 'Previous installation');
    await page.evaluate(async () => { await navigator.serviceWorker.ready; if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true })); });
    const saved = await page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const r = indexedDB.open('scientific-glossary-web', 3);
        r.onupgradeneeded = () => {
          for (const name of ['documents', 'entries', 'customDictionary', 'translationCache'])
            r.result.createObjectStore(name, { keyPath: ['documents', 'entries'].includes(name) ? 'id' : 'term' });
        };
        r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
      });
      const data = {
        documents: { id: 'pdf-before-update', name: 'Saved.pdf', data: new Uint8Array([37, 80, 68, 70]).buffer },
        entries: { id: 'term-before-update', term: 'water', translation: 'вода', reviewed: true },
        customDictionary: { term: 'pressure', translation: 'давление' },
        translationCache: { term: 'flow', translation: 'поток' }
      };
      await new Promise((resolve, reject) => {
        const tx = db.transaction(Object.keys(data), 'readwrite');
        tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
        for (const [name, row] of Object.entries(data)) tx.objectStore(name).put(row);
      });
      db.close(); localStorage.setItem('sg-page-pdf-before-update', '2');
      return { ...data, documents: { ...data.documents, data: [37, 80, 68, 70] } };
    });
    legacy = false;
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      const failed = new Promise(resolve => registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        worker.addEventListener('statechange', () => { if (worker.state === 'redundant') resolve(); });
      }, { once: true }));
      await registration.update(); await failed;
    });
    await page.context().setOffline(true);
    await page.reload();
    assert.equal(await page.title(), 'Previous installation', 'Failed update keeps the previous offline app');
    await page.context().setOffline(false);
    blockUpgrade = false;
    await page.evaluate(async () => {
      const changed = new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
      await (await navigator.serviceWorker.getRegistration()).update();
      await changed;
    });
    await page.reload();
    assert.equal(await page.title(), 'ScientificGlossary Reader · 2.2.1');
    await page.waitForFunction(() => document.querySelector('#offlineState').textContent === 'готово без сети');
    await page.context().setOffline(true); await page.reload();
    assert.equal(await page.title(), 'ScientificGlossary Reader · 2.2.1');
    const restored = await page.evaluate(async () => {
      const db = await new Promise(resolve => { const r = indexedDB.open('scientific-glossary-web', 3); r.onsuccess = () => resolve(r.result); });
      const data = {};
      for (const name of ['documents', 'entries', 'customDictionary', 'translationCache']) {
        data[name] = await new Promise(resolve => { const r = db.transaction(name).objectStore(name).getAll(); r.onsuccess = () => resolve(r.result[0]); });
      }
      db.close(); data.documents.data = Array.from(new Uint8Array(data.documents.data));
      return data;
    });
    assert.deepEqual(restored, saved, 'PDF bytes, glossary, dictionary and translations survive the update');
    assert.equal(await page.evaluate(() => localStorage.getItem('sg-page-pdf-before-update')), '2');
    await mkdir('test-results', { recursive: true });
    await writeFile('test-results/upgrade.json', JSON.stringify({ passed: true, previousTitle: 'Previous installation', currentTitle: await page.title(), cacheName }, null, 2));
    console.log('PASS interrupted update keeps previous offline app; retry updates HTML and preserves all four data stores');
  } finally { await browser.close(); server.close(); }
});
