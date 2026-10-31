import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Focused unit tests execute the shipped functions, with only the network and
// field objects supplied by the harness. Real DOM coverage lives in app.test.mjs.
const html = await readFile('index.html', 'utf8');
const helper = html.slice(html.indexOf('  function applySuggestedValue('), html.indexOf('  async function translateSelectedTerm('));
const translate = html.slice(html.indexOf('  async function translateExampleOnline('), html.indexOf("  $('translateExampleBtn').addEventListener"));
function editor() {
  let answer;
  const fields = {
    exampleTranslationInput: { value: 'Сохранённый перевод' },
    exampleTranslationStatus: { textContent: '' },
    translateExampleBtn: { disabled: false }, reviewedCheckbox: { checked: true }
  };
  const scope = vm.createContext({
    $: id => fields[id], elements: { exampleInput: { value: 'Water flows.' }, modal: { classList: { contains: () => false } } },
    currentTranslationMode: () => 'auto', internetCandidate: () => true,
    fetchWithTimeout: () => new Promise(resolve => { answer = resolve; }),
    exampleAbort: null, pendingTerm: 'Water', exampleRequestSerial: 0, editingExampleTranslationByUser: true
  });
  vm.runInContext(helper + translate, scope);
  return { scope, fields, respond: text => answer(text), start: () => scope.translateExampleOnline() };
}
test('explicit retranslation updates a saved example and clears review', async () => {
  const e = editor(), request = e.start(); e.respond('Новый перевод'); await request;
  assert.equal(e.fields.exampleTranslationInput.value, 'Новый перевод');
  assert.equal(e.fields.reviewedCheckbox.checked, false);
  assert.equal(e.fields.translateExampleBtn.disabled, false);
});
test('typing during a request wins over its delayed response', async () => {
  const e = editor(), request = e.start();
  e.fields.exampleTranslationInput.value = 'Моя правка'; e.scope.editingExampleTranslationByUser = true;
  e.respond('Поздний ответ'); await request;
  assert.equal(e.fields.exampleTranslationInput.value, 'Моя правка');
  assert.equal(e.fields.reviewedCheckbox.checked, true);
  assert.match(e.fields.exampleTranslationStatus.textContent, /Ручная правка сохранена/);
});
test('changing the source sentence discards the old response', async () => {
  const e = editor(), request = e.start(); e.scope.elements.exampleInput.value = 'A different sentence.';
  e.respond('Перевод старого предложения'); await request;
  assert.equal(e.fields.exampleTranslationInput.value, 'Сохранённый перевод');
  assert.match(e.fields.exampleTranslationStatus.textContent, /Пример изменён/);
  assert.equal(e.fields.translateExampleBtn.disabled, false);
});
test('response for a different card cannot change its translation', async () => {
  const e = editor(), request = e.start(); e.scope.pendingTerm = 'Pressure'; e.scope.exampleRequestSerial++;
  e.respond('Перевод другой карточки'); await request;
  assert.equal(e.fields.exampleTranslationInput.value, 'Сохранённый перевод');
});
test('identical automatic suggestion keeps the existing review', () => {
  const e = editor(); e.scope.applySuggestedValue(e.fields.exampleTranslationInput, 'Сохранённый перевод');
  assert.equal(e.fields.reviewedCheckbox.checked, true);
});
