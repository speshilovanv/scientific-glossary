import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { chromium } from 'playwright';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const root = resolve('.');
const mime = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.pdf': 'application/pdf' };
const server = createServer(async (req, res) => {
  try {
    const path = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
    if (!path.startsWith(root + '/') && path !== root) { res.writeHead(403).end(); return; }
    const file = (await stat(path)).isDirectory() ? path + '/index.html' : path;
    res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
await mkdir('test-results', { recursive: true });
const launch = { headless: true };
if (process.env.CHROMIUM_EXECUTABLE) launch.executablePath = process.env.CHROMIUM_EXECUTABLE;
const browser = await chromium.launch(launch);
const errors = [], results = [];
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();
page.on('pageerror', error => errors.push(error.message));
page.on('dialog', dialog => dialog.accept());
const check = async (name, fn) => { await fn(); results.push(name); console.log('PASS', name); };
async function ready(p = page) {
  await p.waitForFunction(() => window.pdfjsLib && document.querySelector('#documentsList .empty-small, #documentsList .document-item'));
}
async function painted(p = page) {
  await p.waitForFunction(() => !document.querySelector('#pageWrap').classList.contains('hidden') && !document.querySelector('#pageJump').disabled && /слов|Скан:/.test(document.querySelector('#ocrStatus').textContent));
}
async function importPdf(name, bytes, p = page) {
  await p.locator('#pdfInput').setInputFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
  await p.waitForFunction(name => document.querySelector('#currentDocName').textContent === name, name);
  await painted(p);
}
async function manual(term, p = page) {
  p.once('dialog', dialog => dialog.accept(term));
  // The main test page has a general confirm handler; use real PDF clicks for it.
  await p.locator('#manualTerm').click();
  await p.locator('#termModal:not(.hidden)').waitFor();
}
async function clickWord(p = page, pageNumber = 1) {
  // Read the real saved PDF with the real engine, independently of the reader's private state.
  const point = await p.evaluate(async number => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('scientific-glossary-web', 3); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const docs = await new Promise(resolve => { const r = db.transaction('documents').objectStore('documents').getAll(); r.onsuccess = () => resolve(r.result); });
    db.close();
    const doc = docs.find(d => d.name === document.querySelector('#currentDocName').textContent);
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(doc.data.slice(0)), isEvalSupported: false }).promise;
    const pdfPage = await pdf.getPage(number), base = pdfPage.getViewport({ scale: 1 });
    const width = document.querySelector('#pdfCanvas').clientWidth;
    const viewport = pdfPage.getViewport({ scale: width / base.width });
    const content = await pdfPage.getTextContent();
    let candidate;
    for (const item of content.items) {
      const match = /\b(?:water|model|data|learning|attention|network|the|a)\b/i.exec(item.str);
      if (!match || !item.width) continue;
      const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
      if (Math.abs(Math.atan2(tx[1], tx[0])) > .12) continue;
      const h = Math.hypot(tx[2], tx[3]), style = content.styles[item.fontName] || {};
      const c = document.createElement('canvas').getContext('2d');
      c.font = `${h}px ${style.fontFamily || 'serif'}`;
      const measured = c.measureText(item.str).width;
      const start = c.measureText(item.str.slice(0, match.index)).width;
      const wordWidth = c.measureText(item.str.slice(0, match.index + match[0].length)).width - start;
      const y = tx[5] - Math.max(.65, Math.min(1.1, style.ascent ?? .85)) * h + h * .5;
      candidate = { term: match[0], x: tx[4] + item.width * viewport.scale * (start + wordWidth / 2) / measured, y };
      if (y > 10 && y < 650 && candidate.x < 850) break;
    }
    await pdf.destroy();
    return candidate;
  }, pageNumber);
  assert.ok(point, 'A selectable English word exists');
  await p.locator('#pageContainer').click({ position: { x: point.x, y: point.y } });
  await p.locator('#termModal:not(.hidden)').waitFor();
  assert.equal((await p.locator('#modalTerm').textContent()).toLowerCase(), point.term.toLowerCase());
  return point.term;
}
const fixture = await PDFDocument.create();
const font = await fixture.embedFont(StandardFonts.Helvetica);
for (let n = 1; n <= 3; n++) {
  const pdfPage = fixture.addPage([600, 800]);
  pdfPage.drawText('Water pressure increases during the experiment.', { x: 50, y: 700, size: 18, font });
  pdfPage.drawText(`The model measures the flow rate on page ${n}.`, { x: 50, y: 660, size: 16, font });
}
const fixtureBytes = await fixture.save();

test('Real PDF, storage, OCR, offline and 15-paper acceptance', { timeout: 900000 }, async () => {
  try {
    await page.goto(origin);
    await ready();
    await page.locator('#translationMode').selectOption('offline');
    await check('real PDF import and stored bytes', async () => {
      await importPdf('Acceptance.pdf', fixtureBytes);
      assert.equal(await page.locator('#pageCounter').textContent(), '1 / 3');
      assert.equal(await page.locator('.document-item').count(), 1);
    });
    await check('word click, local translation, source context, reviewed save', async () => {
      const term = await clickWord();
      assert.equal(term, 'Water');
      assert.match(await page.locator('#translationInput').inputValue(), /вод/);
      assert.match(await page.locator('#exampleInput').inputValue(), /Water pressure increases/);
      await page.locator('#reviewedCheckbox').check();
      await page.locator('#saveTerm').click();
      await page.locator('#termModal.hidden').waitFor();
      assert.equal(await page.locator('#entryCount').textContent(), '1');
    });
    await check('phrase drag', async () => {
      const rect = await page.locator('#pageContainer').boundingBox();
      const width = await page.locator('#pdfCanvas').evaluate(c => c.clientWidth), scale = width / 600;
      await page.mouse.move(rect.x + 68 * scale, rect.y + 95 * scale);
      await page.mouse.down(); await page.mouse.move(rect.x + 145 * scale, rect.y + 95 * scale, { steps: 10 }); await page.mouse.up();
      await page.locator('#termModal:not(.hidden)').waitFor();
      assert.match(await page.locator('#modalTerm').textContent(), /Water pressure/i);
      await page.locator('#cancelTerm').click();
    });
    await check('page jump, invalid page, zoom and source correction', async () => {
      await page.locator('#pageJump').fill('2'); await page.locator('#pageJump').press('Enter');
      await page.waitForFunction(() => document.querySelector('#pageCounter').textContent === '2 / 3');
      await clickWord(page, 2);
      assert.equal(await page.locator('#sourcePageInput').inputValue(), '2');
      await page.locator('#sourcePageInput').fill('999'); await page.locator('#saveTerm').click();
      assert.ok(await page.locator('#termModal:not(.hidden)').isVisible());
      await page.locator('#cancelTerm').click();
      await page.locator('#pageJump').fill('999'); await page.locator('#pageJump').press('Enter');
      assert.equal(await page.locator('#pageJump').inputValue(), '2');
      await page.locator('#zoomIn').click();
      await page.waitForFunction(() => document.querySelector('#zoomValue').textContent === '115%');
      await clickWord(page, 2); await page.locator('#cancelTerm').click();
    });
    await check('duplicate import and persistence after reload', async () => {
      await importPdf('Acceptance.pdf', fixtureBytes);
      assert.equal(await page.locator('.document-item').count(), 1);
      await page.reload(); await ready();
      assert.equal(await page.locator('#entryCount').textContent(), '1');
      await page.locator('.document-item strong').click(); await painted();
      assert.equal(await page.locator('#pageCounter').textContent(), '2 / 3');
    });
    await check('DOCX, CSV, backup v2 and print', async () => {
      for (const [id, name] of [['exportDocBtn', 'glossary.docx'], ['exportCsvBtn', 'glossary.csv'], ['backupBtn', 'backup.json']]) {
        const pending = page.waitForEvent('download'); await page.locator('#' + id).click();
        await (await pending).saveAs('test-results/' + name);
      }
      const backup = JSON.parse(await readFile('test-results/backup.json', 'utf8'));
      assert.equal(backup.version, 2); assert.equal(backup.entries.length, 1);
      assert.ok(Array.isArray(backup.customDictionary));
      assert.match(await readFile('test-results/glossary.csv', 'utf8'), /Water/);
      await page.locator('#printBtn').click();
      await page.waitForFunction(() => document.querySelector('#printArea tbody tr'));
      await page.pdf({ path: 'test-results/glossary.pdf' });
    });
    await check('restore keeps local edits and rejects malformed rows', async () => {
      const backup = JSON.parse(await readFile('test-results/backup.json', 'utf8'));
      backup.entries[0].translation = 'перевод из старой копии'; backup.entries.push(null);
      await page.locator('#backupInput').setInputFiles({ name: 'restore.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
      await page.waitForFunction(() => document.querySelector('#entryCount').textContent === '2');
      assert.match(await page.locator('#glossaryList').textContent(), /вод/);
      await page.locator('#glossarySearch').fill('старой');
      assert.equal(await page.locator('.glossary-item').count(), 1);
      await page.locator('#glossarySearch').fill('');
      await page.locator('#qualityFilter').selectOption('reviewed');
      assert.equal(await page.locator('.glossary-item').count(), 2);
      await page.locator('#qualityFilter').selectOption('all');
    });
    await check('TSV import and immediate offline lookup', async () => {
      await page.locator('#dictionaryInput').setInputFiles({ name: 'dictionary.tsv', mimeType: 'text/plain', buffer: Buffer.from('water\tпользовательский перевод воды\n') });
      await page.waitForFunction(() => document.querySelector('#dictInfo').textContent.includes('Импортировано'));
      await clickWord(page, 2);
      assert.equal(await page.locator('#translationInput').inputValue(), 'пользовательский перевод воды');
      await page.locator('#cancelTerm').click();
    });
    await check('live online translator or honest local fallback', async () => {
      await page.locator('#translationMode').selectOption('auto');
      await clickWord(page, 2);
      await page.waitForFunction(() => /Научный словарь — основной|Сервис недоступен/.test(document.querySelector('#dictionaryStatus').textContent));
      const status = await page.locator('#dictionaryStatus').textContent();
      assert.match(status, /MyMemory|недоступен|перевод/);
      assert.equal(await page.locator('#translationInput').inputValue(), 'пользовательский перевод воды');
      await writeFile('test-results/live-provider.txt', status);
      console.log('LIVE_PROVIDER', status);
      await page.locator('#cancelTerm').click();
    });
    await check('controlled provider failure uses local dictionary', async () => {
      // Only this network failure regression substitutes the translation service.
      await page.route('https://api.mymemory.translated.net/**', route => route.fulfill({ status: 503, body: 'unavailable' }));
      await clickWord(page, 2);
      await page.waitForFunction(() => document.querySelector('#dictionaryStatus').textContent.includes('Сервис недоступен'));
      assert.equal(await page.locator('#translationInput').inputValue(), 'пользовательский перевод воды');
      await page.locator('#cancelTerm').click();
      await page.unroute('https://api.mymemory.translated.net/**');
      await page.locator('#translationMode').selectOption('offline');
    });
    await check('15 published articles: real import, word click, example, save, final-page navigation', async () => {
      const papers = JSON.parse(await readFile('tests/papers.json', 'utf8'));
      const articleResults = [];
      for (const paper of papers) {
        await importPdf(paper.id + '.pdf', await readFile(`qa-papers/${paper.id}.pdf`));
        assert.equal(await page.locator('#pageCounter').textContent(), `1 / ${paper.pages}`);
        const term = await clickWord();
        const example = await page.locator('#exampleInput').inputValue();
        assert.ok(example.toLowerCase().includes(term.toLowerCase()));
        if (!(await page.locator('#translationInput').inputValue())) await page.locator('#translationInput').fill('контрольная запись QA');
        await page.locator('#saveTerm').click(); await page.locator('#termModal.hidden').waitFor();
        await page.locator('#pageJump').fill(String(paper.pages)); await page.locator('#pageJump').press('Enter');
        await page.waitForFunction(pages => document.querySelector('#pageCounter').textContent === `${pages} / ${pages}`, paper.pages);
        articleResults.push({ id: paper.id, pages: paper.pages, selected: term, example, passed: true });
        console.log('ARTICLE', paper.id, paper.pages, term);
      }
      await writeFile('test-results/articles.json', JSON.stringify(articleResults, null, 2));
    });
    await check('complete offline installation, reload, import and real OCR', async () => {
      await page.evaluate(() => navigator.serviceWorker.ready);
      await page.waitForFunction(() => navigator.serviceWorker.controller);
      const image = await page.evaluate(() => {
        const c = document.createElement('canvas'); c.width = 1200; c.height = 1600;
        const g = c.getContext('2d'); g.fillStyle = 'white'; g.fillRect(0, 0, c.width, c.height);
        g.fillStyle = 'black'; g.font = '36px Arial'; g.fillText('Water pressure increases during the experiment.', 70, 100);
        return c.toDataURL('image/png').split(',')[1];
      });
      const scan = await PDFDocument.create(); const png = await scan.embedPng(Buffer.from(image, 'base64'));
      scan.addPage([600, 800]).drawImage(png, { x: 0, y: 0, width: 600, height: 800 });
      await context.setOffline(true); await page.reload(); await ready();
      await importPdf('Scanned.pdf', await scan.save());
      await page.locator('#ocrBtn').click();
      await page.waitForFunction(() => /OCR: \d+ слов/.test(document.querySelector('#ocrStatus').textContent), { timeout: 120000 });
      const width = await page.locator('#pdfCanvas').evaluate(c => c.clientWidth);
      await page.locator('#pageContainer').click({ position: { x: 112 / 1200 * width, y: 87 / 1200 * width } });
      await page.locator('#termModal:not(.hidden)').waitFor();
      assert.equal((await page.locator('#modalTerm').textContent()).toLowerCase(), 'water');
      assert.equal(await page.locator('#sourcePageInput').inputValue(), '1');
      assert.match(await page.locator('#exampleInput').inputValue(), /Water pressure increases/);
      await page.locator('#cancelTerm').click();
      await page.locator('#zoomIn').click();
      await page.waitForFunction(() => document.querySelector('#zoomValue').textContent === '115%');
      await painted();
      await page.locator('#ocrBtn').click();
      await page.waitForFunction(() => /OCR: \d+ слов/.test(document.querySelector('#ocrStatus').textContent));
      await context.setOffline(false);
    });
    await check('mobile layout and glossary navigation', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator('#mobileGlossary').click();
      assert.ok(await page.locator('#glossarySearch').isVisible());
      await page.locator('#mobileLibrary').click();
      assert.ok(await page.locator('.document-item').first().isVisible());
      await page.locator('#mobileRead').click();
      assert.ok(await page.locator('#pdfCanvas').isVisible());
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.screenshot({ path: 'test-results/mobile.png', fullPage: true });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.screenshot({ path: 'test-results/desktop.png', fullPage: true });
    });
    assert.deepEqual(errors, [], 'No unhandled browser errors');
  } finally {
    await writeFile('test-results/results.json', JSON.stringify({ passed: results, errors }, null, 2));
    await page.screenshot({ path: 'test-results/final.png', fullPage: true }).catch(() => {});
    await browser.close(); server.close();
  }
});
