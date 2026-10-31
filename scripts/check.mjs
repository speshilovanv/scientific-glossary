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
const dictionary = await readFile('vendor/dictionary/eng-rus.tsv', 'utf8');
assert.ok(dictionary.split('\n').length > 50000, 'Extended offline dictionary must ship');
assert.match(dictionary, /^concept\t.*понятие/m);
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
assert.ok(html.includes(`ScientificGlossary Reader · ${version}`));
assert.ok(html.includes(`scientific-glossary-shell-${version}`));
assert.ok((await readFile('sw.js', 'utf8')).includes(`scientific-glossary-shell-${version}`));
const manifest = JSON.parse(await readFile('vendor/manifest.json', 'utf8'));
assert.ok(manifest.files.some(f => f.path === 'vendor/dictionary/eng-rus.tsv'), 'Offline cache must contain dictionary');
for (const file of manifest.files) {
  const bytes = await readFile(file.path);
  assert.equal(bytes.length, file.bytes, file.path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, file.path);
}
console.log(`Syntax, UI, and ${manifest.files.length} vendor hashes verified`);
