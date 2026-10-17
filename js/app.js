import { VERSION } from './version.js';
import { t, getLang, setLang, applyStatic } from './i18n.js';
import { openPdf, pdfjsLib } from './pdf.js';
import { getSegments, readAcroFields, labelAcroFields, detectFlatFields, finishFlatFields, sortFields } from './detect.js';
import { buildPdf, hasValue, parseDateToIso, formatDate } from './fill.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'html') e.innerHTML = v;
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
};

const S = {
  bytes: null, fileName: '', password: undefined, encrypted: false,
  doc: null, pages: [], segsByPage: [], fields: [], values: {},
  currentPage: 0, currentId: null, addMode: null, fingerprint: '', loaded: false,
  renderCache: new Map(), customCount: 0,
};

// ------------------------------------------------------------------ helpers
const isMobile = () => matchMedia('(max-width: 979px)').matches;
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

// ------------------------------------------------------------------ boot
function boot() {
  $('#version').textContent = 'v' + VERSION;
  $$('.version-text').forEach((n) => { n.textContent = 'v' + VERSION; });
  applyStatic();
  updateLangBtn();
  $('#langBtn').addEventListener('click', () => {
    setLang(getLang() === 'nb' ? 'en' : 'nb');
    updateLangBtn();
    if (S.loaded) { renderForm(); renderPagePanel(); updateHeader(); }
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
      const buf = new Uint8Array(await r.arrayBuffer());
      await loadBytes(buf, b.dataset.sample.split('/').pop());
    } catch (e) { busy(false); toast(t('loadFailed'), 'warn'); }
  }));

  $('#newBtn').addEventListener('click', () => goHome());
  $('#brand').addEventListener('click', (e) => { if (S.loaded) { e.preventDefault(); goHome(); } });
  $('#forgetBtn').addEventListener('click', () => {
    for (const k of Object.keys(localStorage)) if (k.startsWith('ff:draft:') || k === 'ff:memory') store.del(k);
    toast(t('forgotten'));
  });

  $$('.tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  $('#prevPage').addEventListener('click', () => showPage(S.currentPage - 1));
  $('#nextPage').addEventListener('click', () => showPage(S.currentPage + 1));
  $('#addBtn').addEventListener('click', () => setAddMode('text'));
  $$('[data-add]').forEach((b) => b.addEventListener('click', () => setAddMode(b.dataset.add)));
  $('#addDone').addEventListener('click', () => setAddMode(null));
  $('#scanMoreBtn').addEventListener('click', scanMore);
  $('#previewBtn').addEventListener('click', preview);
  $('#saveBtn').addEventListener('click', openSave);
  $('#downloadBtn').addEventListener('click', () => doSave('download'));
  $('#shareBtn').addEventListener('click', () => doSave('share'));
  $('#previewClose').addEventListener('click', () => $('#previewDlg').close());
  $$('dialog').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close('cancel'); }));
  $('#saveForm').addEventListener('change', updateSaveNotes);

  window.addEventListener('scroll', () => document.body.classList.toggle('scrolled', scrollY > 4), { passive: true });
  window.addEventListener('popstate', () => { if (S.loaded && !$('#fill').hidden) goHome(true); });
  new ResizeObserver(() => sizeOverlay()).observe($('#pageWrap'));
  setupPageInteractions();
  setupPwa();
}

function updateLangBtn() { $('#langBtn').textContent = getLang() === 'nb' ? 'EN' : 'NO'; $('#langBtn').title = t('language'); }

// ------------------------------------------------------------------ loading
async function loadFile(file) {
  if (file.type && file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) { toast(t('notPdf'), 'warn'); return; }
  busy(t('reading'));
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    await loadBytes(buf, file.name);
  } catch (e) {
    console.error(e);
    busy(false);
    toast(t('loadFailed'), 'warn');
  }
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
  Object.assign(S, { bytes, fileName: name || 'document.pdf', password: undefined, doc: null, pages: [], segsByPage: [], fields: [], values: {}, currentPage: 0, currentId: null, renderCache: new Map(), customCount: 0, addMode: null });

  // open (asking for a password if needed)
  let task = openPdf(bytes);
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
    if (e?.name !== 'AbortException' && !/destroyed|worker was destroyed/i.test(e?.message || '')) toast(t('loadFailed'), 'warn');
    return;
  }
  S.doc = doc;
  S.task = task;
  S.fingerprint = (doc.fingerprints && doc.fingerprints[0]) || name + bytes.length;
  // protected PDFs (owner password / permissions) can't be edited by pdf-lib
  const tail = new TextDecoder('latin1').decode(bytes.length > 4e6 ? bytes.subarray(bytes.length - 2e6) : bytes);
  S.encrypted = /\/Encrypt\s*[\d<]/.test(tail) || S.password != null;

  busy(t('analyzing'));
  for (let i = 0; i < doc.numPages; i++) {
    const page = await doc.getPage(i + 1);
    S.pages.push({ index: i, page, viewport: page.getViewport({ scale: 1 }) });
  }
  for (const pg of S.pages) S.segsByPage[pg.index] = await getSegments(pg.page, pg.viewport).catch(() => []);
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
  const more = await scanFlat(S.fields);
  busy(false);
  if (!more.length) { toast(t('noFieldsTitle')); return; }
  for (const f of more) S.values[f.id] = structuredClone(f.initial);
  S.fields = sortFields([...S.fields, ...more]);
  S.isFlat = S.isFlat || S.fields.every((f) => f.source === 'flat');
  renderForm(); renderPagePanel(); updateHeader();
  toast(t(more.length === 1 ? 'fieldsFound1' : 'fieldsFound', { n: more.length }));
}

function showFill() {
  $('#home').hidden = true;
  $('#fill').hidden = false;
  if (history.state?.view !== 'fill') history.pushState({ view: 'fill' }, '');
  scrollTo(0, 0);
  setTab('form');
  $('#scanMoreBtn').hidden = S.isFlat;
  renderForm();
  updateHeader();
  showPage(0);
}

function goHome(fromPop) {
  saveDraftNow();
  $('#fill').hidden = true;
  $('#home').hidden = false;
  S.loaded = false;
  setAddMode(null);
  if (!fromPop && history.state?.view === 'fill') history.back();
  scrollTo(0, 0);
}

function setTab(tab) {
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('.workspace').dataset.tab = tab;
  if (tab === 'pages') { sizeOverlay(); showPage(S.currentPage); }
}

function updateHeader() {
  $('#docName').textContent = S.fileName;
  const total = S.fields.length;
  const filled = S.fields.filter((f) => hasValue(f, S.values[f.id])).length;
  $('#docCount').textContent = t(total === 1 ? 'fieldsFound1' : 'fieldsFound', { n: total }) + ' · ' + t(S.pages.length === 1 ? 'pagesN1' : 'pagesN', { n: S.pages.length });
  $('#docProgressText').textContent = t('filledOf', { a: filled, b: total });
  $('#progressBar').style.width = total ? (filled / total) * 100 + '%' : '0';
}

// ------------------------------------------------------------------ form rendering
function renderForm() {
  const form = $('#theForm');
  form.innerHTML = '';
  const notices = $('#notices');
  notices.innerHTML = '';
  if (!S.fields.length) {
    form.append(el('div', { class: 'empty' }, el('h3', { text: t('noFieldsTitle') }), el('p', { text: t('noFieldsText') }), el('button', { class: 'btn primary', type: 'button', text: t('addField'), onclick: () => { setTab('pages'); setAddMode('text'); } })));
    return;
  }
  if (S.isFlat) notices.append(el('div', { class: 'notice info' }, el('div', { class: 'grow', text: t('flatNotice') })));

  const memory = store.get('ff:memory', {});
  let lastPage = -1, lastContext = null;
  const multiPage = S.pages.length > 1;
  S.fields.forEach((f, idx) => {
    if (multiPage && f.page !== lastPage) {
      form.append(el('div', { class: 'page-head', text: t('pageOf', { a: f.page + 1, b: S.pages.length }) }));
      lastPage = f.page; lastContext = null;
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
    el('button', { class: 'mini-btn', type: 'button', title: t('goToField'), 'aria-label': t('goToField'), onclick: () => locate(f) }, svgIcon(ICONS.pin)),
    f.source === 'flat' ? el('button', { class: 'mini-btn', type: 'button', title: t('removeField'), 'aria-label': t('removeField'), onclick: () => removeField(f) }, svgIcon(ICONS.trash)) : null);
  const onFocus = () => setCurrent(f.id, 'form');
  card.addEventListener('focusin', onFocus);
  card.addEventListener('focusout', () => setTimeout(() => { if (!card.contains(document.activeElement)) card.classList.remove('focused'); }, 0));
  const set = (v) => { S.values[f.id] = v; onValueChanged(f); };
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
  card.append(el('div', { class: 'snippet' }, el('canvas')));

  if (f.type === 'radio') {
    const group = el('div', { class: 'pills', role: 'radiogroup', 'aria-label': f.label });
    const name = 'r-' + idx;
    f.options.forEach((o, i) => {
      const r = el('input', { type: 'radio', name, value: o.value, id: i === 0 ? inputId : null, onchange: () => set(o.value) });
      r.checked = v === o.value;
      // allow un-selecting by tapping the selected pill again
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
      const inp = el('input', { class: 'input', id: inputId, list: dl.id, value: displayOf(f, v), oninput: (e) => set(valueOf(f, e.target.value)) });
      card.append(inp, dl);
    } else {
      const sel = el('select', { id: inputId, onchange: (e) => set(e.target.value) },
        el('option', { value: '', text: t('choosePlaceholder') }),
        f.options.map((o) => el('option', { value: o.value, text: o.label })));
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

  // text-like
  const sugg = (memory[normLabel(f.label)] || []).filter(Boolean);
  const dl = sugg.length ? el('datalist', { id: 'dl-' + idx }, sugg.map((s) => el('option', { value: s }))) : null;
  let input;
  if (f.type === 'multiline') {
    input = el('textarea', { id: inputId, oninput: (e) => set(e.target.value), maxlength: f.maxLen || null, rows: Math.min(10, Math.max(3, Math.round((f.rect.h || 40) / 14))) });
    input.value = v || '';
  } else if (f.isDate) {
    input = el('input', { class: 'input', type: 'date', id: inputId, value: v || '', autocomplete: f.autocomplete || null, oninput: (e) => set(e.target.value) });
  } else {
    input = el('input', {
      class: 'input', id: inputId, type: f.inputType || 'text', value: v || '', list: dl ? dl.id : null,
      autocomplete: f.autocomplete || (dl ? 'off' : null), inputmode: f.inputmode || null, maxlength: f.maxLen || null,
      enterkeyhint: 'next', spellcheck: f.autocomplete ? 'false' : null,
      oninput: (e) => set(e.target.value),
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); focusNext(f); } });
  }
  if (f.dateChip && !f.isDate) {
    const today = el('button', { class: 'chip', type: 'button', text: t('today'), onclick: () => { input.value = formatDate(new Date().toISOString().slice(0, 10), getLang() === 'nb' ? 'dd.mm.yyyy' : 'mm/dd/yyyy'); set(input.value); } });
    card.append(el('div', { class: 'input-row' }, input, today));
  } else card.append(input);
  if (dl) card.append(dl);
  if (f.maxLen && f.type !== 'multiline') {
    const counter = el('div', { class: 'counter', text: `${(v || '').length}/${f.maxLen}` });
    input.addEventListener('input', () => { counter.textContent = `${input.value.length}/${f.maxLen}`; });
    card.append(counter);
  }
  return card;
}

const displayOf = (f, v) => { const o = f.options.find((x) => x.value === v); return o ? o.label : (v || ''); };
const valueOf = (f, label) => { const o = f.options.find((x) => x.label === label); return o ? o.value : label; };

function focusNext(f) {
  const i = S.fields.indexOf(f);
  for (let k = i + 1; k < S.fields.length; k++) {
    const c = $(`.field[data-id="${CSS.escape(S.fields[k].id)}"] input:not([type=radio]):not([type=checkbox]), .field[data-id="${CSS.escape(S.fields[k].id)}"] textarea, .field[data-id="${CSS.escape(S.fields[k].id)}"] select`);
    if (c) { c.focus(); return; }
  }
  document.activeElement?.blur();
}

function signatureWidget(f, inputId, set) {
  const wrap = el('div');
  const v = S.values[f.id];
  const typed = (v && typeof v === 'object' && 'text' in v) || (typeof v === 'string' && v);
  const canType = f.type !== 'signature';
  let mode = typed && canType ? 'type' : 'draw';
  const render = () => {
    wrap.innerHTML = '';
    if (mode === 'type') {
      const cur = S.values[f.id];
      const inp = el('input', { class: 'input', id: inputId, value: (cur && cur.text) || (typeof cur === 'string' ? cur : ''), autocomplete: 'name', oninput: (e) => set({ text: e.target.value }) });
      inp.style.fontStyle = 'italic';
      wrap.append(inp, el('div', { class: 'sig-actions' }, el('button', { class: 'chip', type: 'button', text: t('drawInstead'), onclick: () => { mode = 'draw'; set(''); render(); } })));
      return;
    }
    const canvas = el('canvas', { id: inputId, tabindex: 0, 'aria-label': t('signHere') });
    const pad = el('div', { class: 'sig-pad' }, el('div', { class: 'sig-line' }), canvas, el('span', { class: 'sig-ph', text: t('signHere') }));
    const actions = el('div', { class: 'sig-actions' },
      el('button', { class: 'chip', type: 'button', text: t('clear'), onclick: () => { clear(); set(''); } }),
      canType ? el('button', { class: 'chip', type: 'button', text: t('typeInstead'), onclick: () => { mode = 'type'; set({ text: '' }); render(); } }) : null);
    wrap.append(pad, actions);
    let ctx, strokes = [], drawing = false, ratio = 1;
    const setup = () => {
      const r = canvas.getBoundingClientRect();
      ratio = Math.max(2, devicePixelRatio || 1);
      canvas.width = Math.max(10, r.width * ratio); canvas.height = 150 * ratio;
      ctx = canvas.getContext('2d');
      ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111a3a'; ctx.lineWidth = 2.4 * ratio;
      const cur = S.values[f.id];
      if (cur && cur.sig) { const img = new Image(); img.onload = () => { ctx.drawImage(img, 0, 0, canvas.width, canvas.height); }; img.src = cur.sig; pad.querySelector('.sig-ph').hidden = true; }
    };
    const clear = () => { strokes = []; ctx && ctx.clearRect(0, 0, canvas.width, canvas.height); pad.querySelector('.sig-ph').hidden = false; };
    const pos = (e) => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) * ratio, (e.clientY - r.top) * ratio]; };
    let last = null;
    canvas.addEventListener('pointerdown', (e) => { if (!ctx) setup(); drawing = true; canvas.setPointerCapture(e.pointerId); last = pos(e); pad.querySelector('.sig-ph').hidden = true; setCurrent(f.id, 'form'); });
    canvas.addEventListener('pointermove', (e) => {
      if (!drawing) return;
      const p = pos(e);
      ctx.beginPath(); ctx.moveTo(last[0], last[1]);
      ctx.quadraticCurveTo(last[0], last[1], (last[0] + p[0]) / 2, (last[1] + p[1]) / 2);
      ctx.lineTo(p[0], p[1]); ctx.stroke();
      last = p; strokes.push(p);
    });
    const end = () => {
      if (!drawing) return;
      drawing = false;
      if (strokes.length) set({ sig: trimmedPng(canvas) });
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    requestAnimationFrame(setup);
  };
  render();
  return wrap;
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

function onValueChanged(f) {
  updateOverlayFor(f);
  refreshFilledState(f);
  updateHeader();
  scheduleDraft();
}
function refreshFilledState(only) {
  for (const f of only ? [only] : S.fields) {
    const card = $(`.field[data-id="${CSS.escape(f.id)}"]`);
    if (card) card.classList.toggle('is-filled', hasValue(f, S.values[f.id]));
  }
}

function removeField(f) {
  S.fields = S.fields.filter((x) => x !== f);
  delete S.values[f.id];
  if (S.currentId === f.id) S.currentId = null;
  renderForm(); renderPagePanel(); updateHeader(); scheduleDraft();
}

// ------------------------------------------------------------------ current field + page panel
function setCurrent(id, from) {
  S.currentId = id;
  $$('.field.focused').forEach((c) => { if (c.dataset.id !== id) c.classList.remove('focused'); });
  const card = $(`.field[data-id="${CSS.escape(id)}"]`);
  if (card) card.classList.add('focused');
  const f = fieldById(id);
  if (!f) return;
  const page = f.widgets.length ? f.widgets[0].page : f.page;
  if (page !== S.currentPage) showPage(page); else highlightOverlay();
  if (from === 'form' && !isMobile()) scrollOverlayIntoView(f);
  if (from === 'form' && isMobile() && card) drawSnippet(f, card);
}

function locate(f) {
  setCurrent(f.id, 'locate');
  if (isMobile()) setTab('pages');
  requestAnimationFrame(() => scrollOverlayIntoView(f, true));
}

function scrollOverlayIntoView(f, smooth) {
  const node = $(`.ov[data-id="${CSS.escape(f.id)}"]`);
  const stage = $('#pageStage');
  if (!node || !stage) return;
  if (isMobile() && $('.workspace').dataset.tab === 'pages') { node.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' }); return; }
  const top = node.offsetTop - stage.clientHeight / 2 + node.offsetHeight / 2;
  stage.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
}

async function getPageCanvas(i) {
  if (S.renderCache.has(i)) { const c = S.renderCache.get(i); S.renderCache.delete(i); S.renderCache.set(i, c); return c; }
  const pg = S.pages[i];
  const scale = Math.min(3, Math.max(1.5, (devicePixelRatio || 1) * 1.25));
  const vp = pg.page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  // hide the PDF's own widgets so our overlay preview is the only thing shown on top
  await pg.page.render({ canvasContext: ctx, canvas, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
  canvas._scale = scale;
  S.renderCache.set(i, canvas);
  while (S.renderCache.size > 4) S.renderCache.delete(S.renderCache.keys().next().value);
  return canvas;
}

let showToken = 0;
async function showPage(i) {
  if (!S.pages.length) return;
  i = Math.max(0, Math.min(S.pages.length - 1, i));
  S.currentPage = i;
  $('#pageLabel').textContent = t('pageOf', { a: i + 1, b: S.pages.length });
  $('#prevPage').disabled = i === 0;
  $('#nextPage').disabled = i === S.pages.length - 1;
  const token = ++showToken;
  const src = await getPageCanvas(i);
  if (token !== showToken) return;
  const c = $('#pageCanvas');
  c.width = src.width; c.height = src.height;
  c.getContext('2d').drawImage(src, 0, 0);
  const vp = S.pages[i].viewport;
  $('#pageWrap').style.aspectRatio = `${vp.width} / ${vp.height}`;
  fitPage();
  renderPagePanel();
}

function fitPage() {
  const vp = S.pages[S.currentPage]?.viewport;
  if (!vp) return;
  const stage = $('#pageStage');
  const avail = stage.clientWidth - 20;
  $('#pageWrap').style.width = Math.max(200, avail) + 'px';
}

function sizeOverlay() {
  const vp = S.pages[S.currentPage]?.viewport;
  if (!vp) return;
  const w = $('#pageWrap').clientWidth;
  $('#overlay').style.setProperty('--k', String(w / vp.width));
  if ($('#pageStage').clientWidth - 20 > 0 && Math.abs($('#pageWrap').clientWidth - ($('#pageStage').clientWidth - 20)) > 2) fitPage();
}
window.addEventListener('resize', () => { fitPage(); sizeOverlay(); });

function renderPagePanel() {
  const ov = $('#overlay');
  ov.innerHTML = '';
  const pg = S.pages[S.currentPage];
  if (!pg) return;
  const vp = pg.viewport;
  sizeOverlay();
  for (const f of S.fields) {
    const boxes = f.type === 'radio' ? f.options.map((o) => ({ r: o.widget.rect, p: o.widget.page, opt: o.value })) : f.widgets.length ? f.widgets.map((w) => ({ r: w.rect, p: w.page })) : [{ r: f.rect, p: f.page }];
    boxes.forEach((b, bi) => {
      if (b.p !== S.currentPage) return;
      const node = el('div', { class: `ov ${f.source === 'flat' ? 'flat' : ''} ${f.type === 'multiline' ? 'multi' : ''} ${f.type === 'checkbox' || f.type === 'radio' ? 'check' : ''}`, dataset: { id: f.id, opt: b.opt ?? '', bi } });
      Object.assign(node.style, { left: (b.r.x / vp.width) * 100 + '%', top: (b.r.y / vp.height) * 100 + '%', width: (b.r.w / vp.width) * 100 + '%', height: (b.r.h / vp.height) * 100 + '%' });
      if (f.source === 'flat') node.append(el('div', { class: 'handle' }));
      node.title = f.label;
      ov.append(node);
      paintOverlay(node, f, b.r);
    });
  }
  highlightOverlay();
}

function paintOverlay(node, f, r) {
  const v = S.values[f.id];
  const filled = hasValue(f, v);
  node.classList.toggle('filled', filled);
  [...node.childNodes].forEach((c) => { if (!c.classList || !c.classList.contains('handle')) c.remove(); });
  let content = null;
  const fs = Math.max(6, Math.min(11, r.h * 0.68));
  node.style.fontSize = `calc(var(--k) * ${f.type === 'multiline' ? Math.min(11, Math.max(7, r.h / 3)) : fs}px)`;
  node.style.padding = '0 calc(var(--k) * 2px)';
  if (f.type === 'checkbox') content = v ? '✔' : '';
  else if (f.type === 'radio') content = v != null && v === node.dataset.opt ? '●' : '';
  else if (v && typeof v === 'object' && v.sig) { content = el('img', { src: v.sig, alt: '' }); }
  else if (v && typeof v === 'object' && 'text' in v) content = v.text;
  else if (Array.isArray(v)) content = v.map((x) => displayOf(f, x)).join(', ');
  else if (f.type === 'select') content = displayOf(f, v);
  else if (f.isDate && v) content = formatDate(v, f.dateFormat);
  else content = v || '';
  if (f.type === 'checkbox' || f.type === 'radio') node.style.fontSize = `calc(var(--k) * ${Math.min(r.w, r.h) * 0.85}px)`;
  if (content) node.prepend(content.nodeType ? content : document.createTextNode(content));
}

function updateOverlayFor(f) {
  $$(`.ov[data-id="${CSS.escape(f.id)}"]`).forEach((node) => {
    const bi = +node.dataset.bi;
    const r = f.type === 'radio' ? f.options[bi].widget.rect : f.widgets.length ? f.widgets[bi].rect : f.rect;
    paintOverlay(node, f, r);
  });
}

function highlightOverlay() {
  $$('.ov').forEach((n) => n.classList.toggle('current', n.dataset.id === S.currentId));
}

async function drawSnippet(f, card) {
  const sn = card.querySelector('.snippet');
  if (!sn) return;
  const page = f.widgets.length ? f.widgets[0].page : f.page;
  const src = await getPageCanvas(page);
  const vp = S.pages[page].viewport;
  const rr = f.type === 'radio' ? f.options.reduce((a, o) => union(a, o.widget.rect), null) : f.rect;
  const padX = 70, padY = 26;
  const x = Math.max(0, rr.x - padX), y = Math.max(0, rr.y - padY);
  const w = Math.min(vp.width - x, rr.w + padX * 2), h = Math.min(vp.height - y, rr.h + padY * 2);
  const k = src._scale;
  const c = sn.querySelector('canvas');
  c.width = Math.round(w * k); c.height = Math.round(h * k);
  const ctx = c.getContext('2d');
  ctx.drawImage(src, x * k, y * k, w * k, h * k, 0, 0, c.width, c.height);
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#2f5bea';
  ctx.lineWidth = 2.5 * (k / 1.5);
  ctx.strokeRect((rr.x - x) * k, (rr.y - y) * k, rr.w * k, rr.h * k);
  sn.classList.add('has');
}
const union = (a, b) => (a ? { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.max(a.x + a.w, b.x + b.w) - Math.min(a.x, b.x), h: Math.max(a.y + a.h, b.y + b.h) - Math.min(a.y, b.y) } : { ...b });

// overlay interactions: tap to jump, drag/resize detected boxes, add new fields
function setupPageInteractions() {
  const ov = $('#overlay');
  let drag = null;
  const toPt = (e) => {
    const r = ov.getBoundingClientRect();
    const vp = S.pages[S.currentPage].viewport;
    return { x: ((e.clientX - r.left) / r.width) * vp.width, y: ((e.clientY - r.top) / r.height) * vp.height };
  };
  ov.addEventListener('pointerdown', (e) => {
    if (S.addMode) return;
    const node = e.target.closest('.ov');
    if (!node) return;
    const f = fieldById(node.dataset.id);
    if (!f) return;
    const resizing = e.target.classList.contains('handle');
    const canDrag = f.source === 'flat' && (node.classList.contains('current') || !isMobile());
    drag = { f, node, start: toPt(e), rect: { ...f.rect }, moved: false, resizing, canDrag, id: e.pointerId };
    if (canDrag) { node.setPointerCapture(e.pointerId); e.preventDefault(); }
  });
  ov.addEventListener('pointermove', (e) => {
    if (!drag || !drag.canDrag || drag.id !== e.pointerId) return;
    const p = toPt(e);
    const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
    if (!drag.moved && Math.hypot(dx, dy) < 3) return;
    drag.moved = true;
    const vp = S.pages[S.currentPage].viewport;
    const r = drag.f.rect;
    if (drag.resizing) { r.w = Math.max(8, drag.rect.w + dx); r.h = Math.max(6, drag.rect.h + dy); }
    else { r.x = Math.min(vp.width - 4, Math.max(0, drag.rect.x + dx)); r.y = Math.min(vp.height - 4, Math.max(0, drag.rect.y + dy)); }
    Object.assign(drag.node.style, { left: (r.x / vp.width) * 100 + '%', top: (r.y / vp.height) * 100 + '%', width: (r.w / vp.width) * 100 + '%', height: (r.h / vp.height) * 100 + '%' });
    paintOverlay(drag.node, drag.f, r);
  });
  const end = (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.moved) { scheduleDraft(); return; }
    // a tap: select the field, a second tap jumps to it in the form
    if (S.currentId === d.f.id || !isMobile()) {
      setCurrent(d.f.id, 'page');
      if (isMobile()) setTab('form');
      focusCard(d.f, d.node.dataset.opt);
    } else setCurrent(d.f.id, 'page');
  };
  ov.addEventListener('pointerup', end);
  ov.addEventListener('pointercancel', () => { drag = null; });
  ov.addEventListener('click', (e) => {
    if (!S.addMode) return;
    const p = toPt(e);
    const vp = S.pages[S.currentPage].viewport;
    S.customCount++;
    const isCheck = S.addMode === 'checkbox';
    const rect = isCheck ? { x: p.x - 6, y: p.y - 6, w: 12, h: 12 } : { x: p.x - 4, y: p.y - 9, w: Math.min(200, vp.width - p.x - 10), h: 17 };
    const f = finishFlatFields([{ type: isCheck ? 'checkbox' : 'text', rect, page: S.currentPage, label: t('addedField', { n: S.customCount }) }])[0];
    f.custom = true;
    S.fields.push(f);
    S.values[f.id] = isCheck ? true : '';
    sortFields(S.fields);
    setAddMode(null);
    renderForm(); renderPagePanel(); updateHeader(); scheduleDraft();
    setCurrent(f.id, 'page');
    if (!isCheck) { if (isMobile()) setTab('form'); focusCard(f); }
  });
}

function focusCard(f, opt) {
  const card = $(`.field[data-id="${CSS.escape(f.id)}"]`);
  if (!card) return;
  card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash');
  const target = opt ? card.querySelector(`input[value="${CSS.escape(opt)}"]`) : card.querySelector('textarea, select, input:not([type=radio]), canvas');
  setTimeout(() => target && target.focus({ preventScroll: true }), 250);
}

function setAddMode(mode) {
  S.addMode = mode;
  $('#addMode').hidden = !mode;
  $('#addBtn').hidden = !!mode;
  $$('[data-add]').forEach((b) => b.classList.toggle('active', b.dataset.add === mode));
  $('#overlay').classList.toggle('adding', !!mode);
  $('#pageStage').classList.toggle('adding', !!mode);
  $('#pagesHint').textContent = mode ? t('addHint') : t('pagesTitle');
}

// ------------------------------------------------------------------ drafts & memory
let draftTimer = null;
function scheduleDraft() { clearTimeout(draftTimer); draftTimer = setTimeout(saveDraftNow, 600); }
function saveDraftNow() {
  clearTimeout(draftTimer);
  if (!S.fingerprint || !S.fields.length) return;
  const anyValue = S.fields.some((f) => hasValue(f, S.values[f.id]) && !sameInitial(f));
  const flat = S.fields.filter((f) => f.source === 'flat').map((f) => ({ id: f.id, type: f.type, label: f.label, page: f.page, rect: f.rect, custom: !!f.custom, context: f.context, signature: !!f.signature, line: f.line }));
  if (!anyValue && !flat.some((f) => f.custom)) return;
  store.set('ff:draft:' + S.fingerprint, { t: Date.now(), values: S.values, flat: S.isFlat || flat.length ? flat : null });
  // keep only the 12 most recent drafts
  const keys = Object.keys(localStorage).filter((k) => k.startsWith('ff:draft:'));
  if (keys.length > 12) keys.map((k) => [k, store.get(k, {}).t || 0]).sort((a, b) => a[1] - b[1]).slice(0, keys.length - 12).forEach(([k]) => store.del(k));
}
function sameInitial(f) { return JSON.stringify(S.values[f.id] ?? '') === JSON.stringify(f.initial ?? ''); }

function maybeOfferRestore() {
  const d = store.get('ff:draft:' + S.fingerprint, null);
  if (!d || !d.values) return;
  const box = el('div', { class: 'notice info' }, el('div', { class: 'grow' },
    el('h4', { text: t('restoreTitle') }), el('div', { text: t('restoreText') }),
    el('div', { class: 'row' },
      el('button', { class: 'btn primary small', type: 'button', text: t('restore'), onclick: () => { restoreDraft(d); box.remove(); } }),
      el('button', { class: 'btn ghost small', type: 'button', text: t('dismiss'), onclick: () => box.remove() }))));
  $('#notices').prepend(box);
}
function restoreDraft(d) {
  if (d.flat) {
    const acro = S.fields.filter((f) => f.source === 'acro');
    const flat = d.flat.map((x) => {
      const f = finishFlatFields([{ ...x }])[0];
      Object.assign(f, { id: x.id, label: x.label, custom: x.custom, context: x.context, signature: x.signature, line: x.line });
      return f;
    });
    S.fields = sortFields([...acro, ...flat]);
    S.customCount = flat.filter((f) => f.custom).length;
  }
  for (const f of S.fields) if (d.values[f.id] !== undefined) S.values[f.id] = d.values[f.id];
  renderForm(); renderPagePanel(); updateHeader();
}
function rememberAnswers() {
  const mem = store.get('ff:memory', {});
  for (const f of S.fields) {
    if (!['text', 'multiline'].includes(f.type) || f.signature || f.isDate) continue;
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
function formPages() {
  return new Set(S.fields.flatMap((f) => (f.widgets.length ? f.widgets.map((w) => w.page) : [f.page])));
}
async function build(mode = 'all', flatten = false) {
  return buildPdf({
    bytes: S.bytes, password: S.password, encrypted: S.encrypted, fields: S.fields, values: S.values,
    viewports: S.pages.map((p) => p.viewport), mode, flatten,
  });
}

async function preview() {
  busy(t('building'));
  try {
    const { bytes, warnings } = await build('all', false);
    const ptask = openPdf(bytes, S.password);
    const doc = await ptask.promise;
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
    ptask.destroy();
  } catch (e) {
    console.error(e);
    busy(false);
    toast(t('error', { msg: e.message || e }), 'warn', 6000);
  }
}

async function openSave() {
  const missing = S.fields.filter((f) => f.required && !hasValue(f, S.values[f.id]));
  if (missing.length) {
    const ok = await confirmBox(t('missingRequired', { n: missing.length }), t('saveAnyway'), t('goToField'));
    if (!ok) { if (isMobile()) setTab('form'); setCurrent(missing[0].id, 'page'); focusCard(missing[0]); return; }
  }
  const d = $('#saveDlg');
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
  d.showModal();
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
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js?v=' + VERSION).catch(() => {});
  }
  let deferred = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; $('#installBtn').hidden = false; });
  $('#installBtn').addEventListener('click', async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; $('#installBtn').hidden = true; });
  window.addEventListener('appinstalled', () => { $('#installBtn').hidden = true; });
  // files shared to the installed app (Android share sheet) or opened with it (desktop)
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
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (p) => { if (p.files && p.files[0]) loadFile(await p.files[0].getFile()); });
  }
}

boot();
