/* ScientificGlossary Web v0.2 — PDF import & storage fix */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const DB_NAME = 'scientific-glossary-web';
  const DB_VERSION = 1;
  let db;
  let pdfDoc = null;
  let currentDoc = null;
  let currentPage = 1;
  let zoom = 1;
  let currentPageText = '';
  let dictionary = new Map();
  let pendingTerm = '';
  let deferredInstallPrompt = null;
  let toastTimer;

  const elements = {
    pdfInput: $('pdfInput'), documentsList: $('documentsList'), glossaryList: $('glossaryList'),
    entryCount: $('entryCount'), glossarySearch: $('glossarySearch'), currentDocName: $('currentDocName'),
    pageInfo: $('pageInfo'), pageCounter: $('pageCounter'), pageWrap: $('pageWrap'), pageContainer: $('pageContainer'),
    canvas: $('pdfCanvas'), textLayer: $('textLayer'), welcome: $('welcome'), viewport: $('readerViewport'),
    prevPage: $('prevPage'), nextPage: $('nextPage'), zoomOut: $('zoomOut'), zoomIn: $('zoomIn'), zoomValue: $('zoomValue'),
    modal: $('termModal'), modalTerm: $('modalTerm'), translationInput: $('translationInput'), exampleInput: $('exampleInput'),
    sourceInfo: $('sourceInfo'), pageSource: $('pageSource'), dictionaryStatus: $('dictionaryStatus'), toast: $('toast'),
  };

  function showToast(message, duration = 4500) {
    elements.toast.textContent = message;
    elements.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => elements.toast.classList.remove('show'), duration);
  }
  function makeId() { return (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`); }
  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const d = request.result;
        if (!d.objectStoreNames.contains('documents')) d.createObjectStore('documents', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('entries')) d.createObjectStore('entries', { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  function store(name, mode = 'readonly') { return db.transaction(name, mode).objectStore(name); }
  function dbPut(name, value) { return new Promise((resolve, reject) => { const r = store(name, 'readwrite').put(value); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); }
  function dbGet(name, key) { return new Promise((resolve, reject) => { const r = store(name).get(key); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); }
  function dbAll(name) { return new Promise((resolve, reject) => { const r = store(name).getAll(); r.onsuccess = () => resolve(r.result || []); r.onerror = () => reject(r.error); }); }
  function dbDelete(name, key) { return new Promise((resolve, reject) => { const r = store(name, 'readwrite').delete(key); r.onsuccess = () => resolve(); r.onerror = () => reject(r.error); }); }

  async function loadDictionary() {
    try {
      const response = await fetch('assets/dictionary.tsv');
      if (!response.ok) throw new Error('dictionary fetch failed');
      const text = await response.text();
      for (const line of text.split(/\r?\n/)) {
        if (!line || line.startsWith('#')) continue;
        const [term, translation] = line.split('\t');
        if (term && translation) dictionary.set(term.trim().toLowerCase(), translation.trim());
      }
      // Terms found in the sample article; concise contextual translations.
      const additions = {
        'electrostatic coalescer':'электростатический коалесцер; электродегидратор',
        'rigorous modeling':'строгое математическое моделирование',
        'first-principle model':'модель, основанная на фундаментальных физических законах',
        'dispersed phase':'дисперсная фаза', 'continuous phase':'непрерывная фаза',
        'droplet diameter':'диаметр капли', 'interfacial tension':'межфазное натяжение',
        'electrical field':'электрическое поле', 'electric field':'электрическое поле',
        'permittivity':'диэлектрическая проницаемость', 'buoyancy':'выталкивающая сила; сила Архимеда',
        'drag force':'сила сопротивления', 'residence time':'время пребывания',
        'volume fraction':'объёмная доля', 'boundary conditions':'граничные условия',
        'numerical integration':'численное интегрирование', 'sensitivity analysis':'анализ чувствительности',
        'water-in-oil emulsion':'эмульсия типа «вода в нефти»', 'droplet distribution':'распределение капель по размерам',
        'coalescence coefficient':'коэффициент коалесценции', 'oil viscosity':'вязкость нефти',
        'water concentration':'концентрация воды', 'critical diameter':'критический диаметр',
        'volumetric flow rate':'объёмный расход', 'mass balance':'материальный баланс',
        'numerical solution':'численное решение', 'operating conditions':'рабочие условия; условия эксплуатации',
        'phase separation':'разделение фаз', 'crude oil':'сырая нефть',
      };
      Object.entries(additions).forEach(([k,v]) => dictionary.set(k,v));
    } catch (err) {
      console.warn('Dictionary could not be loaded', err);
      showToast('Не удалось загрузить встроенный словарь. Проверьте файлы приложения.');
    }
  }

  function renderDocuments(docs) {
    elements.documentsList.replaceChildren();
    if (!docs.length) {
      const empty = document.createElement('div'); empty.className = 'empty-small'; empty.textContent = 'Пока нет документов. Добавьте PDF-файл.'; elements.documentsList.append(empty); return;
    }
    docs.sort((a,b) => (b.addedAt || 0) - (a.addedAt || 0));
    for (const doc of docs) {
      const row = document.createElement('div'); row.className = `document-item ${currentDoc?.id === doc.id ? 'active' : ''}`;
      const icon = document.createElement('div'); icon.className = 'doc-mini'; icon.textContent = 'PDF';
      const body = document.createElement('div'); body.style.minWidth = '0';
      const title = document.createElement('strong'); title.textContent = doc.name;
      const meta = document.createElement('small'); meta.textContent = `${doc.pages || 'PDF'} · ${new Date(doc.addedAt).toLocaleDateString('ru-RU')}`;
      body.append(title, meta); row.append(icon, body);
      row.addEventListener('click', () => openDocument(doc.id));
      elements.documentsList.append(row);
    }
  }
  async function refreshDocuments() { renderDocuments(await dbAll('documents')); }

  // PDF.js can transfer the Uint8Array to its worker. That detaches the
  // ArrayBuffer; never give PDF.js the only copy that we intend to store.
  // Source: https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html
  async function handlePdfUpload(file) {
    if (!file) return;
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      showToast('Пожалуйста, выберите файл PDF.'); return;
    }
    let stage = 'read';
    try {
      showToast('Читаю файл PDF…');
      const originalData = await file.arrayBuffer();
      if (!originalData.byteLength) throw new Error('Файл пуст.');
      // The independent copy may be transferred; originalData stays intact.
      stage = 'parse';
      const task = pdfjsLib.getDocument({ data: new Uint8Array(originalData.slice(0)) });
      const loaded = await task.promise;
      const numPages = loaded.numPages;
      if (!numPages) throw new Error('В документе не обнаружены страницы.');
      // Releasing the validation document does not affect our saved bytes.
      try { await loaded.destroy(); } catch (_) { /* best effort */ }

      stage = 'save';
      const doc = {
        id: makeId(), name: file.name, size: originalData.byteLength,
        addedAt: Date.now(), pages: numPages, data: originalData,
      };
      await dbPut('documents', doc);
      await refreshDocuments();
      stage = 'open';
      const opened = await openDocument(doc.id);
      if (opened) showToast('PDF добавлен в библиотеку и открыт.', 3200);
      else showToast('PDF сохранён, но страницу не удалось отобразить. Подробности в консоли.', 6000);
    } catch (error) {
      console.error('PDF import failed at stage:', stage, error);
      const name = error?.name || '';
      let msg;
      if (name === 'PasswordException') msg = 'Этот PDF защищён паролем. Откройте файл без защиты.';
      else if (name === 'InvalidPDFException' || name === 'MissingPDFException') msg = 'Не удалось прочитать формат PDF. Проверьте документ.';
      else if (name === 'QuotaExceededError') msg = 'Недостаточно свободного места в браузере для сохранения PDF.';
      else if (stage === 'save' || name === 'DataCloneError') msg = 'PDF прочитан, но браузер не смог сохранить его. Проверьте разрешения и свободное место.';
      else msg = `Ошибка при загрузке PDF (${stage}): ${String(error?.message || name || 'неизвестная причина').slice(0, 150)}`;
      showToast(msg, 8000);
    } finally { elements.pdfInput.value = ''; }
  }

  async function openDocument(id) {
    try {
      const doc = await dbGet('documents', id);
      if (!doc) return false;
      // dbGet supplies an independent structured-clone of stored data.
      const task = pdfjsLib.getDocument({ data: new Uint8Array(doc.data) });
      const openedPdf = await task.promise;
      pdfDoc = openedPdf; currentDoc = doc; currentPage = 1; zoom = 1;
      elements.currentDocName.textContent = doc.name;
      elements.pageInfo.textContent = `${pdfDoc.numPages} страниц · PDF хранится на этом устройстве`;
      elements.welcome.classList.add('hidden'); elements.pageWrap.classList.remove('hidden');
      await renderPage();
      await refreshDocuments();
      return true;
    } catch (error) {
      console.error('PDF open/render failed', error);
      showToast(`Не удалось отобразить страницу: ${String(error?.message || error).slice(0, 140)}`, 7500);
      return false;
    }
  }

  async function renderPage() {
    if (!pdfDoc) return;
    const page = await pdfDoc.getPage(currentPage);
    const base = page.getViewport({ scale: 1 });
    const maxWidth = Math.max(260, elements.viewport.clientWidth - 42);
    const fitScale = Math.min(1.5, maxWidth / base.width);
    const scale = fitScale * zoom;
    const viewport = page.getViewport({ scale });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = elements.canvas; const context = canvas.getContext('2d', { alpha: false });
    canvas.width = Math.floor(viewport.width * dpr); canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`;
    elements.pageContainer.style.width = `${viewport.width}px`; elements.pageContainer.style.height = `${viewport.height}px`;
    elements.textLayer.replaceChildren();
    elements.textLayer.style.width = `${viewport.width}px`; elements.textLayer.style.height = `${viewport.height}px`;
    await page.render({ canvasContext: context, viewport, transform: dpr !== 1 ? [dpr,0,0,dpr,0,0] : null }).promise;
    try {
      const textContent = await page.getTextContent();
      currentPageText = textContent.items.map(item => item.str).filter(Boolean).join(' ').replace(/\s+/g,' ').trim();
      if (pdfjsLib.renderTextLayer) {
        const textTask = pdfjsLib.renderTextLayer({ textContent, container: elements.textLayer, viewport, textDivs: [] });
        if (textTask.promise) await textTask.promise;
      }
    } catch (error) {
      // A broken text layer must not prevent reading a page with figures/formulas.
      console.warn('PDF text layer unavailable for this page', error);
      currentPageText = '';
      elements.textLayer.replaceChildren();
      showToast('Страница открыта, но выделение текста на ней недоступно.', 4500);
    }
    elements.pageCounter.textContent = `${currentPage} / ${pdfDoc.numPages}`;
    elements.zoomValue.textContent = `${Math.round(zoom*100)}%`;
    elements.prevPage.disabled = currentPage <= 1; elements.nextPage.disabled = currentPage >= pdfDoc.numPages;
    elements.pageInfo.textContent = `Страница ${currentPage} из ${pdfDoc.numPages}`;
    elements.viewport.scrollTop = 0; elements.viewport.scrollLeft = 0;
  }

  function sentenceFor(term) {
    const text = currentPageText || '';
    const idx = text.toLowerCase().indexOf(term.toLowerCase());
    if (idx < 0) return text.slice(0, 500);
    let start = Math.max(text.lastIndexOf('.', idx), text.lastIndexOf('?', idx), text.lastIndexOf('!', idx)) + 1;
    let endCandidates = ['.','?','!'].map(p => text.indexOf(p, idx)).filter(n => n >= 0);
    let end = endCandidates.length ? Math.min(...endCandidates) + 1 : Math.min(text.length, idx + 260);
    let s = text.slice(start, end).trim();
    if (s.length < 15) s = text.slice(Math.max(0,idx-90), Math.min(text.length,idx+180)).trim();
    return s;
  }
  function normalizeTerm(term) { return term.toLowerCase().replace(/[“”".,;:!?()[\]{}]/g,'').replace(/\s+/g,' ').trim(); }
  function findTranslation(term) {
    const key = normalizeTerm(term);
    if (dictionary.has(key)) return dictionary.get(key);
    const singular = key.replace(/ies$/,'y').replace(/s$/,'');
    if (dictionary.has(singular)) return dictionary.get(singular);
    return '';
  }
  function wordAtPoint(x,y) {
    let range = document.caretRangeFromPoint ? document.caretRangeFromPoint(x,y) : null;
    if (!range && document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(x,y);
      if (pos) { range = document.createRange(); range.setStart(pos.offsetNode,pos.offset); range.collapse(true); }
    }
    if (!range) return '';
    let node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return '';
    const text = node.textContent || ''; const offset = range.startOffset;
    const re = /[\p{L}\p{M}][\p{L}\p{M}'’\-]*/gu; let match;
    while ((match = re.exec(text))) if (offset >= match.index && offset <= match.index + match[0].length) return match[0];
    return '';
  }
  function openTerm(term) {
    const cleaned = term.trim().replace(/\s+/g,' ');
    if (!cleaned || cleaned.length > 90) return;
    pendingTerm = cleaned;
    const translation = findTranslation(cleaned);
    elements.modalTerm.textContent = cleaned;
    elements.translationInput.value = translation;
    elements.exampleInput.value = sentenceFor(cleaned);
    elements.sourceInfo.textContent = `Источник: ${currentDoc?.name || '—'}`;
    elements.pageSource.textContent = `Страница ${currentPage}`;
    elements.dictionaryStatus.textContent = translation ? 'Найдено во встроенном локальном словаре. Проверьте значение по контексту.' : 'Термин не найден в локальном словаре. Можно ввести свой перевод.';
    elements.modal.classList.remove('hidden');
    setTimeout(() => elements.translationInput.focus(), 80);
  }
  function closeTerm() { elements.modal.classList.add('hidden'); pendingTerm = ''; }

  async function saveTerm() {
    const translation = elements.translationInput.value.trim();
    const example = elements.exampleInput.value.trim();
    if (!pendingTerm) return;
    if (!translation) { showToast('Добавьте перевод перед сохранением.'); return; }
    const entries = await dbAll('entries');
    const duplicate = entries.find(e => normalizeTerm(e.term) === normalizeTerm(pendingTerm) && e.sourceName === (currentDoc?.name || ''));
    const entry = { id: duplicate?.id || makeId(), term: pendingTerm, translation, example, sourceName: currentDoc?.name || '', sourceId: currentDoc?.id || '', page: currentPage, createdAt: duplicate?.createdAt || Date.now() };
    await dbPut('entries', entry);
    closeTerm(); await refreshGlossary(); showToast(duplicate ? 'Запись обновлена.' : 'Термин добавлен в глоссарий.');
  }
  async function refreshGlossary() {
    const entries = await dbAll('entries');
    elements.entryCount.textContent = entries.length;
    const query = elements.glossarySearch.value.trim().toLowerCase();
    const filtered = entries.filter(e => `${e.term} ${e.translation} ${e.example} ${e.sourceName}`.toLowerCase().includes(query)).sort((a,b) => b.createdAt-a.createdAt);
    elements.glossaryList.replaceChildren();
    if (!filtered.length) { const empty = document.createElement('div'); empty.className='empty-small'; empty.textContent = entries.length ? 'Ничего не найдено.' : 'Здесь появятся ваши слова.'; elements.glossaryList.append(empty); return; }
    for (const entry of filtered) {
      const row = document.createElement('div'); row.className='glossary-item';
      const body=document.createElement('div'); body.style.minWidth='0';
      const term=document.createElement('strong'); term.textContent=entry.term;
      const trans=document.createElement('p'); trans.textContent=entry.translation;
      const meta=document.createElement('small'); meta.textContent=`${entry.sourceName || 'Без источника'} · стр. ${entry.page || '—'}`;
      body.append(term,trans,meta);
      const del=document.createElement('button'); del.className='delete-entry'; del.textContent='×'; del.title='Удалить'; del.addEventListener('click',async()=>{await dbDelete('entries',entry.id);refreshGlossary();showToast('Запись удалена.');});
      row.append(body,del); elements.glossaryList.append(row);
    }
  }
  async function exportEntries() {
    const entries = (await dbAll('entries')).sort((a,b)=>a.term.localeCompare(b.term,'en'));
    if (!entries.length) { showToast('Глоссарий пока пуст.'); return null; }
    return entries;
  }
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=filename; document.body.append(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),1500);
  }
  async function exportCsv() {
    const entries=await exportEntries(); if(!entries)return;
    const rows=[['№','English term','Перевод','Example of usage','Источник','Страница'],...entries.map((e,i)=>[i+1,e.term,e.translation,e.example,e.sourceName,e.page])];
    const csv='\uFEFF'+rows.map(row=>row.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(';')).join('\r\n');
    downloadBlob(new Blob([csv],{type:'text/csv;charset=utf-8'}),'ScientificGlossary.csv'); showToast('CSV-файл подготовлен.');
  }
  function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  async function exportWord() {
    const entries=await exportEntries(); if(!entries)return;
    const html=`<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:Arial}h1{text-align:center;font-size:18pt}table{border-collapse:collapse;width:100%}th,td{border:1px solid #555;padding:6px;vertical-align:top;font-size:10pt}th{background:#e8edf5}</style></head><body><h1>Англо-русский глоссарий</h1><p>Научная литература · сформировано ${new Date().toLocaleDateString('ru-RU')}</p><table><tr><th>№</th><th>English term</th><th>Перевод</th><th>Example of usage</th><th>Источник / страница</th></tr>${entries.map((e,i)=>`<tr><td>${i+1}</td><td>${esc(e.term)}</td><td>${esc(e.translation)}</td><td>${esc(e.example)}</td><td>${esc(e.sourceName)} / ${esc(e.page)}</td></tr>`).join('')}</table></body></html>`;
    downloadBlob(new Blob([html],{type:'application/msword;charset=utf-8'}),'ScientificGlossary.doc'); showToast('Word-совместимый документ подготовлен (.doc).');
  }
  async function printGlossary() {
    const entries=await exportEntries(); if(!entries)return;
    const area=$('printArea'); area.innerHTML=`<h1>Англо-русский глоссарий</h1><div class="print-meta">Научная литература · ${new Date().toLocaleDateString('ru-RU')} · терминов: ${entries.length}</div><table><thead><tr><th>№</th><th>English term</th><th>Перевод</th><th>Example of usage</th><th>Источник / страница</th></tr></thead><tbody>${entries.map((e,i)=>`<tr><td>${i+1}</td><td>${esc(e.term)}</td><td>${esc(e.translation)}</td><td>${esc(e.example)}</td><td>${esc(e.sourceName)} / ${esc(e.page)}</td></tr>`).join('')}</tbody></table>`;
    window.print();
  }

  elements.pdfInput.addEventListener('change',e=>handlePdfUpload(e.target.files?.[0]));
  elements.prevPage.addEventListener('click',async()=>{if(currentPage>1){currentPage--;await renderPage();}});
  elements.nextPage.addEventListener('click',async()=>{if(pdfDoc&&currentPage<pdfDoc.numPages){currentPage++;await renderPage();}});
  elements.zoomIn.addEventListener('click',async()=>{zoom=Math.min(2.5,zoom+.15);await renderPage();});
  elements.zoomOut.addEventListener('click',async()=>{zoom=Math.max(.55,zoom-.15);await renderPage();});
  elements.textLayer.addEventListener('click',e=>{
    const selected=window.getSelection()?.toString().trim();
    if(selected && selected.length>1){openTerm(selected);return;}
    const word=wordAtPoint(e.clientX,e.clientY); if(word) openTerm(word);
  });
  elements.textLayer.addEventListener('touchend',e=>{
    const selected=window.getSelection()?.toString().trim();
    if(selected && selected.length>1) openTerm(selected);
  },{passive:true});
  $('closeModal').addEventListener('click',closeTerm); $('cancelTerm').addEventListener('click',closeTerm);
  elements.modal.addEventListener('click',e=>{if(e.target.dataset.close)closeTerm();});
  $('saveTerm').addEventListener('click',saveTerm);
  elements.glossarySearch.addEventListener('input',refreshGlossary);
  $('exportCsvBtn').addEventListener('click',exportCsv); $('exportDocBtn').addEventListener('click',exportWord); $('printBtn').addEventListener('click',printGlossary);
  $('clearSelection').addEventListener('click',()=>window.getSelection()?.removeAllRanges());
  $('installBtn').addEventListener('click',async()=>{if(!deferredInstallPrompt)return;deferredInstallPrompt.prompt();await deferredInstallPrompt.userChoice;deferredInstallPrompt=null;$('installBtn').classList.add('hidden');});
  window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredInstallPrompt=e;$('installBtn').classList.remove('hidden');});
  window.addEventListener('resize',()=>{if(pdfDoc)renderPage();});

  async function prepareServiceWorker() {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    try {
      await navigator.serviceWorker.register('sw.js');
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await Promise.race([
          new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true })),
          new Promise(resolve => setTimeout(resolve, 2500))
        ]);
      }
    } catch (err) { console.warn('Service Worker registration failed', err); }
  }
  function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
      script.onload = resolve;
      script.onerror = () => reject(new Error('PDF.js CDN unavailable'));
      document.head.append(script);
    });
  }
  async function init() {
    await prepareServiceWorker();
    try { await loadPdfJs(); }
    catch (err) { console.error(err); showToast('Не удалось загрузить PDF-модуль. Для первого запуска требуется интернет.'); return; }
    pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    try { db=await openDb(); await loadDictionary(); await refreshDocuments(); await refreshGlossary(); }
    catch(error){console.error(error);showToast('Браузер не разрешил локальное хранилище.');}
    if (!window.isSecureContext && location.protocol !== 'file:') showToast('Для установки и офлайн-кэша откройте приложение по HTTPS.');
  }
  init();
})();
