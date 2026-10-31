import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const html = await readFile('index.html', 'utf8');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
assert.equal(ids.length, new Set(ids).size, 'Duplicate HTML IDs');
for (const id of ['pageJump', 'qualityFilter', 'reviewedCheckbox', 'exportDocBtn', 'pdfInput']) assert.ok(ids.includes(id));
const scripts = [...html.matchAll(/<script>\s*([\s\S]*?)<\/script>/g)];
assert.equal(scripts.length, 2);
for (const [i, script] of scripts.entries()) new vm.Script(script[1], { filename: `embedded-${i}.js` });
new vm.Script(await readFile('sw.js', 'utf8'));
assert.ok(!html.includes('3.11.174'), 'Old CDN-dependent PDF.js must not return');
const manifest = JSON.parse(await readFile('vendor/manifest.json', 'utf8'));
for (const file of manifest.files) {
  const bytes = await readFile(file.path);
  assert.equal(bytes.length, file.bytes, file.path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, file.path);
}
console.log(`Syntax, UI, and ${manifest.files.length} vendor hashes verified`);
