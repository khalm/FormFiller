import { VERSION } from './version.js';
import { t, getLang, setLang, applyStatic } from './i18n.js';
import { openPdf, pdfjsLib } from './pdf.js';
import { getSegments, readAcroFields, labelAcroFields, detectFlatFields, finishFlatFields, sortFields, wordBoxes, toViewportRect, textWidth } from './detect.js';
import { buildPdf, hasValue, parseDateToIso, formatDate } from './fill.js';
import { markLines, normalizeKind, MARK_STYLES } from './marks.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(kid));
  return e;
};
const svgIcon = (d) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.innerHTML = d; return s; };
const ICONS = {
  pin: '<path d="M12 21s-6-5.6-6-11a6 6 0 0112 0c0 5.4-6 11-6 11z"/><circle cx="12" cy="10" r="2.2"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  move: '<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/>',
  next: '<path d="M9 5l7 7-7 7"/>',
  save: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
};

const S = {
  bytes: null, fileName: '', password: undefined, encrypted: false,
  task: null, doc: null, pages: [], segsByPage: [], fields: [], values: {},
  currentId: null, addMode: null, fingerprint: '', loaded: false, customCount: 0,
  zoom: 1, pageEls: [], editor: null, tab: 'pdf', ink: null, selecting: false, selected: new Set(), marks: [], marking: null,
};

// ------------------------------------------------------------------ helpers
const isTouch = () => matchMedia('(pointer: coarse)').matches;
const isNarrow = () => matchMedia('(max-width: 760px)').matches;
const TEXTLIKE = new Set(['text', 'multiline']);
function toast(msg, kind = '', ms = 3200) {
  const n = el('div', { class: 'toast ' + kind, text: msg });
  $('#toasts').append(n);
  setTimeout(() => n.remove(), ms);
}
function busy(text) {
  if (text === false) { $('#busy').hidden = true; return; }
  $('#busyText').textContent = text;
  $('#busy').hidden = false;
}
function confirmBox(text, ok, cancel) {
  return new Promise((res) => {
    const d = $('#confirmDlg');
    $('#confirmText').textContent = text;
    $('#confirmOk').textContent = ok;
    $('#confirmCancel').textContent = cancel;
    d.returnValue = '';
    d.onclose = () => res(d.returnValue === 'ok');
    d.showModal();
  });
}
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const normLabel = (s) => (s || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9æøåäöüé]+/g, ' ').trim();
const fieldById = (id) => S.fields.find((f) => f.id === id);
const fieldPage = (f) => (f.widgets.length ? f.widgets[0].page : f.page);
const fieldRect = (f) => (f.widgets.length ? f.widgets[0].rect : f.rect);
const fontPt = (f, r = fieldRect(f)) => (f.type === 'multiline' ? Math.min(11, Math.max(7, r.h / 3)) : Math.max(6, Math.min(11, r.h * 0.68)));
const displayOf = (f, v) => { const o = f.options.find((x) => x.value === v); return o ? o.label : (v || ''); };
const valueOf = (f, label) => { const o = f.options.find((x) => x.label === label); return o ? o.value : label; };
const isTyped = (f) => TEXTLIKE.has(f.type) && (!f.signature || f.sigTyped);

// ------------------------------------------------------------------ boot
function boot() {
  $('#version').textContent = 'v' + VERSION;
  $$('.version-text').forEach((n) => { n.textContent = 'v' + VERSION; });
  applyStatic();
  updateLangBtn();
  $('#langBtn').addEventListener('click', () => {
    setLang(getLang() === 'nb' ? 'en' : 'nb');
    updateLangBtn();
    if (S.loaded) { updateHeader(); updateEditBar(); if (S.tab === 'list') renderForm(); }
  });

  const input = $('#fileInput');
  input.addEventListener('change', () => { if (input.files[0]) loadFile(input.files[0]); input.value = ''; });
  const dz = $('#dropzone');
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, () => dz.classList.remove('over')));
  dz.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) loadFile(f); });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer?.files?.[0]; if (f && !$('#home').hidden) loadFile(f); });

  $$('[data-sample]').forEach((b) => b.addEventListener('click', async () => {
    busy(t('reading'));
    try {
      const r = await fetch(b.dataset.sample);
      await loadBytes(new Uint8Array(await r.arrayBuffer()), b.dataset.sample.split('/').pop());
    } catch { busy(false); toast(t('loadFailed'), 'warn'); }
  }));

  $('#newBtn').addEventListener('click', () => goHome());
  $('#brand').addEventListener('click', (e) => { if (S.loaded) { e.preventDefault(); goHome(); } });
  $('#forgetBtn').addEventListener('click', () => {
    for (const k of Object.keys(localStorage)) if (k.startsWith('ff:draft:') || k === 'ff:memory') store.del(k);
    toast(t('forgotten'));
  });

  $$('.tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  $('#scanMoreBtn').addEventListener('click', scanMore);
  $('#previewBtn').addEventListener('click', preview);
  $('#saveBtn').addEventListener('click', openSave);
  $('#downloadBtn').addEventListener('click', () => doSave('download'));
  $('#shareBtn').addEventListener('click', () => doSave('share'));
  $('#previewClose').addEventListener('click', () => $('#previewDlg').close());
  $$('dialog').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close('cancel'); }));
  $('#saveForm').addEventListener('change', updateSaveNotes);

  // editing bar: keep the keyboard open while jumping (don't let the buttons steal focus)
  for (const id of ['#prevBtn', '#nextBtn']) $(id).addEventListener('pointerdown', (e) => e.preventDefault());
  $('#prevBtn').addEventListener('click', () => step(-1));
  $('#nextBtn').addEventListener('click', () => step(1));

  $('#zoomIn').addEventListener('click', () => setZoom(S.zoom * 1.25));
  $('#zoomOut').addEventListener('click', () => setZoom(S.zoom / 1.25));
  $('#zoomLabel').addEventListener('click', () => setZoom(1));
  $('#addBtn').addEventListener('click', () => setAddMode(S.addMode ? null : 'text'));
  $$('[data-add]').forEach((b) => b.addEventListener('click', () => setAddMode(b.dataset.add)));
  $('#addDone').addEventListener('click', () => setAddMode(null));

  setupStage();
  setupSignatureDialog();
  setupInk();
  $('#selBtn').addEventListener('click', () => setSelectMode(!S.selecting));
  $('#markBtn').addEventListener('click', () => setMarkMode(!S.marking));
  S.markStyle = normalizeKind(store.get('ff:markStyle', 'strike1'));
  $('#markStyle').value = S.markStyle;
  $('#markStyle').addEventListener('change', (e) => { S.markStyle = e.target.value; store.set('ff:markStyle', S.markStyle); maybeWarnErase(); updateCoverUi(); });
  S.coverColor = store.get('ff:coverColor', 'auto');
  $$('[data-cover]').forEach((b) => b.addEventListener('click', () => setCoverColor(b.dataset.cover)));
  $('#coverCustom').addEventListener('input', (e) => setCoverColor(e.target.value));
  $('#pipetteBtn').addEventListener('click', () => setPipette(!S.pipette));
  updateCoverUi();
  $('#markUndo').addEventListener('click', undo);
  for (const id of ['#undoBtn', '#redoBtn']) $(id).addEventListener('pointerdown', (e) => e.preventDefault());
  $('#undoBtn').addEventListener('click', undo);
  $('#redoBtn').addEventListener('click', redo);
  document.addEventListener('keydown', (e) => {
    if (!S.loaded || $('#fill').hidden || !(e.ctrlKey || e.metaKey)) return;
    const typing = document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && !document.activeElement.classList.contains('ov-editor');
    if (typing) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(); }
  });
  $('#markType').addEventListener('click', typeOverLastMark);
  $('#markDone').addEventListener('click', () => setMarkMode(null));
  $('#selCancel').addEventListener('click', () => setSelectMode(false));
  $('#selMerge').addEventListener('click', mergeSelected);
  window.addEventListener('scroll', () => document.body.classList.toggle('scrolled', scrollY > 4), { passive: true });
  window.addEventListener('popstate', () => { if (S.loaded && !$('#fill').hidden) goHome(true); });
  let lastW = innerWidth;
  window.addEventListener('resize', () => {
    detectKeyboard();
    if (!S.loaded) return;
    if (Math.abs(innerWidth - lastW) > 30) { lastW = innerWidth; layoutPages(true); }
    if (S.editor) requestAnimationFrame(() => ensureVisible(fieldById(S.currentId), false));
  });
  setupPwa();
}
function updateLangBtn() { $('#langBtn').textContent = getLang() === 'nb' ? 'EN' : 'NO'; $('#langBtn').title = t('language'); }

// hide the chrome while the on-screen keyboard is up so there's room to see the box
let fullH = innerHeight;
function detectKeyboard() {
  if (!isTouch()) return;
  if (innerHeight > fullH) fullH = innerHeight;
  const ae = document.activeElement;
  const typing = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA') && ae.type !== 'date';
  document.body.classList.toggle('kb', !!(S.loaded && typing && innerHeight < fullH * 0.78));
}
screen.orientation?.addEventListener?.('change', () => { fullH = 0; setTimeout(() => { fullH = innerHeight; }, 400); });

// ------------------------------------------------------------------ loading
async function loadFile(file) {
  if (file.type && file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) { toast(t('notPdf'), 'warn'); return; }
  busy(t('reading'));
  try { await loadBytes(new Uint8Array(await file.arrayBuffer()), file.name); }
  catch (e) { console.error(e); busy(false); toast(t('loadFailed'), 'warn'); }
}

function askPassword(wrong) {
  return new Promise((res) => {
    busy(false);
    const d = $('#pwDlg');
    $('#pwText').textContent = wrong ? t('passwordWrong') : t('passwordText');
    $('#pwInput').value = '';
    d.returnValue = '';
    d.onclose = () => res(d.returnValue === 'ok' ? $('#pwInput').value : null);
    d.showModal();
    setTimeout(() => $('#pwInput').focus(), 50);
  });
}

async function loadBytes(bytes, name) {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  if (!head.includes('%PDF')) { busy(false); toast(t('notPdf'), 'warn'); return; }
  if (S.task) { try { await S.task.destroy(); } catch {} }
  Object.assign(S, { bytes, fileName: name || 'document.pdf', password: undefined, task: null, doc: null, pages: [], segsByPage: [], fields: [], values: {}, currentId: null, customCount: 0, addMode: null, zoom: 1, editor: null, marks: [], marking: null, annots: [] });

  const task = openPdf(bytes);
  task.onPassword = async (update, reason) => {
    const pw = await askPassword(reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD);
    if (pw == null) { task.destroy(); return; }
    S.password = pw;
    busy(t('reading'));
    update(pw);
  };
  let doc;
  try { doc = await task.promise; } catch (e) {
    busy(false);
    if (e?.name !== 'AbortException' && !/destroyed/i.test(e?.message || '')) toast(t('loadFailed'), 'warn');
    return;
  }
  S.doc = doc;
  S.task = task;
  S.fingerprint = (doc.fingerprints && doc.fingerprints[0]) || name + bytes.length;
  const tail = new TextDecoder('latin1').decode(bytes.length > 4e6 ? bytes.subarray(bytes.length - 2e6) : bytes);
  S.encrypted = /\/Encrypt\s*[\d<]/.test(tail) || S.password != null;

  busy(t('analyzing'));
  for (let i = 0; i < doc.numPages; i++) {
    const page = await doc.getPage(i + 1);
    S.pages.push({ index: i, page, viewport: page.getViewport({ scale: 1 }) });
  }
  for (const pg of S.pages) S.segsByPage[pg.index] = await getSegments(pg.page, pg.viewport).catch(() => []);
  // things other apps added on top of the page (typed text, drawings, stamps)
  for (const pg of S.pages) {
    const anns = await pg.page.getAnnotations({ intent: 'display' }).catch(() => []);
    for (const a of anns) {
      if (['Widget', 'Link', 'Popup'].includes(a.subtype) || !a.rect) continue;
      const v = toViewportRect(pg.viewport, a.rect);
      const text = a.contentsObj?.str || (Array.isArray(a.textContent) ? a.textContent.join('\n') : '') || '';
      S.annots.push({ id: a.id, page: pg.index, subtype: a.subtype, text, lines: Math.max(1, text.split('\n').length),
        rect: { x: Math.min(v[0], v[2]), y: Math.min(v[1], v[3]), w: Math.abs(v[2] - v[0]), h: Math.abs(v[3] - v[1]) } });
    }
  }
  let fields = await readAcroFields(doc, S.pages).catch((e) => { console.warn(e); return []; });
  labelAcroFields(fields, S.segsByPage);
  if (S.encrypted) {
    // protected files can't take drawn signatures: offer typing instead, drop pure signature fields
    fields = fields.filter((f) => f.type !== 'signature');
    for (const f of fields) f.signature = false;
  }
  S.isFlat = fields.length === 0;
  if (S.isFlat) fields = await scanFlat([]);
  S.fields = sortFields(fields);
  for (const f of S.fields) S.values[f.id] = f.isDate ? parseDateToIso(f.initial, f.dateFormat) : structuredClone(f.initial);

  S.loaded = true;
  resetHistory();
  busy(false);
  showFill();
  maybeOfferRestore();
}

async function scanFlat(existing) {
  const avoid = (pg) => existing.flatMap((f) => (f.widgets.length ? f.widgets.filter((w) => w.page === pg).map((w) => w.rect) : (f.page === pg ? [f.rect] : [])));
  const found = [];
  for (const pg of S.pages) {
    busy(t('scanning', { n: pg.index + 1, total: S.pages.length }));
    try { found.push(...await detectFlatFields(pg, S.segsByPage[pg.index] || [], avoid(pg.index))); }
    catch (e) { console.warn('scan failed on page', pg.index, e); }
  }
  return finishFlatFields(found, existing.length);
}

async function scanMore() {
  checkpoint();
  const more = await scanFlat(S.fields);
  busy(false);
  if (!more.length) { toast(t('noFieldsTitle')); return; }
  for (const f of more) S.values[f.id] = structuredClone(f.initial);
  S.fields = sortFields([...S.fields, ...more]);
  renderForm(); renderAllOverlays(); updateHeader(); updateEditBar();
  toast(t(more.length === 1 ? 'fieldsFound1' : 'fieldsFound', { n: more.length }));
}

function showFill() {
  $('#home').hidden = true;
  $('#fill').hidden = false;
  document.body.classList.add('app-mode');
  if (history.state?.view !== 'fill') history.pushState({ view: 'fill' }, '');
  scrollTo(0, 0);
  $('#notices').innerHTML = '';
  if (S.isFlat && S.fields.length) addNotice(t('flatNotice'), 'info', true);
  $('#scanMoreBtn').hidden = S.isFlat;
  buildPages();
  setTab('pdf');
  updateHeader();
  updateEditBar();
}

function goHome(fromPop) {
  closeEditor();
  saveDraftNow();
  $('#fill').hidden = true;
  $('#home').hidden = false;
  document.body.classList.remove('app-mode', 'kb');
  S.loaded = false;
  setAddMode(null);
  if (!fromPop && history.state?.view === 'fill') history.back();
  scrollTo(0, 0);
}

function addNotice(text, kind, dismissible, actions) {
  const n = el('div', { class: 'notice ' + kind }, el('div', { class: 'grow' }, text, actions || null),
    dismissible ? el('button', { class: 'mini-btn x', type: 'button', 'aria-label': t('close'), onclick: () => n.remove() }, svgIcon('<path d="M6 6l12 12M18 6L6 18"/>')) : null);
  $('#notices').append(n);
  return n;
}

function setTab(tab) {
  S.tab = tab;
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('#pdfView').hidden = tab !== 'pdf';
  $('#listView').hidden = tab !== 'list';
  if (tab === 'list') { closeEditor(); renderForm(); }
  else { renderAllOverlays(); layoutPages(); }
}

function updateHeader() {
  $('#docName').textContent = S.fileName;
  const total = S.fields.length;
  const filled = S.fields.filter((f) => hasValue(f, S.values[f.id])).length;
  $('#docCount').textContent = t(total === 1 ? 'fieldsFound1' : 'fieldsFound', { n: total }) + ' · ' + t(S.pages.length === 1 ? 'pagesN1' : 'pagesN', { n: S.pages.length });
  $('#docProgressText').textContent = t('filledOf', { a: filled, b: total });
  $('#progressBar').style.width = total ? (filled / total) * 100 + '%' : '0';
}

// ------------------------------------------------------------------ pages (continuous, zoomable)
let io = null;
function buildPages() {
  const box = $('#pagesBox');
  box.innerHTML = '';
  S.pageEls = [];
  io?.disconnect();
  io = new IntersectionObserver((entries) => {
    for (const e of entries) { const pe = S.pageEls[+e.target.dataset.page]; if (pe) pe.visible = e.isIntersecting; }
    scheduleRender();
  }, { root: $('#stage'), rootMargin: '700px 0px' });
  for (const pg of S.pages) {
    const wrap = el('div', { class: 'page-wrap', dataset: { page: pg.index } });
    const overlay = el('div', { class: 'overlay', dataset: { page: pg.index } });
    const canvas = el('canvas');
    wrap.append(canvas, overlay);
    if (S.pages.length > 1) wrap.append(el('div', { class: 'page-num', text: t('pageOf', { a: pg.index + 1, b: S.pages.length }) }));
    box.append(wrap);
    const pe = { index: pg.index, wrap, canvas, overlay, scale: 0, k: 1, visible: pg.index < 2 };
    S.pageEls.push(pe);
    io.observe(wrap);
  }
  $('#stage').scrollTo(0, 0);
  layoutPages();
}

function fitWidth() {
  const sw = $('#stage').clientWidth || innerWidth;
  return Math.max(240, Math.min(sw - 24, 920));
}
function layoutPages(keepEditor) {
  if (!S.pageEls.length) return;
  const maxW = Math.max(...S.pages.map((p) => p.viewport.width));
  const base = fitWidth();
  for (const pe of S.pageEls) {
    const vp = S.pages[pe.index].viewport;
    const w = base * S.zoom * (vp.width / maxW);
    pe.k = w / vp.width;
    pe.wrap.style.width = w + 'px';
    pe.wrap.style.height = (w * vp.height) / vp.width + 'px';
    pe.overlay.style.setProperty('--k', String(pe.k));
  }
  $('#zoomLabel').textContent = Math.round(S.zoom * 100) + '%';
  scheduleRender();
  if (keepEditor && S.editor) ensureVisible(fieldById(S.currentId), false);
}

function setZoom(z, anchor) {
  const stage = $('#stage');
  z = Math.max(0.5, Math.min(5, z));
  if (Math.abs(z - S.zoom) < 0.001) return;
  const sr = stage.getBoundingClientRect();
  const ax = anchor ? anchor.x - sr.left : sr.width / 2;
  const ay = anchor ? anchor.y - sr.top : sr.height / 2;
  const cx = stage.scrollLeft + ax, cy = stage.scrollTop + ay;
  const ratio = z / S.zoom;
  S.zoom = z;
  layoutPages();
  stage.scrollLeft = cx * ratio - ax;
  stage.scrollTop = cy * ratio - ay;
}

let renderTimer = null, rendering = false, renderAgain = false;
function scheduleRender() { clearTimeout(renderTimer); renderTimer = setTimeout(runRender, 90); }
async function runRender() {
  if (rendering) { renderAgain = true; return; }
  rendering = true;
  try {
    const dpr = Math.min(3, devicePixelRatio || 1);
    const stage = $('#stage');
    const mid = stage.scrollTop + stage.clientHeight / 2;
    const order = S.pageEls.filter((p) => p.visible).sort((a, b) => Math.abs(a.wrap.offsetTop - mid) - Math.abs(b.wrap.offsetTop - mid));
    for (const pe of order) {
      const vp = S.pages[pe.index].viewport;
      const maxScale = Math.sqrt(16e6 / (vp.width * vp.height));
      const want = Math.min(maxScale, pe.k * dpr);
      if (pe.scale && Math.abs(pe.scale - want) / want < 0.12) continue;
      await renderPage(pe, want);
    }
    // free memory of pages far away
    const rendered = S.pageEls.filter((p) => p.scale && !p.visible);
    if (S.pageEls.filter((p) => p.scale).length > 6) for (const pe of rendered) { pe.canvas.width = 0; pe.canvas.height = 0; pe.scale = 0; }
  } finally {
    rendering = false;
    if (renderAgain) { renderAgain = false; scheduleRender(); }
  }
}
async function renderPage(pe, scale) {
  const pg = S.pages[pe.index];
  const vp = pg.page.getViewport({ scale });
  const c = document.createElement('canvas');
  c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  try {
    await pg.page.render({ canvasContext: ctx, canvas: c, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
  } catch (e) { console.warn('render failed', e); return; }
  pe.canvas.replaceWith(c);
  pe.canvas = c;
  pe.scale = scale;
}

// ------------------------------------------------------------------ boxes on the pages
function boxesOf(f) {
  if (f.source === 'merge' && f.mode === 'spread') return f.parts.map((p, i) => ({ r: fieldRect(p), p: f.page, i }));
  if (f.type === 'radio') return f.options.map((o, i) => ({ r: o.widget.rect, p: o.widget.page, opt: o.value, i }));
  if (f.widgets.length) return f.widgets.map((w, i) => ({ r: w.rect, p: w.page, i }));
  return [{ r: f.rect, p: f.page, i: 0 }];
}
function renderAllOverlays() {
  for (const pe of S.pageEls) pe.overlay.innerHTML = '';
  for (const f of S.fields) for (const b of boxesOf(f)) addBox(f, b);
  renderMarks();
  highlightCurrent();
}
function addBox(f, b) {
  const pe = S.pageEls[b.p];
  if (!pe) return;
  const vp = S.pages[b.p].viewport;
  const node = el('div', { class: `ov ${f.source === 'flat' ? 'flat' : ''} ${f.source === 'merge' ? 'merged' : ''} ${S.selected.has(f.id) ? 'selected' : ''} ${f.type === 'multiline' ? 'multi' : ''} ${f.type === 'checkbox' || f.type === 'radio' ? 'check' : ''}`, dataset: { id: f.id, opt: b.opt ?? '', bi: b.i }, title: f.label });
  place(node, b.r, vp);
  if (f.source === 'flat') node.append(el('div', { class: 'grip' }, svgIcon(ICONS.move)), el('div', { class: 'handle' }));
  pe.overlay.append(node);
  paintBox(node, f, b.r);
}
function place(node, r, vp) {
  Object.assign(node.style, { left: (r.x / vp.width) * 100 + '%', top: (r.y / vp.height) * 100 + '%', width: (r.w / vp.width) * 100 + '%', height: (r.h / vp.height) * 100 + '%' });
}
function paintBox(node, f, r) {
  const v = S.values[f.id];
  node.classList.toggle('filled', hasValue(f, v));
  [...node.childNodes].forEach((c) => { if (!c.classList || !(c.classList.contains('handle') || c.classList.contains('grip'))) c.remove(); });
  node.style.fontSize = `calc(var(--k) * ${fontPt(f, r)}px)`;
  node.style.padding = '0 calc(var(--k) * 2px)';
  let content = '';
  if (f.type === 'checkbox') content = v ? '✔' : '';
  else if (f.type === 'radio') content = v != null && v !== '' && v === node.dataset.opt ? '●' : '';
  else if (v && typeof v === 'object' && v.sig) content = el('img', { src: v.sig, alt: '' });
  else if (v && typeof v === 'object' && 'text' in v) content = v.text;
  else if (Array.isArray(v)) content = v.map((x) => displayOf(f, x)).join(', ');
  else if (f.type === 'select' || f.type === 'list') content = displayOf(f, v);
  else if (f.isDate && v) content = formatDate(v, f.dateFormat);
  else if (f.source === 'merge' && f.mode === 'spread') { content = [...(v || '')][+node.dataset.bi] || ''; node.style.justifyContent = 'center'; }
  else content = v || '';
  if (f.type === 'checkbox' || f.type === 'radio') node.style.fontSize = `calc(var(--k) * ${Math.min(r.w, r.h) * 0.85}px)`;
  if (content) node.prepend(content.nodeType ? content : document.createTextNode(content));
}
function repaint(f) {
  $$(`.ov[data-id="${CSS.escape(f.id)}"]`).forEach((node) => {
    const b = boxesOf(f)[+node.dataset.bi];
    if (b) paintBox(node, f, b.r);
  });
}
function highlightCurrent() {
  $$('.ov').forEach((n) => n.classList.toggle('current', n.dataset.id === S.currentId));
}

// ------------------------------------------------------------------ editing in place
// ------------------------------------------------------------------ undo / redo
// Snapshots of everything the user can change. Typing in one box is grouped into one step.
const H = { undo: [], redo: [], key: null, time: 0, batch: 0 };
function snapshot() {
  return {
    fields: S.fields.map((f) => ({ ref: f, rect: f.rect ? { ...f.rect } : f.rect, label: f.label, mode: f.mode, maxLen: f.maxLen, sigTyped: f.sigTyped, numPad: f.numPad })),
    values: structuredClone(S.values),
    marks: structuredClone(S.marks),
    customCount: S.customCount,
  };
}
function checkpoint(key = null) {
  if (H.batch || !S.loaded) return;
  const now = Date.now();
  if (key && key === H.key && now - H.time < 1500) { H.time = now; return; }
  H.undo.push(snapshot());
  if (H.undo.length > 150) H.undo.shift();
  H.redo = [];
  H.key = key; H.time = now;
  updateUndoButtons();
}
function batch(fn) { checkpoint(); H.batch++; try { return fn(); } finally { H.batch--; } }
function applySnapshot(sn) {
  closeEditor();
  document.activeElement?.blur();
  S.fields = sn.fields.map((x) => Object.assign(x.ref, { rect: x.rect, label: x.label, mode: x.mode, maxLen: x.maxLen, sigTyped: x.sigTyped, numPad: x.numPad }));
  S.values = structuredClone(sn.values);
  S.marks = structuredClone(sn.marks);
  S.customCount = sn.customCount;
  S.selMark = null;
  if (!fieldById(S.currentId)) S.currentId = null;
  renderAllOverlays(); updateHeader(); updateEditBar(); updateTypeHere();
  if (S.tab === 'list') renderForm();
  scheduleDraft();
}
function undo() {
  if (!H.undo.length) return;
  H.redo.push(snapshot());
  applySnapshot(H.undo.pop());
  H.key = null;
  updateUndoButtons();
}
function redo() {
  if (!H.redo.length) return;
  H.undo.push(snapshot());
  applySnapshot(H.redo.pop());
  H.key = null;
  updateUndoButtons();
}
function resetHistory() { H.undo = []; H.redo = []; H.key = null; updateUndoButtons(); }
function updateUndoButtons() {
  $('#undoBtn').disabled = !H.undo.length;
  $('#redoBtn').disabled = !H.redo.length;
  const mu = $('#markUndo'); if (mu) mu.disabled = !H.undo.length;
}

function setValue(f, v) {
  checkpoint(typeof v === 'string' && isTyped(f) ? 'v:' + f.id : (v && typeof v === 'object' && 'text' in v ? 'v:' + f.id : null));
  S.values[f.id] = v;
  repaint(f);
  updateHeader();
  scheduleDraft();
  if (S.tab === 'list') refreshFilledState(f);
}

function closeEditor() {
  const ed = S.editor;
  if (!ed) return;
  S.editor = null;
  ed.remove();
  const f = fieldById(ed.dataset.id);
  if (f) repaint(f);
  detectKeyboard();
}

/**
 * Makes a field the current one. For text boxes an input is placed exactly over the box
 * and focused (this must happen synchronously inside the tap, or phones won't show the keyboard).
 */
function activate(f, how = {}) {
  if (!f) return;
  const prev = S.editor;
  S.currentId = f.id;
  highlightCurrent();
  let focused = null;
  if (isTyped(f)) {
    focused = makeEditor(f);
    focused.focus({ preventScroll: true });
    if (f.isDate && how.tap) { try { focused.showPicker(); } catch {} }
  } else if (document.activeElement && document.activeElement !== document.body) {
    document.activeElement.blur(); // hide the keyboard for tick boxes, choices etc.
  }
  if (prev && prev !== focused) { prev.remove(); const pf = fieldById(prev.dataset.id); if (pf) repaint(pf); }
  if (!focused) S.editor = null;

  if (how.tap) {
    if (f.type === 'checkbox') setValue(f, !S.values[f.id]);
    else if (f.type === 'radio' && how.opt != null) setValue(f, S.values[f.id] === how.opt ? '' : how.opt);
    else if (f.signature && !f.sigTyped) openSignature(f);
  }
  updateEditBar();
  if (how.tap && f.type === 'select') { const sel = $('#ebSlot select'); if (sel) { sel.focus(); try { sel.showPicker(); } catch {} } }
  if (focused) autoZoom(f);
  requestAnimationFrame(() => ensureVisible(f, !how.tap));
}

function makeEditor(f) {
  const pe = S.pageEls[fieldPage(f)];
  const vp = S.pages[fieldPage(f)].viewport;
  const r = fieldRect(f);
  const v = S.values[f.id];
  const text = v && typeof v === 'object' ? (v.text || '') : (v || '');
  let ed;
  if (f.type === 'multiline') ed = el('textarea', { class: 'ov-editor', spellcheck: 'true' });
  else if (f.isDate) ed = el('input', { class: 'ov-editor', type: 'date' });
  else ed = el('input', { class: 'ov-editor', type: f.inputType === 'email' ? 'email' : 'text', autocomplete: f.autocomplete || 'off', inputmode: keyboardFor(f), enterkeyhint: 'next', spellcheck: f.autocomplete ? 'false' : null, maxlength: f.maxLen || null });
  if (f.type !== 'multiline' && f.maxLen) ed.maxLength = f.maxLen;
  ed.value = text;
  ed.dataset.id = f.id;
  ed.setAttribute('aria-label', f.label);
  place(ed, r, vp);
  ed.style.fontSize = `calc(var(--k) * ${fontPt(f, r)}px)`;
  if (f.source === 'merge' && f.mode === 'spread') {
    ed.classList.add('spread');
    ed.maxLength = f.parts.length;
    ed.setAttribute('autocapitalize', 'characters');
    const cursor = () => $$(`.ov[data-id="${CSS.escape(f.id)}"]`).forEach((n) => n.classList.toggle('cursor', +n.dataset.bi === Math.min([...ed.value].length, f.parts.length - 1)));
    ed.addEventListener('input', cursor);
    ed.addEventListener('focus', cursor);
    ed.addEventListener('blur', () => $$('.ov.cursor').forEach((n) => n.classList.remove('cursor')));
    requestAnimationFrame(cursor);
  }
  ed.addEventListener('input', () => setValue(f, f.signature ? { text: ed.value } : ed.value));
  ed.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && f.type !== 'multiline') { e.preventDefault(); step(1); }
    if (e.key === 'Tab') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') { ed.blur(); }
  });
  ed.addEventListener('focus', detectKeyboard);
  ed.addEventListener('blur', () => setTimeout(detectKeyboard, 50));
  // suggestions from earlier answers
  const sugg = (store.get('ff:memory', {})[normLabel(f.label)] || []).filter(Boolean);
  if (sugg.length && !f.isDate) {
    const dl = el('datalist', { id: 'dl-ed' }, sugg.map((s) => el('option', { value: s })));
    $('#dl-ed')?.remove();
    document.body.append(dl);
    ed.setAttribute('list', 'dl-ed');
  }
  pe.overlay.append(ed);
  S.editor = ed;
  // hide the box's own preview text underneath
  if (!(f.source === 'merge' && f.mode === 'spread')) $$(`.ov[data-id="${CSS.escape(f.id)}"]`).forEach((n) => { [...n.childNodes].forEach((c) => { if (c.nodeType === 3 || c.tagName === 'IMG') c.remove(); }); });
  return ed;
}

function step(dir) {
  if (!S.fields.length) return;
  const i = S.fields.findIndex((f) => f.id === S.currentId);
  let j = i < 0 ? (dir > 0 ? 0 : S.fields.length - 1) : i + dir;
  if (j >= S.fields.length) { closeEditor(); document.activeElement?.blur(); toast(t('lastField')); openSave(); return; }
  if (j < 0) return;
  activate(S.fields[j], { nav: true });
}

function autoZoom(f) {
  if (!isTouch() && !isNarrow()) return;
  const pe = S.pageEls[fieldPage(f)];
  const px = pe.k * fontPt(f);
  const target = 15; // readable text size while typing (CSS px)
  if (px < target * 0.92) {
    const z = Math.min(5, S.zoom * (target / px));
    const node = $(`.ov[data-id="${CSS.escape(f.id)}"]`);
    const r = node?.getBoundingClientRect();
    setZoom(z, r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null);
  }
}

function ensureVisible(f, smooth = true) {
  if (!f) return;
  const node = $(`.ov[data-id="${CSS.escape(f.id)}"]`);
  const stage = $('#stage');
  if (!node) return;
  const sr = stage.getBoundingClientRect();
  const br = node.getBoundingClientRect();
  const margin = 14;
  let dx = 0, dy = 0;
  if (br.top < sr.top + margin || br.bottom > sr.bottom - margin) {
    const wantTop = S.editor ? Math.min(sr.height * 0.3, Math.max(margin, sr.height - br.height - margin)) : (sr.height - br.height) / 2;
    dy = br.top - sr.top - wantTop;
  }
  if (br.left < sr.left + margin || br.right > sr.right - margin) {
    // leave room on the left for the printed label next to the box
    const wantLeft = br.width + 2 * margin < sr.width ? Math.max(margin, Math.min(sr.width * 0.32, sr.width - br.width - margin)) : margin;
    dx = br.left - sr.left - wantLeft;
  }
  if (dx || dy) stage.scrollBy({ left: dx, top: dy, behavior: smooth ? 'smooth' : 'auto' });
}

function updateEditBar() {
  const label = $('#ebLabel'), count = $('#ebCount'), slot = $('#ebSlot');
  slot.innerHTML = '';
  const n = S.fields.length;
  const i = S.fields.findIndex((f) => f.id === S.currentId);
  const f = S.fields[i];
  $('#prevBtn').disabled = i <= 0;
  $('#nextBtn').disabled = !n;
  $('#nextBtn').replaceChildren(svgIcon(i === n - 1 ? ICONS.save : ICONS.next));
  $('#nextBtn').setAttribute('aria-label', i === n - 1 ? t('savePdf') : t('nextField'));
  if (!n) { label.textContent = t('noFieldsBar'); count.textContent = ''; return; }
  if (!f) { label.textContent = t('tapBox'); count.textContent = `${n}`; return; }
  label.replaceChildren(document.createTextNode(f.context && f.type === 'checkbox' ? `${f.context}: ${f.label}` : f.label), f.required ? el('span', { class: 'req', text: '*' }) : '');
  count.textContent = `${i + 1}/${n}`;
  const chip = (text, on, onclick, extra = {}) => el('button', { class: 'chip' + (on ? ' on' : ''), type: 'button', text, onclick, ...extra });
  const keep = { onpointerdown: (e) => e.preventDefault() };

  if (f.type === 'checkbox') {
    const on = !!S.values[f.id];
    slot.append(chip(on ? '✔ ' + t('ticked') : t('tick'), on, () => { setValue(f, !S.values[f.id]); updateEditBar(); }));
  } else if (f.type === 'radio') {
    for (const o of f.options) slot.append(chip(o.label || o.value, S.values[f.id] === o.value, () => { setValue(f, S.values[f.id] === o.value ? '' : o.value); updateEditBar(); }));
  } else if (f.type === 'select' || (f.type === 'list' && !f.multiSelect)) {
    const sel = el('select', { 'aria-label': f.label, onchange: (e) => setValue(f, e.target.value) },
      el('option', { value: '', text: t('choosePlaceholder') }), f.options.map((o) => el('option', { value: o.value, text: o.label })));
    const v = S.values[f.id];
    sel.value = Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
    if (sel.value !== (Array.isArray(v) ? (v[0] ?? '') : (v ?? '')) && f.editable && v) sel.prepend(el('option', { value: v, text: v, selected: true }));
    slot.append(sel);
  } else if (f.type === 'list') {
    const cur = new Set(Array.isArray(S.values[f.id]) ? S.values[f.id] : []);
    for (const o of f.options) slot.append(chip(o.label, cur.has(o.value), () => { cur.has(o.value) ? cur.delete(o.value) : cur.add(o.value); setValue(f, [...cur]); updateEditBar(); }));
  } else if (f.signature) {
    const v = S.values[f.id];
    slot.append(chip('✍ ' + t('signBtn'), !!(v && v.sig), () => { f.sigTyped = false; openSignature(f); }));
    if (f.type !== 'signature') slot.append(chip(t('typeBtn'), !!f.sigTyped, () => { f.sigTyped = true; if (v && v.sig) setValue(f, { text: '' }); activate(f, { nav: true }); }, keep));
    if (hasValue(f, v)) slot.append(chip(t('clear'), false, () => { setValue(f, ''); closeEditor(); f.sigTyped = false; updateEditBar(); }));
  } else if (f.dateChip && !f.isDate) {
    slot.append(chip(t('today'), false, () => {
      const s = formatDate(new Date().toISOString().slice(0, 10), getLang() === 'nb' ? 'dd.mm.yyyy' : 'mm/dd/yyyy');
      setValue(f, s); if (S.editor) S.editor.value = s;
    }, keep));
  }
  if (isTyped(f) && !f.isDate) {
    const kb = el('button', { class: 'chip kbd-chip', type: 'button', title: t('switchKeyboard'), 'aria-label': t('switchKeyboard'), text: useNumPad(f) ? 'ABC' : '123', onpointerdown: (e) => e.preventDefault(), onclick: () => toggleKeyboard(f) });
    slot.prepend(kb);
  }
  if (f.source === 'merge') {
    slot.append(chip(t('perBox'), f.mode === 'spread', () => setMergeMode(f, 'spread'), keep), chip(t('oneText'), f.mode === 'span', () => setMergeMode(f, 'span'), keep), chip(t('split'), false, () => splitMerged(f)));
  }
  if (f.source === 'flat') slot.append(el('button', { class: 'mini-btn', type: 'button', title: t('removeField'), 'aria-label': t('removeField'), onpointerdown: (e) => e.preventDefault(), onclick: () => removeField(f) }, svgIcon(ICONS.trash)));
}

function removeField(f) {
  checkpoint();
  const i = S.fields.indexOf(f);
  if (S.currentId === f.id) closeEditor();
  S.fields = S.fields.filter((x) => x !== f);
  delete S.values[f.id];
  $$(`.ov[data-id="${CSS.escape(f.id)}"]`).forEach((n) => n.remove());
  S.currentId = null;
  const next = S.fields[Math.min(i, S.fields.length - 1)];
  if (S.tab === 'list') renderForm();
  updateHeader(); scheduleDraft();
  if (next && S.tab === 'pdf') { S.currentId = next.id; highlightCurrent(); }
  updateEditBar();
}

// taps, drags and pinch-zoom on the pages
function setupStage() {
  const stage = $('#stage');
  const ptOn = (pe, e) => {
    const r = pe.overlay.getBoundingClientRect();
    const vp = S.pages[pe.index].viewport;
    return { x: ((e.clientX - r.left) / r.width) * vp.width, y: ((e.clientY - r.top) / r.height) * vp.height };
  };
  // tap a box -> edit it
  stage.addEventListener('click', (e) => {
    if (S.marking) return;
    if (e.target.closest('.ov-editor, .grip, .handle')) return;
    const ov = e.target.closest('.overlay');
    if (!ov) return;
    const pe = S.pageEls[+ov.dataset.page];
    if (S.addMode) { addFieldAt(pe, ptOn(pe, e)); return; }
    const node = e.target.closest('.ov');
    if (S.selecting) { if (node) toggleSelect(fieldById(node.dataset.id)); return; }
    if (!node) { if (S.editor) { closeEditor(); document.activeElement?.blur(); } return; }
    const f = fieldById(node.dataset.id);
    activate(f, { tap: true, opt: node.dataset.opt || null });
  });
  // whiteout / strike-out: tap a word or drag an area
  let mk = null, fingers = 0;
  cancelGesture = () => { if (mk) { mk.draft.remove(); mk = null; } hideLoupe(); };
  stage.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') fingers++; }, true);
  const lift = (e) => { if (e.pointerType === 'touch') fingers = Math.max(0, fingers - 1); };
  stage.addEventListener('pointerup', lift, true);
  stage.addEventListener('pointercancel', lift, true);
  stage.addEventListener('pointerdown', (e) => {
    if (!S.marking) return;
    if (fingers > 1) { cancelGesture(); return; }
    const ov = e.target.closest('.overlay');
    if (!ov) return;
    const pe = S.pageEls[+ov.dataset.page];
    e.preventDefault();
    if (S.pipette) { ov.setPointerCapture(e.pointerId); mk = { pipette: true, pe, id: e.pointerId, draft: { remove() {} } }; showLoupe(pe, e); return; }
    ov.setPointerCapture(e.pointerId);
    const p = ptOn(pe, e);
    const none = { remove() {} };
    // editing an existing mark: corner handle resizes, dragging the selected mark moves it
    if (e.target.closest('.mk-del')) { mk = null; deleteMark(S.selMark); return; }
    if (e.target.closest('.mk-handle') && S.selMark) { mk = { edit: 'resize', mark: S.selMark, pe, p0: p, p1: p, rect: { ...S.selMark.rect }, draft: none, id: e.pointerId }; return; }
    const hit = markAt(pe.index, p);
    if (hit && hit === S.selMark) { mk = { edit: 'move', mark: hit, pe, p0: p, p1: p, rect: { ...hit.rect }, draft: none, id: e.pointerId }; return; }
    const draft = el('div', { class: 'mk-draft' });
    pe.overlay.append(draft);
    mk = { pe, p0: p, p1: p, draft, id: e.pointerId, hit };
  });
  stage.addEventListener('pointermove', (e) => {
    if (!mk || mk.id !== e.pointerId) return;
    if (fingers > 1) { cancelGesture(); return; }
    if (mk.pipette) { showLoupe(mk.pe, e); return; }
    mk.p1 = ptOn(mk.pe, e);
    const vp = S.pages[mk.pe.index].viewport;
    if (mk.edit) {
      if (!mk.moved) { mk.moved = true; checkpoint(); }
      const dx = mk.p1.x - mk.p0.x, dy = mk.p1.y - mk.p0.y, r = mk.mark.rect;
      if (mk.edit === 'move') { r.x = Math.max(-r.w / 2, Math.min(vp.width - r.w / 2, mk.rect.x + dx)); r.y = Math.max(-r.h / 2, Math.min(vp.height - r.h / 2, mk.rect.y + dy)); }
      else { r.w = Math.max(3, mk.rect.w + dx); r.h = Math.max(2, mk.rect.h + dy); }
      renderMarks();
      return;
    }
    place(mk.draft, normRect(mk.p0, mk.p1), vp);
  });
  const endMark = (e) => {
    if (!mk || (e && mk.id !== e.pointerId)) return;
    const m = mk; mk = null;
    m.draft.remove();
    if (e && e.type === 'pointercancel') { hideLoupe(); return; }
    if (m.pipette) {
      const c = sampleColor(m.pe, e);
      hideLoupe();
      if (c) { setCoverColor(c); S.pipette = false; updateCoverUi(); toast(t('colorPicked')); }
      return;
    }
    if (m.edit) { markEdited(m.mark); return; }
    const r = normRect(m.p0, m.p1);
    const page = m.pe.index;
    if (r.w < 4 && r.h < 4) {
      // tap on a mark selects it (tap empty space to deselect)
      if (m.hit) { S.selMark = m.hit; renderMarks(); return; }
      if (S.selMark) { S.selMark = null; renderMarks(); return; }
      markTap(page, m.p1);
    } else { S.selMark = null; markArea(page, r); }
  };
  stage.addEventListener('pointerup', endMark);
  stage.addEventListener('pointercancel', endMark);

  // move / resize detected boxes with their handles
  let drag = null;
  stage.addEventListener('pointerdown', (e) => {
    const h = e.target.closest('.grip, .handle');
    if (!h) return;
    const node = h.closest('.ov');
    const f = fieldById(node.dataset.id);
    const pe = S.pageEls[f.page];
    e.preventDefault();
    h.setPointerCapture(e.pointerId);
    checkpoint();
    drag = { f, node, pe, start: ptOn(pe, e), rect: { ...f.rect }, resize: h.classList.contains('handle'), id: e.pointerId };
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    const p = ptOn(drag.pe, e);
    const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
    const vp = S.pages[drag.pe.index].viewport;
    const r = drag.f.rect;
    if (drag.resize) { r.w = Math.max(8, drag.rect.w + dx); r.h = Math.max(6, drag.rect.h + dy); }
    else { r.x = Math.min(vp.width - 4, Math.max(0, drag.rect.x + dx)); r.y = Math.min(vp.height - 4, Math.max(0, drag.rect.y + dy)); }
    place(drag.node, r, vp);
    if (S.editor && S.editor.dataset.id === drag.f.id) { place(S.editor, r, vp); S.editor.style.fontSize = `calc(var(--k) * ${fontPt(drag.f, r)}px)`; }
    else paintBox(drag.node, drag.f, r);
  });
  const endDrag = () => { if (drag) { drag = null; scheduleDraft(); } };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);

  // two-finger pinch zoom
  // two fingers: pinch to zoom and move to pan — works in every mode
  let pinch = null;
  const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  const mid = (a, b) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });
  stage.addEventListener('touchstart', (e) => {
    if (e.touches.length >= 2) {
      cancelGesture();
      const [a, b] = e.touches;
      pinch = { d: dist(a, b), z: S.zoom, m: mid(a, b) };
    }
  }, { passive: true });
  stage.addEventListener('touchmove', (e) => {
    if (!pinch || e.touches.length < 2) return;
    e.preventDefault();
    const [a, b] = e.touches;
    const m = mid(a, b);
    setZoom(pinch.z * (dist(a, b) / pinch.d), m);
    stage.scrollBy(pinch.m.x - m.x, pinch.m.y - m.y);
    pinch.m = m;
  }, { passive: false });
  stage.addEventListener('touchend', (e) => { if (e.touches.length < 2) pinch = null; });
  // ctrl/⌘ + wheel zoom on desktop
  stage.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setZoom(S.zoom * Math.exp(-e.deltaY / 300), { x: e.clientX, y: e.clientY });
  }, { passive: false });
  stage.addEventListener('scroll', () => scheduleRender(), { passive: true });
}

function addFieldAt(pe, p) {
  checkpoint();
  const vp = S.pages[pe.index].viewport;
  S.customCount++;
  const isCheck = S.addMode === 'checkbox';
  const rect = isCheck ? { x: p.x - 6, y: p.y - 6, w: 12, h: 12 } : { x: p.x - 3, y: p.y - 9, w: Math.max(40, Math.min(200, vp.width - p.x - 10)), h: 17 };
  const f = finishFlatFields([{ type: isCheck ? 'checkbox' : 'text', rect, page: pe.index, label: t('addedField', { n: S.customCount }) }])[0];
  f.custom = true;
  S.fields.push(f);
  sortFields(S.fields);
  S.values[f.id] = isCheck ? true : '';
  setAddMode(null);
  for (const b of boxesOf(f)) addBox(f, b);
  updateHeader(); scheduleDraft();
  activate(f, {});
}

function setAddMode(mode) {
  S.addMode = mode;
  $('#addMode').hidden = !mode;
  $('#addBtn').classList.toggle('on', !!mode);
  $$('[data-add]').forEach((b) => b.classList.toggle('active', b.dataset.add === mode));
  $$('.overlay').forEach((o) => o.classList.toggle('adding', !!mode));
  if (mode) closeEditor();
}

// ------------------------------------------------------------------ keyboard choice
// Regular keyboard by default; the 123/ABC button switches. If you switch a number box,
// that choice is remembered for number boxes from then on.
const isNumberish = (f) => f.inputmode === 'numeric' || f.inputmode === 'tel';
function useNumPad(f) {
  if (f.numPad != null) return f.numPad;
  return isNumberish(f) && store.get('ff:numpad', false) === true;
}
function keyboardFor(f) {
  if (useNumPad(f)) return f.inputmode === 'tel' ? 'tel' : 'numeric';
  return f.inputType === 'email' ? 'email' : 'text';
}
function toggleKeyboard(f) {
  f.numPad = !useNumPad(f);
  if (isNumberish(f)) store.set('ff:numpad', f.numPad);
  const ed = S.editor;
  if (ed && ed.dataset.id === f.id) {
    ed.setAttribute('inputmode', keyboardFor(f));
    // the phone only swaps keyboards when the box is focused again
    ed.blur();
    ed.focus({ preventScroll: true });
  }
  updateEditBar();
}

let cancelGesture = () => {};

// ------------------------------------------------------------------ pipette (pick a colour from the page)
function sampleColor(pe, e) {
  const c = pe.canvas;
  if (!c || !c.width || !pe.scale) return null;
  const r = pe.overlay.getBoundingClientRect();
  const vp = S.pages[pe.index].viewport;
  const px = Math.round(((e.clientX - r.left) / r.width) * vp.width * pe.scale);
  const py = Math.round(((e.clientY - r.top) / r.height) * vp.height * pe.scale);
  const x0 = Math.max(0, Math.min(c.width - 3, px - 1)), y0 = Math.max(0, Math.min(c.height - 3, py - 1));
  const d = c.getContext('2d', { willReadFrequently: true }).getImageData(x0, y0, 3, 3).data;
  let R = 0, G = 0, B = 0;
  for (let i = 0; i < d.length; i += 4) { R += d[i]; G += d[i + 1]; B += d[i + 2]; }
  const hx = (v) => Math.round(v / 9).toString(16).padStart(2, '0');
  return '#' + hx(R) + hx(G) + hx(B);
}
function showLoupe(pe, e) {
  let l = $('#loupe');
  if (!l) { l = el('div', { id: 'loupe', class: 'loupe' }, el('span')); document.body.append(l); }
  const c = sampleColor(pe, e) || '#ffffff';
  l.style.background = c;
  l.firstChild.textContent = c.toUpperCase();
  l.style.left = e.clientX + 'px';
  l.style.top = e.clientY + 'px';
  l.hidden = false;
}
function hideLoupe() { const l = $('#loupe'); if (l) l.hidden = true; }
function setPipette(on) {
  S.pipette = on;
  updateCoverUi();
  if (on) toast(t('pipetteHint'));
}

// ------------------------------------------------------------------ erase (strike out, scribble, hatch, blur, cover)
const normRect = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });
let warnedErase = false;
function maybeWarnErase() {
  if (!warnedErase && ['cover', 'blur', 'scribble', 'hatch'].includes(S.markStyle)) { warnedErase = true; toast(t('whiteoutNote'), '', 6500); }
}
function markAt(page, p) {
  let hit = null;
  for (const m of S.marks) if (m.page === page && p.x >= m.rect.x - 3 && p.x <= m.rect.x + m.rect.w + 3 && p.y >= m.rect.y - 3 && p.y <= m.rect.y + m.rect.h + 3) hit = m; // topmost
  return hit;
}
function deleteMark(m) {
  if (!m) return;
  checkpoint();
  S.marks = S.marks.filter((x) => x !== m);
  if (S.selMark === m) S.selMark = null;
  renderMarks(); scheduleDraft(); updateTypeHere();
}
function markEdited(m) {
  // follow the new spot: background colour (if automatic) and anything added on top that it now covers
  if (m.kind === 'cover' && m.autoColor) m.color = backgroundAround(m.page, m.rect);
  m.annots = annotsIn(m.page, m.rect).map((a) => a.id);
  renderMarks(); scheduleDraft();
}
function updateTypeHere() { const b = $('#markType'); if (b) b.disabled = !S.marks.length; }
function typeOverLastMark() {
  const m = S.marks[S.marks.length - 1];
  if (!m) return;
  checkpoint();
  setMarkMode(false);
  S.customCount++;
  const rect = { x: m.rect.x, y: m.rect.y, w: Math.max(m.rect.w, 30), h: Math.max(m.rect.h, 12) };
  const f = finishFlatFields([{ type: rect.h > 28 ? 'multiline' : 'text', rect, page: m.page, label: t('typedOver') }])[0];
  f.custom = true;
  S.fields.push(f);
  sortFields(S.fields);
  S.values[f.id] = '';
  for (const b of boxesOf(f)) addBox(f, b);
  updateHeader(); scheduleDraft();
  activate(f, {});
}
function setMarkMode(on) {
  S.marking = !!on;
  if (on) {
    closeEditor(); document.activeElement?.blur(); setAddMode(null);
    if (S.selecting) setSelectMode(false);
    $('#inkPop').hidden = true;
    maybeWarnErase();
  }
  if (!on) { S.pipette = false; hideLoupe(); S.selMark = null; renderMarks(); }
  $('#markMode').hidden = !on;
  updateTypeHere();
  $('#markBtn').classList.toggle('on', !!on);
  $$('.overlay').forEach((o) => o.classList.toggle('marking', !!on));
}
function textLinesIn(page, r) {
  return (S.segsByPage[page] || []).filter((s) => s.kind === 'text' && s.x2 > r.x && s.x1 < r.x + r.w && s.y2 > r.y && s.y1 < r.y + r.h);
}
const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
function annotsIn(page, r) { return S.annots.filter((a) => a.page === page && overlaps(a.rect, r)); }
// erase something another app added: strike styles get one line per text line, others cover it all
function markAnnot(a) {
  checkpoint(); H.batch++;
  try { markAnnotInner(a); } finally { H.batch--; }
}
function markAnnotInner(a) {
  if (S.markStyle.startsWith('strike')) {
    const lh = a.rect.h / a.lines;
    const lines = a.text ? a.text.split('\n') : [];
    for (let i = 0; i < a.lines; i++) {
      // stop the line where the text ends (the box is often wider than the text)
      const w = lines[i] ? Math.min(a.rect.w, textWidth(lines[i], lh * 0.8) + 4) : a.rect.w;
      if (lines.length && !lines[i]?.trim()) continue;
      addMark(a.page, { x: a.rect.x, y: a.rect.y + i * lh + lh * 0.12, w, h: lh * 0.8 }, true, [a.id]);
    }
    renderMarks(); scheduleDraft();
  } else addMark(a.page, a.rect, false, [a.id]);
}
function markTap(page, p) {
  const an = S.annots.find((a) => a.page === page && p.x >= a.rect.x - 2 && p.x <= a.rect.x + a.rect.w + 2 && p.y >= a.rect.y - 2 && p.y <= a.rect.y + a.rect.h + 2);
  if (an) { markAnnot(an); return; }
  const seg = (S.segsByPage[page] || []).find((s) => s.kind === 'text' && p.x >= s.x1 - 2 && p.x <= s.x2 + 2 && p.y >= s.y1 - 2 && p.y <= s.y2 + 2);
  if (!seg) { toast(t('markHint')); return; }
  const words = wordBoxes(seg);
  const w = words.find((b) => p.x >= b.x1 - 2 && p.x <= b.x2 + 2) || words.reduce((a, b) => (Math.abs((b.x1 + b.x2) / 2 - p.x) < Math.abs((a.x1 + a.x2) / 2 - p.x) ? b : a));
  addMark(page, { x: w.x1, y: w.y1, w: w.x2 - w.x1, h: w.y2 - w.y1 });
}
function markArea(page, r) {
  checkpoint(); H.batch++;
  try { markAreaInner(page, r); } finally { H.batch--; }
}
function markAreaInner(page, r) {
  const touched = annotsIn(page, r);
  if (S.markStyle.startsWith('strike') && touched.length && !textLinesIn(page, r).length) { touched.forEach(markAnnot); return; }
  // line styles follow the text lines inside the dragged area
  if (S.markStyle.startsWith('strike')) {
    const lines = textLinesIn(page, r);
    if (lines.length) {
      for (const s of lines) {
        const x1 = Math.max(s.x1, r.x), x2 = Math.min(s.x2, r.x + r.w);
        if (x2 - x1 > 1) addMark(page, { x: x1, y: s.y1, w: x2 - x1, h: s.y2 - s.y1 }, true);
      }
      renderMarks(); scheduleDraft();
      return;
    }
  }
  // other styles: grow the area so any words it touches are fully covered
  const lines = textLinesIn(page, r).filter((s) => Math.min(s.y2, r.y + r.h) - Math.max(s.y1, r.y) > (s.y2 - s.y1) * 0.2);
  let x1 = r.x, y1 = r.y, x2 = r.x + r.w, y2 = r.y + r.h;
  for (const a of touched) { x1 = Math.min(x1, a.rect.x); y1 = Math.min(y1, a.rect.y); x2 = Math.max(x2, a.rect.x + a.rect.w); y2 = Math.max(y2, a.rect.y + a.rect.h); }
  for (const s of lines) {
    for (const wb of wordBoxes(s)) {
      if (wb.x2 < r.x || wb.x1 > r.x + r.w) continue;
      x1 = Math.min(x1, wb.x1); x2 = Math.max(x2, wb.x2); y1 = Math.min(y1, s.y1); y2 = Math.max(y2, s.y2);
    }
  }
  addMark(page, { x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
}
function setCoverColor(c) {
  S.coverColor = c;
  store.set('ff:coverColor', c);
  updateCoverUi();
}
function updateCoverUi() {
  if (S.markStyle !== 'cover') S.pipette = false;
  $('#coverColors').hidden = S.markStyle !== 'cover';
  $('#pipetteBtn').classList.toggle('on', !!S.pipette);
  $$('.overlay').forEach((o) => o.classList.toggle('picking', !!S.pipette));
  const preset = $$('[data-cover]').some((b) => b.dataset.cover === S.coverColor);
  $$('[data-cover]').forEach((b) => b.classList.toggle('on', b.dataset.cover === S.coverColor));
  $('.cc-pick').classList.toggle('on', !preset);
  if (!preset && /^#/.test(S.coverColor)) { $('#coverCustom').value = S.coverColor; $('.cc-pick').style.background = S.coverColor; }
  else $('.cc-pick').style.background = '';
}
function addMark(page, rect, quiet, annotIds) {
  checkpoint();
  const kind = S.markStyle;
  const pad = kind === 'cover' || kind === 'blur' ? 1 : 0;
  const r = { x: rect.x - pad, y: rect.y - pad, w: rect.w + pad * 2, h: rect.h + pad * 2 };
  // added-on-top items under this mark get merged into the page when saving, so the mark can cover them
  const annots = annotIds || annotsIn(page, r).map((a) => a.id);
  const mark = { kind, page, rect: r, seed: Math.floor(Math.random() * 1e6) + 1, annots };
  if (kind === 'cover') { mark.autoColor = !S.coverColor || S.coverColor === 'auto'; mark.color = mark.autoColor ? backgroundAround(page, r) : S.coverColor; }
  S.marks.push(mark);
  S.selMark = null;
  if (!quiet) { renderMarks(); scheduleDraft(); }
  updateTypeHere();
}
// The colour of the page right around an area (the most common colour on a ring just
// outside it), so the cover blends in with coloured or grey backgrounds.
function backgroundAround(page, r) {
  const pe = S.pageEls[page];
  const c = pe?.canvas;
  if (!c || !c.width || !pe.scale) return '#ffffff';
  const k = pe.scale;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const ring = 2.5;
  const x0 = Math.max(0, Math.floor((r.x - ring) * k)), y0 = Math.max(0, Math.floor((r.y - ring) * k));
  const x1 = Math.min(c.width - 1, Math.ceil((r.x + r.w + ring) * k)), y1 = Math.min(c.height - 1, Math.ceil((r.y + r.h + ring) * k));
  if (x1 <= x0 || y1 <= y0) return '#ffffff';
  const d = ctx.getImageData(x0, y0, x1 - x0 + 1, y1 - y0 + 1).data;
  const W = x1 - x0 + 1, H = y1 - y0 + 1, edge = Math.max(1, Math.round(ring * k * 0.6));
  const counts = new Map();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (x >= edge && x < W - edge && y >= edge && y < H - edge) continue; // ring only
    const i = (y * W + x) * 4;
    const key = (d[i] >> 3) << 10 | (d[i + 1] >> 3) << 5 | (d[i + 2] >> 3);
    const e = counts.get(key) || { n: 0, r: 0, g: 0, b: 0 };
    e.n++; e.r += d[i]; e.g += d[i + 1]; e.b += d[i + 2];
    counts.set(key, e);
  }
  let best = null;
  for (const e of counts.values()) if (!best || e.n > best.n) best = e;
  if (!best) return '#ffffff';
  const hex = (v) => Math.round(v / best.n).toString(16).padStart(2, '0');
  return '#' + hex(best.r) + hex(best.g) + hex(best.b);
}
function renderMarks() {
  $$('.mk').forEach((n) => n.remove());
  const NS = 'http://www.w3.org/2000/svg';
  for (const m of S.marks) {
    m.kind = normalizeKind(m.kind);
    const pe = S.pageEls[m.page];
    if (!pe) continue;
    const r = m.rect;
    const node = el('div', { class: 'mk ' + m.kind + (m === S.selMark && S.marking ? ' sel' : '') });
    place(node, r, S.pages[m.page].viewport);
    if (m === S.selMark && S.marking) node.append(el('div', { class: 'mk-handle' }), el('div', { class: 'mk-del', title: t('removeMark'), 'aria-label': t('removeMark') }, svgIcon('<path d="M7 7l10 10M17 7L7 17"/>')));
    if (m.kind === 'cover') node.style.background = m.color || '#fff';
    else if (m.kind === 'blur') node.style.setProperty('--br', Math.max(1.5, Math.min(r.h, r.w) * 0.22) + 'px');
    else {
      const geo = markLines(m.kind, r, m.seed);
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', `${r.x} ${r.y} ${r.w} ${r.h}`);
      svg.setAttribute('preserveAspectRatio', 'none');
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', geo.lines.map(([a, b, c, d]) => `M${a} ${b}L${c} ${d}`).join(''));
      Object.entries({ fill: 'none', stroke: 'var(--ink-color, #0f1e52)', 'stroke-width': geo.width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }).forEach(([k, v]) => path.setAttribute(k, v));
      svg.append(path);
      node.append(svg);
    }
    pe.overlay.prepend(node);
  }
}

// Blur can't be expressed as vector drawing, so the area is rendered, blurred and saved as a picture.
async function blurImages(marks) {
  const out = new Map();
  for (const m of marks) {
    if (m.kind !== 'blur') continue;
    const pg = S.pages[m.page];
    const r = m.rect;
    const scale = Math.min(4, Math.max(2, 600 / Math.max(r.w, 1)));
    const radius = Math.max(1.5, Math.min(r.h, r.w) * 0.22) * scale;
    const margin = Math.ceil(radius * 3);
    const vp = pg.page.getViewport({ scale });
    const W = Math.ceil(r.w * scale), H = Math.ceil(r.h * scale);
    const src = document.createElement('canvas');
    src.width = W + margin * 2; src.height = H + margin * 2;
    const sctx = src.getContext('2d');
    sctx.fillStyle = '#fff'; sctx.fillRect(0, 0, src.width, src.height);
    const tf = [1, 0, 0, 1, -(r.x * scale - margin), -(r.y * scale - margin)];
    await pg.page.render({ canvasContext: sctx, canvas: src, viewport: vp, transform: tf, annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
    const blurred = document.createElement('canvas');
    blurred.width = src.width; blurred.height = src.height;
    const bctx = blurred.getContext('2d');
    bctx.filter = `blur(${radius}px)`;
    bctx.drawImage(src, 0, 0);
    const fin = document.createElement('canvas');
    fin.width = W; fin.height = H;
    fin.getContext('2d').drawImage(blurred, margin, margin, W, H, 0, 0, W, H);
    out.set(m, fin.toDataURL('image/png'));
  }
  return out;
}

// ------------------------------------------------------------------ select & merge boxes
const MERGEABLE = new Set(['text', 'multiline']);
function setSelectMode(on) {
  S.selecting = on;
  S.selected.clear();
  if (on) { closeEditor(); document.activeElement?.blur(); setAddMode(null); $('#inkPop').hidden = true; }
  $('#selBtn').classList.toggle('on', on);
  $('#selMode').hidden = !on;
  $$('.ov.selected').forEach((n) => n.classList.remove('selected'));
  updateSelBar();
}
function toggleSelect(f) {
  if (!f) return;
  if (!MERGEABLE.has(f.type) || f.signature) { toast(t('onlyTextMerge')); return; }
  if (S.selected.has(f.id)) S.selected.delete(f.id);
  else {
    const first = fieldById([...S.selected][0]);
    if (first && fieldPage(first) !== fieldPage(f)) { toast(t('samePageMerge')); return; }
    S.selected.add(f.id);
  }
  $$(`.ov[data-id="${CSS.escape(f.id)}"]`).forEach((n) => n.classList.toggle('selected', S.selected.has(f.id)));
  updateSelBar();
}
function updateSelBar() {
  $('#selCount').textContent = t('selectedN', { n: S.selected.size });
  $('#selMerge').disabled = S.selected.size < 2;
}
function mergeSelected() {
  checkpoint();
  const parts = [...S.selected].map(fieldById).filter(Boolean);
  if (parts.length < 2) return;
  // a merged box can itself be merged again: flatten into its parts
  const flatParts = parts.flatMap((p) => (p.source === 'merge' ? p.parts : [p]));
  const oldValues = parts.map((p) => S.values[p.id]).filter((v) => typeof v === 'string' && v.trim());
  for (const p of parts) if (p.source === 'merge') { S.fields = S.fields.filter((x) => x !== p); delete S.values[p.id]; }
  const m = mergeFields(flatParts.filter((p) => !parts.includes(p) || p.source !== 'merge'), {});
  setSelectMode(false);
  if (!m) return;
  S.values[m.id] = m.mode === 'spread' ? oldValues.join('').replace(/\s+/g, '') : oldValues.join(' ');
  renderAllOverlays(); updateHeader(); scheduleDraft();
  if (S.tab === 'list') renderForm();
  activate(m, { nav: true });
  toast(t('merged'));
}
function mergeFields(parts, opt) {
  parts = sortFields([...parts]);
  const rects = parts.map(fieldRect);
  const page = fieldPage(parts[0]);
  const x1 = Math.min(...rects.map((r) => r.x)), y1 = Math.min(...rects.map((r) => r.y));
  const x2 = Math.max(...rects.map((r) => r.x + r.w)), y2 = Math.max(...rects.map((r) => r.y + r.h));
  const maxH = Math.max(...rects.map((r) => r.h));
  const cys = rects.map((r) => r.y + r.h / 2);
  const sameRow = Math.max(...cys) - Math.min(...cys) < maxH * 0.5;
  const small = rects.every((r) => r.w <= r.h * 2.4) || parts.every((p) => p.maxLen === 1 || p.comb);
  const firstIdx = Math.min(...parts.map((p) => S.fields.indexOf(p)).filter((i) => i >= 0));
  const m = {
    id: opt.id || 'merge:' + Math.random().toString(36).slice(2, 9),
    source: 'merge', parts, page,
    mode: opt.mode || (sameRow && small ? 'spread' : 'span'),
    type: !sameRow && (y2 - y1) > maxH * 1.6 ? 'multiline' : 'text',
    label: opt.label || parts[0].label.replace(/\s*\((row|rad) \d+\)$/, ''),
    rect: { x: x1, y: y1, w: x2 - x1, h: y2 - y1 },
    widgets: [], options: [], required: parts.some((p) => p.required), initial: '', inputType: 'text',
  };
  if (m.mode === 'spread') m.maxLen = parts.length;
  const h = inputHintsFor(m.label);
  Object.assign(m, h);
  S.fields = S.fields.filter((f) => !parts.includes(f));
  S.fields.splice(Math.min(firstIdx, S.fields.length), 0, m);
  for (const p of parts) delete S.values[p.id];
  S.values[m.id] = '';
  return m;
}
function inputHintsFor(label) {
  const l = (label || '').toLowerCase();
  if (/e-?mail|e-?post/.test(l)) return { inputType: 'email', inputmode: 'email', autocomplete: 'email' };
  if (/phone|telefon|tlf|mobil/.test(l)) return { inputType: 'tel', inputmode: 'tel', autocomplete: 'tel' };
  if (/nummer|number|\bnr\b|n°|postn|zip|konto|fødselsn|personn/.test(l)) return { inputmode: 'numeric' };
  return {};
}
function setMergeMode(f, mode) {
  if (f.mode === mode) return;
  checkpoint();
  closeEditor();
  f.mode = mode;
  f.maxLen = mode === 'spread' ? f.parts.length : 0;
  if (mode === 'spread') { const v = S.values[f.id] || ''; S.values[f.id] = [...v.replace(/\s+/g, '')].slice(0, f.parts.length).join(''); }
  $$(`.ov[data-id="${CSS.escape(f.id)}"]`).forEach((n) => n.remove());
  for (const b of boxesOf(f)) addBox(f, b);
  scheduleDraft();
  activate(f, { nav: true });
}
function splitMerged(f) {
  checkpoint();
  closeEditor();
  const v = typeof S.values[f.id] === 'string' ? S.values[f.id] : '';
  const chars = [...v];
  const i = S.fields.indexOf(f);
  S.fields.splice(i, 1, ...f.parts);
  delete S.values[f.id];
  f.parts.forEach((p, k) => { S.values[p.id] = f.mode === 'spread' ? (chars[k] || '') : (k === 0 ? v : (p.source === 'acro' ? p.initial : '')); });
  renderAllOverlays(); updateHeader(); scheduleDraft();
  if (S.tab === 'list') renderForm();
  activate(f.parts[0], { nav: true });
}

// ------------------------------------------------------------------ text colour
const INKS = [['#000000', 'inkBlack'], ['#1a3fbf', 'inkBlue'], ['#0b1f66', 'inkNavy'], ['#c4161c', 'inkRed'], ['#137a3a', 'inkGreen']];
const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
function setupInk() {
  S.ink = store.get('ff:ink', null);
  const box = $('#inkSwatches');
  for (const [hex, key] of INKS) {
    box.append(el('div', {}, el('button', { class: 'swatch', type: 'button', style: `background:${hex}`, dataset: { hex }, title: t(key), 'aria-label': t(key), onclick: () => setInk(hex) }), el('span', { class: 'swatch-name', 'data-i18n': key, text: t(key) })));
  }
  $('#inkCustom').addEventListener('input', (e) => setInk(e.target.value));
  $('#inkBtn').addEventListener('click', (e) => { e.stopPropagation(); $('#inkPop').hidden = !$('#inkPop').hidden; if (!$('#inkPop').hidden) setAddMode(null); });
  document.addEventListener('pointerdown', (e) => { if (!$('#inkPop').hidden && !e.target.closest('#inkPop, #inkBtn')) $('#inkPop').hidden = true; });
  applyInk();
}
function setInk(hex) {
  S.ink = hex;
  store.set('ff:ink', hex);
  applyInk();
}
function applyInk() {
  const hex = S.ink || '#0f1e52';
  $('#pagesBox').style.setProperty('--ink-color', hex);
  $('#inkDot').style.setProperty('--ink-color', hex);
  $('#inkCustom').value = S.ink || '#000000';
  $$('.swatch').forEach((b) => b.classList.toggle('on', b.dataset.hex === S.ink));
}

// ------------------------------------------------------------------ signatures
let sigPad = null, sigField = null;
function setupSignatureDialog() {
  const canvas = $('#sigCanvas');
  sigPad = attachPad(canvas, $('#sigDlg .sig-ph'));
  $('#sigClear').addEventListener('click', () => sigPad.clear());
  $('#sigClose').addEventListener('click', () => $('#sigDlg').close());
  $('#sigUse').addEventListener('click', () => {
    if (sigField) setValue(sigField, sigPad.hasInk() ? { sig: trimmedPng(canvas) } : '');
    $('#sigDlg').close();
    updateEditBar();
  });
}
function openSignature(f) {
  sigField = f;
  closeEditor();
  $('#sigTitle').textContent = f.label;
  $('#sigDlg').showModal();
  requestAnimationFrame(() => { sigPad.setup(); const v = S.values[f.id]; if (v && v.sig) sigPad.load(v.sig); });
}
function attachPad(canvas, placeholder, onInk) {
  let ctx = null, drawing = false, last = null, ink = false, ratio = 1;
  const setup = () => {
    const r = canvas.getBoundingClientRect();
    ratio = Math.max(2, devicePixelRatio || 1);
    canvas.width = Math.max(10, r.width * ratio); canvas.height = Math.max(10, r.height * ratio);
    ctx = canvas.getContext('2d');
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111a3a'; ctx.lineWidth = 2.4 * ratio;
    ink = false; placeholder.hidden = false;
  };
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) * ratio, (e.clientY - r.top) * ratio]; };
  canvas.addEventListener('pointerdown', (e) => { if (!ctx) setup(); drawing = true; canvas.setPointerCapture(e.pointerId); last = pos(e); placeholder.hidden = true; });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const p = pos(e);
    ctx.beginPath(); ctx.moveTo(last[0], last[1]);
    ctx.quadraticCurveTo(last[0], last[1], (last[0] + p[0]) / 2, (last[1] + p[1]) / 2);
    ctx.lineTo(p[0], p[1]); ctx.stroke();
    last = p; ink = true;
  });
  const end = () => { if (drawing) { drawing = false; if (ink && onInk) onInk(); } };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  return {
    setup,
    clear: () => { if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height); ink = false; placeholder.hidden = false; },
    hasInk: () => ink,
    load: (src) => { const img = new Image(); img.onload = () => { const s = Math.min(canvas.width / img.width, canvas.height / img.height); ctx.drawImage(img, 0, canvas.height - img.height * s, img.width * s, img.height * s); ink = true; placeholder.hidden = true; }; img.src = src; },
  };
}
function trimmedPng(canvas) {
  const ctx = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  const d = ctx.getImageData(0, 0, w, h).data;
  let x1 = w, y1 = h, x2 = 0, y2 = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 10) { if (x < x1) x1 = x; if (x > x2) x2 = x; if (y < y1) y1 = y; if (y > y2) y2 = y; }
  if (x2 <= x1) return canvas.toDataURL('image/png');
  const pad = 6;
  x1 = Math.max(0, x1 - pad); y1 = Math.max(0, y1 - pad); x2 = Math.min(w, x2 + pad); y2 = Math.min(h, y2 + pad);
  const c = document.createElement('canvas');
  c.width = x2 - x1; c.height = y2 - y1;
  c.getContext('2d').drawImage(canvas, x1, y1, c.width, c.height, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}

// ------------------------------------------------------------------ list view (alternative to the PDF view)
function renderForm() {
  const form = $('#theForm');
  form.innerHTML = '';
  if (!S.fields.length) {
    form.append(el('div', { class: 'empty' }, el('h3', { text: t('noFieldsTitle') }), el('p', { text: t('noFieldsText') }), el('button', { class: 'btn primary', type: 'button', text: t('addField'), onclick: () => { setTab('pdf'); setAddMode('text'); } })));
    return;
  }
  const memory = store.get('ff:memory', {});
  let lastPage = -1, lastContext = null;
  const multiPage = S.pages.length > 1;
  S.fields.forEach((f, idx) => {
    if (multiPage && fieldPage(f) !== lastPage) {
      form.append(el('div', { class: 'page-head', text: t('pageOf', { a: fieldPage(f) + 1, b: S.pages.length }) }));
      lastPage = fieldPage(f); lastContext = null;
    }
    if (f.type === 'checkbox' && f.context) {
      if (f.context !== lastContext) form.append(el('div', { class: 'group-head', text: f.context }));
      lastContext = f.context;
    } else if (f.type !== 'checkbox') lastContext = null;
    form.append(fieldCard(f, idx, memory));
  });
  refreshFilledState();
}

function fieldCard(f, idx, memory) {
  const card = el('div', { class: 'field', dataset: { id: f.id } });
  const inputId = 'in-' + idx;
  const labelEl = f.custom
    ? el('input', { class: 'input', style: 'font-weight:600;padding:6px 10px;font-size:15px', value: f.label, 'aria-label': t('renameField'), oninput: (e) => { f.label = e.target.value; scheduleDraft(); } })
    : el('label', { class: 'field-label', for: inputId, text: f.label }, f.required ? el('span', { class: 'req', text: '*', title: t('required') }) : null);
  const tools = el('div', { class: 'field-tools' },
    el('button', { class: 'mini-btn', type: 'button', title: t('goToField'), 'aria-label': t('goToField'), onclick: () => { setTab('pdf'); activate(f, { nav: true }); } }, svgIcon(ICONS.pin)),
    f.source === 'flat' ? el('button', { class: 'mini-btn', type: 'button', title: t('removeField'), 'aria-label': t('removeField'), onclick: () => removeField(f) }, svgIcon(ICONS.trash)) : null);
  card.addEventListener('focusin', () => { S.currentId = f.id; $$('.field.focused').forEach((c) => c.classList.remove('focused')); card.classList.add('focused'); });
  const set = (v) => { setValue(f, v); refreshFilledState(f); };
  const v = S.values[f.id];

  if (f.type === 'checkbox') {
    card.classList.add('check');
    const cb = el('input', { type: 'checkbox', id: inputId, onchange: (e) => set(e.target.checked) });
    cb.checked = !!v;
    const lab = f.custom ? labelEl : el('span', { class: 'field-label' }, f.label, f.required ? el('span', { class: 'req', text: '*' }) : null);
    card.append(el('div', { class: 'field-top' },
      el('label', { class: 'toggle', style: 'flex:1', for: f.custom ? null : inputId }, cb, el('span', { class: 'checkmark' }, svgIcon(ICONS.check)), f.custom ? null : lab),
      f.custom ? lab : null, tools));
    return card;
  }
  card.append(el('div', { class: 'field-top' }, el('span', { class: 'filled-dot' }), labelEl, tools));
  if (f.hint) card.append(el('div', { class: 'field-hint', text: f.hint }));

  if (f.type === 'radio') {
    const group = el('div', { class: 'pills', role: 'radiogroup', 'aria-label': f.label });
    const name = 'r-' + idx;
    f.options.forEach((o, i) => {
      const r = el('input', { type: 'radio', name, value: o.value, id: i === 0 ? inputId : null, onchange: () => set(o.value) });
      r.checked = v === o.value;
      r.addEventListener('click', () => { if (r.dataset.was === '1') { r.checked = false; set(''); } $$(`input[name="${name}"]`, group).forEach((x) => { x.dataset.was = x.checked ? '1' : ''; }); });
      r.dataset.was = r.checked ? '1' : '';
      group.append(el('label', { class: 'pill' }, r, el('span', { text: o.label || o.value })));
    });
    card.append(group);
    return card;
  }
  if (f.type === 'select' || (f.type === 'list' && !f.multiSelect)) {
    if (f.editable) {
      const dl = el('datalist', { id: 'dl-' + idx }, f.options.map((o) => el('option', { value: o.label })));
      card.append(el('input', { class: 'input', id: inputId, list: dl.id, value: displayOf(f, v), oninput: (e) => set(valueOf(f, e.target.value)) }), dl);
    } else {
      const sel = el('select', { id: inputId, onchange: (e) => set(e.target.value) },
        el('option', { value: '', text: t('choosePlaceholder') }), f.options.map((o) => el('option', { value: o.value, text: o.label })));
      sel.value = Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
      card.append(sel);
    }
    return card;
  }
  if (f.type === 'list') {
    const group = el('div', { class: 'pills' });
    const cur = new Set(Array.isArray(v) ? v : []);
    f.options.forEach((o, i) => {
      const c = el('input', { type: 'checkbox', id: i === 0 ? inputId : null, onchange: (e) => { e.target.checked ? cur.add(o.value) : cur.delete(o.value); set([...cur]); } });
      c.checked = cur.has(o.value);
      group.append(el('label', { class: 'pill' }, c, el('span', { text: o.label })));
    });
    card.append(group);
    return card;
  }
  if (f.signature) {
    card.append(signatureWidget(f, inputId, set));
    return card;
  }
  const sugg = (memory[normLabel(f.label)] || []).filter(Boolean);
  const dl = sugg.length ? el('datalist', { id: 'dl-' + idx }, sugg.map((s) => el('option', { value: s }))) : null;
  let input;
  if (f.type === 'multiline') {
    input = el('textarea', { id: inputId, oninput: (e) => set(e.target.value), maxlength: f.maxLen || null, rows: Math.min(10, Math.max(3, Math.round((f.rect.h || 40) / 14))) });
    input.value = v || '';
  } else if (f.isDate) {
    input = el('input', { class: 'input', type: 'date', id: inputId, value: v || '', oninput: (e) => set(e.target.value) });
  } else {
    input = el('input', {
      class: 'input', id: inputId, type: f.inputType === 'email' ? 'email' : 'text', value: typeof v === 'string' ? v : '', list: dl ? dl.id : null,
      autocomplete: f.autocomplete || (dl ? 'off' : null), inputmode: keyboardFor(f), maxlength: f.maxLen || null, enterkeyhint: 'next',
      oninput: (e) => set(e.target.value),
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); focusNextCard(f); } });
  }
  if (f.dateChip && !f.isDate) {
    const today = el('button', { class: 'chip', type: 'button', text: t('today'), onclick: () => { input.value = formatDate(new Date().toISOString().slice(0, 10), getLang() === 'nb' ? 'dd.mm.yyyy' : 'mm/dd/yyyy'); set(input.value); } });
    card.append(el('div', { class: 'input-row' }, input, today));
  } else card.append(input);
  if (dl) card.append(dl);
  return card;
}
function focusNextCard(f) {
  const i = S.fields.indexOf(f);
  for (let k = i + 1; k < S.fields.length; k++) {
    const c = $(`.field[data-id="${CSS.escape(S.fields[k].id)}"]`)?.querySelector('input:not([type=radio]):not([type=checkbox]), textarea, select');
    if (c) { c.focus(); return; }
  }
  document.activeElement?.blur();
}
function signatureWidget(f, inputId, set) {
  const wrap = el('div');
  const render = () => {
    wrap.innerHTML = '';
    const cur = S.values[f.id];
    if (f.sigTyped && f.type !== 'signature') {
      const inp = el('input', { class: 'input', id: inputId, value: (cur && cur.text) || '', autocomplete: 'name', oninput: (e) => set({ text: e.target.value }) });
      inp.style.fontStyle = 'italic';
      wrap.append(inp, el('div', { class: 'sig-actions' }, el('button', { class: 'chip', type: 'button', text: t('drawInstead'), onclick: () => { f.sigTyped = false; set(''); render(); } })));
      return;
    }
    const canvas = el('canvas', { id: inputId, 'aria-label': t('signHere') });
    const ph = el('span', { class: 'sig-ph', text: t('signHere') });
    const pad = el('div', { class: 'sig-pad' }, el('div', { class: 'sig-line' }), canvas, ph);
    const p = attachPad(canvas, ph, () => set({ sig: trimmedPng(canvas) }));
    wrap.append(pad, el('div', { class: 'sig-actions' },
      el('button', { class: 'chip', type: 'button', text: t('clear'), onclick: () => { p.clear(); set(''); } }),
      f.type !== 'signature' ? el('button', { class: 'chip', type: 'button', text: t('typeInstead'), onclick: () => { f.sigTyped = true; set({ text: '' }); render(); } }) : null));
    requestAnimationFrame(() => { p.setup(); if (cur && cur.sig) p.load(cur.sig); });
  };
  render();
  return wrap;
}
function refreshFilledState(only) {
  for (const f of only ? [only] : S.fields) {
    const card = $(`.field[data-id="${CSS.escape(f.id)}"]`);
    if (card) card.classList.toggle('is-filled', hasValue(f, S.values[f.id]));
  }
}

// ------------------------------------------------------------------ drafts & memory
let draftTimer = null;
function scheduleDraft() { clearTimeout(draftTimer); draftTimer = setTimeout(saveDraftNow, 600); }
function saveDraftNow() {
  clearTimeout(draftTimer);
  if (!S.fingerprint || !S.fields.length) return;
  const anyValue = S.fields.some((f) => hasValue(f, S.values[f.id]) && JSON.stringify(S.values[f.id] ?? '') !== JSON.stringify(f.initial ?? ''));
  const allFlat = S.fields.flatMap((f) => (f.source === 'merge' ? f.parts : [f])).filter((f) => f.source === 'flat');
  const flat = allFlat.map((f) => ({ id: f.id, type: f.type, label: f.label, page: f.page, rect: f.rect, custom: !!f.custom, context: f.context, signature: !!f.signature, line: f.line }));
  const merges = S.fields.filter((f) => f.source === 'merge').map((f) => ({ id: f.id, mode: f.mode, label: f.label, parts: f.parts.map((p) => p.id) }));
  if (!anyValue && !flat.some((f) => f.custom) && !merges.length && !S.marks.length) return;
  store.set('ff:draft:' + S.fingerprint, { t: Date.now(), values: S.values, flat: flat.length ? flat : null, merges, marks: S.marks });
  const keys = Object.keys(localStorage).filter((k) => k.startsWith('ff:draft:'));
  if (keys.length > 12) keys.map((k) => [k, store.get(k, {}).t || 0]).sort((a, b) => a[1] - b[1]).slice(0, keys.length - 12).forEach(([k]) => store.del(k));
}
function maybeOfferRestore() {
  const d = store.get('ff:draft:' + S.fingerprint, null);
  if (!d || !d.values) return;
  const n = addNotice(el('div', {}, el('h4', { text: t('restoreTitle') }), el('div', { text: t('restoreText') })), 'info', false,
    el('div', { class: 'row' },
      el('button', { class: 'btn primary small', type: 'button', text: t('restore'), onclick: () => { restoreDraft(d); n.remove(); } }),
      el('button', { class: 'btn ghost small', type: 'button', text: t('dismiss'), onclick: () => n.remove() })));
}
function restoreDraft(d) {
  checkpoint();
  if (d.flat) {
    const acro = S.fields.filter((f) => f.source === 'acro');
    const flat = d.flat.map((x) => Object.assign(finishFlatFields([{ ...x }])[0], { id: x.id, label: x.label, custom: x.custom, context: x.context, signature: x.signature, line: x.line }));
    S.fields = sortFields([...acro, ...flat]);
    S.customCount = flat.filter((f) => f.custom).length;
  }
  S.marks = Array.isArray(d.marks) ? d.marks : [];
  for (const m of d.merges || []) {
    const parts = m.parts.map(fieldById).filter(Boolean);
    if (parts.length >= 2) mergeFields(parts, { id: m.id, mode: m.mode, label: m.label });
  }
  for (const f of S.fields) if (d.values[f.id] !== undefined) S.values[f.id] = d.values[f.id];
  closeEditor();
  renderAllOverlays(); updateHeader(); updateEditBar();
  if (S.tab === 'list') renderForm();
}
function rememberAnswers() {
  const mem = store.get('ff:memory', {});
  for (const f of S.fields) {
    if (!TEXTLIKE.has(f.type) || f.signature || f.isDate) continue;
    const v = S.values[f.id];
    if (typeof v !== 'string' || !v.trim() || v.length > 200) continue;
    const k = normLabel(f.label);
    if (!k || k.length > 60) continue;
    mem[k] = [v, ...(mem[k] || []).filter((x) => x !== v)].slice(0, 5);
  }
  const keys = Object.keys(mem);
  if (keys.length > 400) keys.slice(0, keys.length - 400).forEach((k) => delete mem[k]);
  store.set('ff:memory', mem);
}

// ------------------------------------------------------------------ build / preview / save
const formPages = () => new Set(S.fields.flatMap((f) => (f.widgets.length ? f.widgets.map((w) => w.page) : [f.page])));
async function build(mode = 'all', flatten = false) {
  // merged boxes are turned back into plain fields for the PDF writer
  const fields = [], values = {}, detach = [];
  for (const f of S.fields) {
    if (f.source !== 'merge') { fields.push(f); values[f.id] = S.values[f.id]; continue; }
    const v = typeof S.values[f.id] === 'string' ? S.values[f.id] : '';
    if (f.mode === 'spread') {
      const chars = [...v];
      f.parts.forEach((p, i) => { fields.push({ ...p, center: true }); values[p.id] = chars[i] ?? (p.source === 'acro' ? p.initial : ''); });
    } else {
      fields.push({ id: f.id, source: 'flat', type: f.type, label: f.label, page: f.page, rect: f.rect, widgets: [], options: [], line: false, initial: '' });
      values[f.id] = v;
      for (const p of f.parts) if (p.source === 'acro' && v) detach.push(p.name);
    }
  }
  const blurs = S.encrypted ? new Map() : await blurImages(S.marks);
  const marks = S.marks.map((m) => ({ ...m, kind: normalizeKind(m.kind), image: blurs.get(m) || null }));
  return buildPdf({ bytes: S.bytes, password: S.password, encrypted: S.encrypted, fields, values, detach, marks, viewports: S.pages.map((p) => p.viewport), mode, flatten, color: S.ink ? hexToRgb(S.ink) : null });
}

async function preview() {
  const mode = $('input[name=saveMode]:checked')?.value || 'all';
  const flatten = $('#flattenInput').checked;
  busy(t('building'));
  try {
    const { bytes, warnings } = await build(mode, flatten);
    const task = openPdf(bytes, S.password);
    const doc = await task.promise;
    const box = $('#previewPages');
    box.innerHTML = '';
    $('#previewDlg').showModal();
    busy(false);
    warnings.forEach((w) => toast(w, 'warn', 5000));
    const width = Math.min(860, box.clientWidth || 600);
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const vp1 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: (width / vp1.width) * Math.min(2, devicePixelRatio || 1) });
      const c = el('canvas');
      c.width = vp.width; c.height = vp.height;
      box.append(c);
      await page.render({ canvasContext: c.getContext('2d'), canvas: c, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
      if (!$('#previewDlg').open) break;
    }
    task.destroy();
  } catch (e) {
    console.error(e);
    busy(false);
    toast(t('error', { msg: e.message || e }), 'warn', 6000);
  }
}

async function openSave() {
  closeEditor();
  document.activeElement?.blur();
  const missing = S.fields.filter((f) => f.required && !hasValue(f, S.values[f.id]));
  if (missing.length) {
    const ok = await confirmBox(t('missingRequired', { n: missing.length }), t('saveAnyway'), t('goToField'));
    if (!ok) { setTab('pdf'); activate(missing[0], { nav: true }); return; }
  }
  const base = S.fileName.replace(/\.pdf$/i, '');
  $('#fileNameInput').value = /-(filled|utfylt)$/.test(base) ? base : `${base}-${getLang() === 'nb' ? 'utfylt' : 'filled'}`;
  const total = S.pages.length;
  const fp = formPages().size || total;
  $('#saveAllText').textContent = t('saveAllText', { n: total });
  $('#saveFormText').textContent = t('saveFormText', { n: fp });
  const formOpt = $('input[name=saveMode][value=form]');
  formOpt.disabled = S.encrypted || fp >= total;
  if (formOpt.disabled) $('input[name=saveMode][value=all]').checked = true;
  $('#flattenInput').disabled = S.encrypted;
  if (S.encrypted) $('#flattenInput').checked = false;
  $('#shareBtn').hidden = !(navigator.canShare && navigator.canShare({ files: [new File([new Uint8Array(1)], 'x.pdf', { type: 'application/pdf' })] }));
  updateSaveNotes();
  $('#saveDlg').showModal();
}
function updateSaveNotes() {
  const n = $('#saveNotes');
  n.innerHTML = '';
  if (S.encrypted) n.append(el('div', { class: 'notice warn' }, el('div', { class: 'grow', text: t('encryptedNote') })));
}

async function doSave(how) {
  const mode = $('input[name=saveMode]:checked').value;
  const flatten = $('#flattenInput').checked;
  let name = ($('#fileNameInput').value || 'filled').trim().replace(/[\\/:*?"<>|]+/g, '-');
  if (!/\.pdf$/i.test(name)) name += '.pdf';
  busy(t('building'));
  try {
    const { bytes, warnings } = await build(mode, flatten);
    busy(false);
    const file = new File([bytes], name, { type: 'application/pdf' });
    rememberAnswers();
    saveDraftNow();
    if (how === 'share') {
      try { await navigator.share({ files: [file], title: name }); } catch (e) { if (e.name !== 'AbortError') throw e; return; }
    } else {
      const url = URL.createObjectURL(file);
      const a = el('a', { href: url, download: name });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }
    $('#saveDlg').close();
    toast(t('saved'));
    warnings.forEach((w) => toast(w, 'warn', 6000));
  } catch (e) {
    console.error(e);
    busy(false);
    toast(t('error', { msg: e.message || e }), 'warn', 6000);
  }
}

// ------------------------------------------------------------------ PWA
function setupPwa() {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js?v=' + VERSION).catch(() => {});
  let deferred = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; $('#installBtn').hidden = false; });
  $('#installBtn').addEventListener('click', async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; $('#installBtn').hidden = true; });
  window.addEventListener('appinstalled', () => { $('#installBtn').hidden = true; });
  const params = new URLSearchParams(location.search);
  if (params.has('shared') && 'caches' in window) {
    caches.open('ff-share').then(async (c) => {
      const r = await c.match('shared-file');
      if (!r) return;
      const name = decodeURIComponent(r.headers.get('x-name') || 'shared.pdf');
      const buf = new Uint8Array(await r.arrayBuffer());
      await c.delete('shared-file');
      history.replaceState(null, '', location.pathname);
      busy(t('reading'));
      loadBytes(buf, name);
    });
  }
  if ('launchQueue' in window) window.launchQueue.setConsumer(async (p) => { if (p.files && p.files[0]) loadFile(await p.files[0].getFile()); });
}

// If the page and the code come from different versions (an old offline copy), wipe the
// offline cache and reload once so everything is the same version again.
async function selfHeal() {
  const ok = document.getElementById('stage') && document.getElementById('editbar');
  if (ok) { try { sessionStorage.removeItem('ff:healed'); } catch {} return false; }
  let tried = false;
  try { tried = sessionStorage.getItem('ff:healed') === '1'; sessionStorage.setItem('ff:healed', '1'); } catch {}
  if (tried) return false;
  try {
    const regs = await navigator.serviceWorker?.getRegistrations?.() || [];
    await Promise.all(regs.map((r) => r.unregister()));
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('formfiller-')).map((k) => caches.delete(k)));
  } catch {}
  location.reload();
  return true;
}

selfHeal().then((reloading) => { if (!reloading) boot(); });
