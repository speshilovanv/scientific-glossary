import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { chromium } from 'playwright';

test('Service Worker upgrade replaces a fresh but stale HTTP-cached HTML', { timeout: 120000 }, async () => {
  let legacy = true;
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
    legacy = false;
    await page.evaluate(async () => {
      const changed = new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
      await (await navigator.serviceWorker.getRegistration()).update();
      await changed;
    });
    await page.reload();
    assert.equal(await page.title(), 'ScientificGlossary Reader · 2.0');
    await page.waitForFunction(() => document.querySelector('#offlineState').textContent === 'готово без сети');
    await mkdir('test-results', { recursive: true });
    await writeFile('test-results/upgrade.json', JSON.stringify({ passed: true, previousTitle: 'Previous installation', currentTitle: await page.title(), cacheName }, null, 2));
    console.log('PASS real upgrade bypasses stale HTTP cache and preserves complete offline installation');
  } finally { await browser.close(); server.close(); }
});
