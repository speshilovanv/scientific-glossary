import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { chromium } from 'playwright';
import { PDFDocument, StandardFonts } from 'pdf-lib';

test('tablet focus layout, bookmarks with notes and automatic offline resume', { timeout: 180000 }, async () => {
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
  let browser;
  await mkdir('test-results', { recursive: true });
  try {
    const launch = { headless: true };
    if (process.env.CHROMIUM_EXECUTABLE) launch.executablePath = process.env.CHROMIUM_EXECUTABLE;
    browser = await chromium.launch(launch);
    const context = await browser.newContext({ viewport: { width: 1024, height: 550 } });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
    const ready = async () => {
      await page.waitForFunction(() => window.pdfjsLib && document.querySelector('#documentsList .empty-small, #documentsList .document-item'));
    };
    const painted = async number => {
      await page.waitForFunction(n => !document.querySelector('#pageJump').disabled && !document.querySelector('#pageWrap').classList.contains('hidden') && document.querySelector('#pageCounter').textContent === `${n} / 3` && /слов/.test(document.querySelector('#ocrStatus').textContent), number);
    };
    const jump = async number => { await page.locator('#pageJump').fill(String(number)); await page.locator('#pageJump').press('Enter'); await painted(number); };
    const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
    for (let n = 1; n <= 3; n++) {
      const p = pdf.addPage([600, 850]);
      p.drawText(`Top of page ${n}: Water pressure and flow.`, { x: 30, y: 810, size: 16, font });
      for (let y = 760; y >= 80; y -= 40) p.drawText(`The model describes water flow on page ${n}.`, { x: 30, y, size: 16, font });
      p.drawText(`Bottom of page ${n}.`, { x: 30, y: 25, size: 16, font });
    }
    const bytes = Buffer.from(await pdf.save());
    await page.goto(`http://127.0.0.1:${server.address().port}`); await ready();
    await page.locator('#pdfInput').setInputFiles({ name: 'Reading.pdf', mimeType: 'application/pdf', buffer: bytes }); await painted(1);
    await page.locator('#focusReaderBtn').click();
    await page.waitForFunction(() => document.querySelector('#pageFit').value === 'page' && document.querySelector('#pdfCanvas').clientHeight < 480);
    await painted(1);
    const bounds = await page.evaluate(() => {
      const canvas = document.querySelector('#pdfCanvas').getBoundingClientRect(), viewport = document.querySelector('#readerViewport').getBoundingClientRect();
      return { canvas: { top: canvas.top, bottom: canvas.bottom, left: canvas.left, right: canvas.right }, viewport: { top: viewport.top, bottom: viewport.bottom, left: viewport.left, right: viewport.right, height: viewport.height }, height: innerHeight };
    });
    assert.ok(bounds.viewport.height > bounds.height * .75, 'Reading area gets over 75% of the tablet viewport');
    assert.ok(bounds.canvas.top >= bounds.viewport.top && bounds.canvas.bottom <= bounds.viewport.bottom + 1, 'Whole PDF page fits vertically');
    assert.ok(bounds.canvas.left >= bounds.viewport.left && bounds.canvas.right <= bounds.viewport.right + 1, 'Whole PDF page fits horizontally');
    assert.equal(await page.locator('#readerTools').isVisible(), false);
    await page.screenshot({ path: 'test-results/reader-tablet-page.png', fullPage: true });
    passed.push('landscape tablet shows entire page with compact panels');

    await page.locator('#pageFit').selectOption('width'); await painted(1);
    await page.waitForFunction(() => document.querySelector('#pdfCanvas').clientHeight > document.querySelector('#readerViewport').clientHeight);
    const edges = await page.locator('#readerViewport').evaluate(v => {
      v.scrollTop = 0; const top = document.querySelector('#pdfCanvas').getBoundingClientRect().top - v.getBoundingClientRect().top;
      v.scrollTop = v.scrollHeight; const bottom = document.querySelector('#pdfCanvas').getBoundingClientRect().bottom - v.getBoundingClientRect().bottom;
      return { top, bottom };
    });
    assert.ok(edges.top >= 0 && edges.top <= 10, 'Top edge is reachable'); assert.ok(Math.abs(edges.bottom) <= 10, 'Bottom edge is reachable');
    await page.locator('#readerToolsToggle').click(); assert.equal(await page.locator('#readerTools').isVisible(), true);
    await page.locator('#readerToolsToggle').click(); assert.equal(await page.locator('#readerTools').isVisible(), false);
    passed.push('width mode scrolls from first to last line; tools open explicitly');

    await jump(2);
    await page.locator('#zoomIn').click();
    await page.waitForFunction(() => document.querySelector('#zoomValue').textContent === '115%');
    await page.locator('#readerViewport').evaluate(v => { v.scrollTop = (v.scrollHeight - v.clientHeight) * .4; });
    await page.locator('#bookmarksBtn').click();
    await page.locator('#bookmarkNote').fill('Закончил введение. Продолжить с модели.');
    await page.locator('#saveBookmark').click();
    await page.waitForFunction(() => document.querySelector('#bookmarkFeedback').textContent.startsWith('Место сохранено'));
    assert.equal(await page.locator('.bookmark-item').count(), 1);
    await page.screenshot({ path: 'test-results/bookmark-note.png', fullPage: true });
    await page.locator('#closeBookmarks').click();
    await jump(3);
    await page.waitForFunction(() => document.querySelector('#offlineState').textContent === 'готово без сети');
    await context.setOffline(true); await page.reload(); await ready(); await painted(2);
    assert.equal(await page.locator('#focusReaderBtn').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#pageFit').inputValue(), 'width');
    assert.equal(await page.locator('#zoomValue').textContent(), '115%');
    await page.waitForFunction(() => { const v = document.querySelector('#readerViewport'); return Math.abs(v.scrollTop / (v.scrollHeight - v.clientHeight) - .4) < .03; });
    await page.locator('#bookmarksBtn').click(); assert.equal(await page.locator('#bookmarkNote').inputValue(), 'Закончил введение. Продолжить с модели.');
    await page.locator('#bookmarkNote').fill('Обновлённая заметка'); await page.locator('#saveBookmark').click();
    await page.waitForFunction(() => document.querySelector('#bookmarkFeedback').textContent.startsWith('Место сохранено'));
    assert.equal(await page.locator('.bookmark-item').count(), 1, 'Editing a page note does not duplicate its bookmark');
    await page.locator('#closeBookmarks').click();
    passed.push('offline reload restores bookmarked PDF, page, zoom and reading position; note edits do not duplicate bookmarks');

    await page.locator('#pdfInput').setInputFiles({ name: 'Reading.pdf', mimeType: 'application/pdf', buffer: bytes }); await painted(2);
    assert.equal(await page.locator('.document-item').count(), 1);
    await jump(3); await page.locator('#bookmarksBtn').click();
    await page.locator('#bookmarkNote').fill('Вторая закладка'); await page.locator('#saveBookmark').click();
    await page.waitForFunction(() => document.querySelector('#bookmarkFeedback').textContent.startsWith('Место сохранено'));
    assert.equal(await page.locator('.bookmark-item').count(), 2);
    await page.getByRole('button', { name: 'Открыть страницу 2', exact: true }).click(); await painted(2);
    await page.reload(); await ready(); await painted(2);
    await page.locator('#bookmarksBtn').click();
    await page.getByRole('button', { name: 'Удалить закладку: страница 2', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.bookmark-item').length === 1);
    await page.locator('#closeBookmarks').click(); await page.reload(); await ready(); await painted(3);
    await page.locator('#bookmarksBtn').click();
    await page.getByRole('button', { name: 'Удалить закладку: страница 3', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.bookmark-item').length === 0);
    await page.locator('#closeBookmarks').click(); await jump(2);
    await page.reload(); await ready(); await painted(2);
    passed.push('duplicate PDF keeps notes, bookmark navigation selects resume point, deletion falls back and last page resumes without bookmarks');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#pageFit').selectOption('page');
    await page.waitForFunction(() => { const c = document.querySelector('#pdfCanvas').getBoundingClientRect(), v = document.querySelector('#readerViewport').getBoundingClientRect(); return c.top >= v.top && c.bottom <= v.bottom + 1 && c.left >= v.left && c.right <= v.right + 1; });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: 'test-results/reader-phone-page.png', fullPage: true });
    await context.setOffline(false);
    passed.push('whole-page mode fits phone without horizontal overflow');
    assert.deepEqual(errors, []);
    console.log('READER_PASS', passed.join(' | '));
  } finally {
    await writeFile('test-results/reader.json', JSON.stringify({ passed, errors }, null, 2));
    if (browser) await browser.close(); server.close();
  }
});
