import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile('index.html', 'utf8');
const general = await readFile('vendor/dictionary/eng-rus.tsv', 'utf8');
const embedded = /<script id="embeddedDictionary" type="text\/plain">([\s\S]*?)<\/script>/.exec(html)[1];
const lookup = html.slice(html.indexOf('  function normalizeTerm('), html.indexOf('  function findSelectedTerm('));
const load = html.slice(html.indexOf('  async function loadDictionary('), html.indexOf('  // Browser-side translation provider:'));
const providers = html.slice(html.indexOf('  function wiktionaryTranslations('), html.indexOf('  function addTranslationOption('));
async function dictionaryScope() {
  const fields = {};
  const scope = vm.createContext({ dictionary: new Map(), dictionaryBaseCount: 0,
    window: {}, document: { getElementById: () => ({ textContent: embedded }) },
    $: id => fields[id] ||= {}, console,
    fetch: async () => ({ ok: true, text: async () => general }),
    showToast: message => { throw new Error(message); }
  });
  vm.runInContext(lookup + load, scope); await scope.loadDictionary();
  return scope;
}
test('shipped broad dictionary loads and concepts translates without an online provider', async () => {
  const scope = await dictionaryScope();
  assert.ok(scope.dictionary.size > 56000);
  assert.match(scope.findTranslation('concepts'), /понятие|концепция/);
  const words = 'concepts scheduler cause effect theory dynamics pipeline hydraulics process controls specifications charts controllers maintenance algorithm bandwidth reliability equipment measurement experiments reservoir viscosity permeability coalescence electricity thermodynamics pressure temperature research communication technology efficiency hypothesis phenomenon evidence knowledge'.split(' ');
  for (const word of words) assert.match(scope.findTranslation(word), /[А-Яа-яЁё]/, word);
  console.log(`OFFLINE_COVERAGE ${words.length}/${words.length}; dictionary ${scope.dictionary.size}`);
});
test('inflections, possessives and irregular forms resolve locally', async () => {
  const scope = await dictionaryScope();
  for (const word of ['concepts', 'concept’s', 'concepts’', 'activities', 'increased', 'decreased', 'running', 'studied', 'larger', 'largest', 'children', 'women', 'teeth', 'hypotheses', 'phenomena', 'criteria', 'analyses', 'matrices', 'indices', 'written', 'brought'])
    assert.match(scope.findTranslation(word), /[А-Яа-яЁё]/, word);
  assert.equal(scope.findTranslation('concepts'), scope.findTranslation('concept'));
  assert.equal(scope.findTranslation('suddenly invented multiword qzxv'), '', 'Do not invent a phrase translation from unrelated words');
});
test('technical and user-authored meanings take precedence over the general dictionary', async () => {
  const scope = await dictionaryScope();
  assert.match(scope.findTranslation('electrostatic coalescer'), /электродегидратор/);
  scope.dictionary.set('concept', 'Моё значение');
  assert.equal(scope.findTranslation('concepts'), 'Моё значение');
});
test('Wiktionary parser uses only Russian translations in the English section', () => {
  const scope = vm.createContext({}); vm.runInContext(providers, scope);
  const text = '==English==\n===Translations===\n* Russian: {{t+|ru|по́нятие|n}}, {{t|ru|концепция|f}}\n==German==\n{{t|ru|неверное значение}}';
  assert.equal(scope.wiktionaryTranslations(text), 'понятие; концепция');
  assert.equal(scope.wiktionaryTranslations('==French==\n{{t|ru|не английское слово}}'), '');
});
test('failed MyMemory word lookup falls back to Wiktionary with attribution', async () => {
  let count = 0;
  const scope = vm.createContext({ URL, AbortController, setTimeout, clearTimeout,
    onlineRequestSerial: 1, onlineAbort: null, currentTranslationMode: () => 'auto', internetCandidate: () => true,
    fetchWithTimeout: async () => { throw new Error('HTTP 503'); },
    fetch: async url => { count++; assert.equal(url.hostname, 'en.wiktionary.org'); return { ok: true, json: async () => ({ parse: { wikitext: { '*': '==English==\n{{t+|ru|резервное значение}}' } } }) }; }
  });
  vm.runInContext(lookup + providers, scope);
  const result = await scope.fetchWordTranslation('unlistedword', 1, true);
  assert.equal(result.translation, 'резервное значение'); assert.equal(result.provider, 'Wiktionary');
  assert.equal(result.sourceUrl, 'https://en.wiktionary.org/wiki/unlistedword'); assert.equal(count, 1);
  scope.onlineRequestSerial = 2;
  await assert.rejects(scope.fetchWordTranslation('otherword', 1, true)); assert.equal(count, 1, 'Cancelled lookup must not start another provider');
});
