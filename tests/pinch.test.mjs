import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { chromium } from 'playwright';
import { PDFDocument, StandardFonts } from 'pdf-lib';

test('trusted two-finger PDF pinch, native pan, text selection and offline resume', { timeout: 180000 }, async () => {
  const root = resolve('.'), errors = [], passed = [];
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
  const server = createServer(async (req, res) => {
    try {
      let file = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
      if (file !== root && !file.startsWith(root + '/')) { res.writeHead(403).end(); return; }
      if ((await stat(file)).isDirectory()) file += '/index.html';
      res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(await readFile(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await mkdir('test-results', { recursive: true });
  let browser;
  try {
    const launch = { headless: true };
    if (process.env.CHROMIUM_EXECUTABLE) launch.executablePath = process.env.CHROMIUM_EXECUTABLE;
    browser = await chromium.launch(launch);
    const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 1024, height: 700 } });
    const page = await context.newPage(), cdp = await context.newCDPSession(page);
    page.on('pageerror', error => errors.push(error.message));
    const ready = () => page.waitForFunction(() => !document.querySelector('#pageJump').disabled && /слов/.test(document.querySelector('#ocrStatus').textContent));
    const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    const percent = async () => parseInt(await page.locator('#zoomValue').textContent(), 10);
    const points = (center, distance) => [{ id: 1, x: center.x - distance / 2, y: center.y }, { id: 2, x: center.x + distance / 2, y: center.y }];
    const center = () => page.locator('#readerViewport').evaluate(v => { const r = v.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    const sourcePoint = c => page.locator('#pageContainer').evaluate((node, center) => { const r = node.getBoundingClientRect(); return { x: (center.x - r.left) / r.width, y: (center.y - r.top) / r.height }; }, c);
    const pinch = async (factor, cancel = false) => {
      const c = await center(), before = await percent(), anchor = await sourcePoint(c);
      const pixelWidth = await page.locator('#pdfCanvas').getAttribute('width');
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(c, 120) });
      await page.locator('#pageContainer[data-pinching="true"]').waitFor();
      for (let step = 1; step <= 6; step++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(c, 120 * (1 + (factor - 1) * step / 6)) });
        await frame();
      }
      assert.equal(await page.locator('#pdfCanvas').getAttribute('width'), pixelWidth, 'Gesture preview does not repeatedly rerasterize PDF');
      await cdp.send('Input.dispatchTouchEvent', { type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [] });
      await ready();
      const expected = Math.round(Math.max(55, Math.min(250, before * factor)));
      assert.ok(Math.abs(await percent() - expected) <= 1, `Pinch ${before}% × ${factor} = ${expected}%`);
      assert.equal(await page.locator('#pageContainer').evaluate(n => n.style.transform), '');
      assert.equal(await page.locator('#termModal').isVisible(), false, 'Pinch must not open a word card');
      assert.ok(Math.abs(await page.evaluate(() => visualViewport.scale) - 1) < .01, 'Pinch zooms PDF, not browser UI');
      return { anchor, after: await sourcePoint(c) };
    };

    const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
    for (let n = 1; n <= 2; n++) {
      const p = pdf.addPage([600, 900]);
      p.drawText('Water pressure increases during the experiment.', { x: 50, y: 820, size: 22, font });
      for (let y = 740; y > 50; y -= 60) p.drawText(`The model describes flow on page ${n}.`, { x: 50, y, size: 18, font });
    }
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => window.pdfjsLib && document.querySelector('#documentsList .empty-small'));
    await page.locator('#translationMode').selectOption('offline');
    await page.locator('#pdfInput').setInputFiles({ name: 'Pinch.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
    await page.waitForFunction(() => !document.querySelector('#pdfInput').disabled); await ready();
    await page.locator('#focusReaderBtn').click(); await page.locator('#pageFit').selectOption('width'); await ready();
    const anchored = await pinch(1.6);
    assert.ok(Math.abs(anchored.anchor.x - anchored.after.x) < .03 && Math.abs(anchored.anchor.y - anchored.after.y) < .03, 'PDF point stays under gesture midpoint');
    await pinch(.5); await pinch(5); assert.equal(await percent(), 250);
    await pinch(.1); assert.equal(await percent(), 55);
    await pinch(2, true); await pinch(1.45);
    passed.push('trusted spread/squeeze gestures, midpoint anchor, zoom limits, cancellation and clean redraw');

    const beforePan = await page.locator('#readerViewport').evaluate(v => { v.scrollTop = 0; return v.scrollTop; });
    const c = await center();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 11, x: c.x, y: c.y + 80 }] });
    for (let i = 1; i <= 8; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 11, x: c.x, y: c.y + 80 - i * 20 }] }); await frame(); }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForFunction(before => document.querySelector('#readerViewport').scrollTop > before + 30, beforePan);
    assert.equal(await page.locator('#termModal').isVisible(), false);
    passed.push('single-finger native pan remains usable after pinch');

    const zoom = await percent();
    await page.waitForFunction(() => document.querySelector('#offlineState').textContent === 'готово без сети');
    await context.setOffline(true); await page.reload(); await ready();
    assert.equal(await percent(), zoom, 'Pinched zoom persists on offline reload');
    await page.locator('#readerViewport').evaluate(v => { v.scrollTop = 0; v.scrollLeft = 0; });
    // Allow the deliberate ghost-click suppression interval to expire.
    await page.waitForTimeout(700);
    const first = await page.locator('#pdfCanvas').evaluate(n => { const r = n.getBoundingClientRect(), s = r.width / 600; return { x: r.left + 70 * s, y: r.top + 72 * s, end: r.left + 155 * s }; });
    await page.touchscreen.tap(first.x, first.y);
    await page.locator('#termModal:not(.hidden)').waitFor();
    assert.equal(await page.locator('#modalTerm').textContent(), 'Water');
    await page.locator('#cancelTerm').click();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 12, x: first.x, y: first.y }] });
    await page.waitForTimeout(380);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 12, x: first.end, y: first.y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.locator('#termModal:not(.hidden)').waitFor();
    assert.match(await page.locator('#modalTerm').textContent(), /Water pressure/);
    await page.locator('#cancelTerm').click();
    passed.push('pinched zoom restores offline and fresh text geometry supports word taps and held phrase selection');
    await page.screenshot({ path: 'test-results/pinch.png', fullPage: true });
    assert.deepEqual(errors, []);
    console.log('PINCH_PASS', passed.join(' | '));
  } finally {
    await writeFile('test-results/pinch.json', JSON.stringify({ passed, errors }, null, 2));
    if (browser) await browser.close(); server.close();
  }
});
