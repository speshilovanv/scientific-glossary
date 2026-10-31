import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
await mkdir('vendor/pdfjs', { recursive: true });
await mkdir('vendor/ocr', { recursive: true });
for (const file of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
  await cp(`node_modules/pdfjs-dist/legacy/build/${file}`, `vendor/pdfjs/${file}`);
}
for (const dir of ['cmaps', 'standard_fonts']) {
  await cp(`node_modules/pdfjs-dist/${dir}`, `vendor/pdfjs/${dir}`, { recursive: true });
}
await cp('node_modules/pdfjs-dist/LICENSE', 'vendor/pdfjs/LICENSE');
for (const file of ['tesseract.min.js', 'worker.min.js']) {
  await cp(`node_modules/tesseract.js/dist/${file}`, `vendor/ocr/${file}`);
}
for (const kind of ['', '-simd', '-relaxedsimd']) {
  await cp(`node_modules/tesseract.js-core/tesseract-core${kind}-lstm.wasm.js`, `vendor/ocr/tesseract-core${kind}-lstm.wasm.js`);
}
await cp('node_modules/tesseract.js/LICENSE.md', 'vendor/ocr/LICENSE');
await cp('node_modules/tesseract.js-core/LICENSE', 'vendor/ocr/CORE-LICENSE');
// Download the official English data package once; the published app never uses a CDN.
// This also makes a repeated build deterministic and possible without a network.
try { await readFile('vendor/eng.traineddata.gz'); } catch {
  const response = await fetch('https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int/eng.traineddata.gz');
  if (!response.ok) throw new Error(`English OCR data: ${response.status}`);
  await writeFile('vendor/eng.traineddata.gz', new Uint8Array(await response.arrayBuffer()));
}
const paths = (await readdir('vendor', { recursive: true, withFileTypes: true }))
  .filter(entry => entry.isFile() && entry.name !== 'manifest.json')
  .map(entry => `${entry.parentPath}/${entry.name}`).sort();
const files = [];
for (const path of paths) {
  const bytes = await readFile(path);
  files.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
await writeFile('vendor/manifest.json', JSON.stringify({ pdfjs: '4.10.38', tesseract: '7.0.0', files }, null, 2) + '\n');
console.log(`Prepared ${files.length} local assets (${Math.round(files.reduce((n, f) => n + f.bytes, 0) / 1024 / 1024)} MB)`);
