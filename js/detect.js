// Field detection.
// 1) Real (AcroForm) fields are read from the PDF's widget annotations.
// 2) "Flat" forms (printed-style, no real fields) are analysed visually: the page is rendered
//    and scanned for blank lines, empty boxes, table cells and checkbox squares, and the text
//    layer is used for underscores ("Name: _____"), "Label:" blanks and ☐ glyphs.
// All geometry here is in "display space": page at scale 1, origin top-left, y pointing down.
import { pdfjsLib } from './pdf.js';
import { t } from './i18n.js';

const SIG_RE = /signat|signer|underskrift|sign here|autograph|unterschrift/i;
const DATE_LABEL_RE = /\b(date|dato|datum|fecha|data)\b|født|birth|fødsels/i;

// ---------------------------------------------------------------- text layer
// Rough Helvetica-ish widths used to place underscore runs inside a text item.
function charW(c) {
  if (c === '_') return 0.556;
  if (c === ' ') return 0.278;
  if (/[il.,:;'|!]/.test(c)) return 0.25;
  if (/[mwMW]/.test(c)) return 0.85;
  if (/[A-Z]/.test(c)) return 0.67;
  return 0.52;
}

export async function getSegments(page, viewport) {
  const tc = await page.getTextContent();
  const raw = [];
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) continue;
    const m = pdfjsLib.Util.transform(viewport.transform, it.transform);
    const size = Math.hypot(m[2], m[3]) || it.height || 10;
    if (Math.abs(m[1]) > Math.abs(m[0]) * 0.2) continue; // rotated text: ignore for labels
    const x = m[4], base = m[5];
    const width = it.width * viewport.scale;
    // split into underscore runs (blanks) and normal text, distributing width by char weights
    const parts = it.str.split(/(_{3,}|\.{6,}|…{3,})/);
    const total = [...it.str].reduce((s, c) => s + charW(c), 0) || 1;
    let cx = x;
    for (const p of parts) {
      if (!p) continue;
      const w = width * ([...p].reduce((s, c) => s + charW(c), 0) / total);
      const isBlank = /^(_{3,}|\.{6,}|…{3,})$/.test(p);
      if (isBlank || p.trim()) {
        raw.push({ str: p, x1: cx, x2: cx + w, base, size, y1: base - size * 0.8, y2: base + size * 0.22, kind: isBlank ? 'blank' : 'text' });
      }
      cx += w;
    }
  }
  // merge neighbouring text pieces on the same line into segments
  raw.sort((a, b) => (Math.abs(a.base - b.base) > Math.min(a.size, b.size) * 0.35 ? a.base - b.base : a.x1 - b.x1));
  const segs = [];
  for (const r of raw) {
    const last = segs[segs.length - 1];
    if (last && r.kind === 'text' && last.kind === 'text' &&
        Math.abs(last.base - r.base) < Math.min(last.size, r.size) * 0.35 &&
        r.x1 - last.x2 < Math.max(last.size, r.size) * 0.9 && r.x1 - last.x2 > -last.size) {
      const gap = r.x1 - last.x2;
      last.str += (gap > r.size * 0.12 && !/\s$/.test(last.str) && !/^\s/.test(r.str) ? ' ' : '') + r.str;
      last.x2 = Math.max(last.x2, r.x2);
      last.y1 = Math.min(last.y1, r.y1); last.y2 = Math.max(last.y2, r.y2);
      last.size = Math.max(last.size, r.size);
    } else segs.push({ ...r });
  }
  for (const s of segs) s.str = s.str.replace(/\s+/g, ' ').trim();
  return segs.filter((s) => s.str);
}

// ---------------------------------------------------------------- labels
export function cleanLabel(s) {
  if (!s) return '';
  return s
    .replace(/_{2,}|\.{4,}|…+/g, ' ')
    .replace(/[\s:*]+$/g, '')
    .replace(/^[\s:•\-–]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90);
}

const vOverlap = (a1, a2, b1, b2) => Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));

export function findLabel(rect, segs, mode = 'text', exclude = new Set()) {
  const { x, y, w, h } = rect;
  // footnote markers, row numbers and lone symbols make poor labels
  const textSegs = segs.filter((s) => s.kind === 'text' && !exclude.has(s) && !/^[\(\[]?[\d\W_]{1,3}[\)\]]?$/.test(s.str));
  const inRow = (s) => vOverlap(s.y1, s.y2, y - 2, y + h + 3) >= Math.min(s.y2 - s.y1, h) * 0.35 || (s.base >= y - 1 && s.base <= y + h + 4);

  let left = null, leftScore = Infinity;
  for (const s of textSegs) {
    const g = x - s.x2;
    if (g < -4 || g > 230 || !inRow(s)) continue;
    if (g < leftScore) { leftScore = g; left = s; }
  }
  let right = null, rightScore = Infinity;
  for (const s of textSegs) {
    const g = s.x1 - (x + w);
    if (g < -2 || g > 70) continue;
    const cy = y + h / 2;
    if (!(s.y1 - 4 <= cy && cy <= s.y2 + 4)) continue;
    if (g < rightScore) { rightScore = g; right = s; }
  }
  let above = null, aboveScore = Infinity;
  for (const s of textSegs) {
    const vg = y - s.y2;
    if (vg < -3 || vg > 30) continue;
    if (!(s.x1 < x + w && s.x2 > x - 12)) continue;
    const sc = vg * 2 + Math.abs(s.x1 - x) * 0.15;
    if (sc < aboveScore) { aboveScore = sc; above = s; }
  }
  if (mode === 'check') {
    if (right) return { label: right.str, seg: right, context: left ? left.str : '' };
    if (left && leftScore < 120) return { label: left.str, seg: left, context: '' };
    if (above) return { label: above.str, seg: above, context: '' };
    return { label: '', seg: null, context: '' };
  }
  // small caption printed right under a blank ("name", "street", "postcode")
  let below = null, belowScore = Infinity;
  if (segs._median == null) { const z = segs.filter((q) => q.kind === 'text').map((q) => q.size).sort((a, b) => a - b); segs._median = z.length ? z[z.length >> 1] : 10; }
  if (h < 30) for (const s of textSegs) {
    const vg = s.y1 - (y + h);
    if (vg < -2.5 || vg > 7 || s.size > Math.min(9, segs._median * 0.92)) continue;
    if (s.x1 < x - 6 || s.x1 > x + Math.max(24, w * 0.4) || s.x2 > x + w + 10) continue;
    const sc = vg + Math.abs(s.x1 - x) * 0.05;
    if (sc < belowScore) { belowScore = sc; below = s; }
  }
  if (below && mode !== 'check') {
    const lead = left && leftScore < 60 && left.size > below.size + 0.4 ? cleanLabel(left.str) : '';
    return { label: lead ? `${lead} – ${below.str}` : below.str, seg: below, context: '' };
  }
  let pick = null;
  if (left && leftScore < 170 && (!above || leftScore <= aboveScore * 1.5 + 25)) pick = left;
  else if (above) pick = above;
  else if (left) pick = left;
  else if (mode === 'any' && right) pick = right;
  return { label: pick ? pick.str : '', seg: pick, context: '' };
}

function prettyName(name) {
  if (!name) return '';
  let s = name.split('.').filter(Boolean).pop() || name;
  s = s.replace(/\[\d+\]/g, '').replace(/[_\-]+/g, ' ').replace(/([a-zæøå])([A-ZÆØÅ])/g, '$1 $2').trim();
  if (/^(f|fld|field|text|txt|tf|tb|check ?box|cb|chk|radio|rb|button|btn|dropdown|combo|list|undefined)?\s*[\d\s]*$/i.test(s)) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------- hints for the HTML input
export function inputHints(label) {
  const l = (label || '').toLowerCase();
  const r = (re) => re.test(l);
  if (r(/e-?mail|e-?post|epost/)) return { autocomplete: 'email', type: 'email', inputmode: 'email' };
  if (r(/phone|telefon|\btlf|mobil|\btel\b|cell/)) return { autocomplete: 'tel', type: 'tel', inputmode: 'tel' };
  if (r(/first name|given name|fornavn|forename/)) return { autocomplete: 'given-name' };
  if (r(/last name|surname|family name|etternavn/)) return { autocomplete: 'family-name' };
  if (r(/date of birth|birth ?date|fødselsdato|født|dob\b/)) return { autocomplete: 'bday', date: true };
  if (r(/postal|zip|post ?code|postn|postnr|postnummer/)) return { autocomplete: 'postal-code', inputmode: 'numeric' };
  if (r(/poststed|\bcity\b|\btown\b|\bby\b|kommune/)) return { autocomplete: 'address-level2' };
  if (r(/country|\bland\b|nasjonalitet/)) return { autocomplete: 'country-name' };
  if (r(/address|adresse|street|gate|\bvei\b/)) return { autocomplete: 'street-address' };
  if (r(/company|firma|organi[sz]ation|employer|arbeidsgiver|bedrift/)) return { autocomplete: 'organization' };
  if (r(/fødselsnummer|personnummer|\bssn\b|org\.? ?n|kontonummer|account no|\biban\b|\bamount\b|beløp|\bsum\b|antall|number|nummer|\bnr\b/)) return { inputmode: 'numeric' };
  if (r(/full name|^navn$|^name$|your name|^navn\b|^name\b|ditt navn/)) return { autocomplete: 'name' };
  if (DATE_LABEL_RE.test(l)) return { date: true };
  return {};
}

// ---------------------------------------------------------------- AcroForm fields
export function toViewportRect(vp, r) {
  const [x1, y1] = vp.convertToViewportPoint(r[0], r[1]);
  const [x2, y2] = vp.convertToViewportPoint(r[2], r[3]);
  return [x1, y1, x2, y2];
}

export async function readAcroFields(doc, pages) {
  const fieldObjects = (await doc.getFieldObjects().catch(() => null)) || {};
  const byId = new Map();
  for (const arr of Object.values(fieldObjects)) for (const o of arr) if (o.id) byId.set(o.id, o);

  const groups = new Map(); // fieldName -> field
  const order = [];
  for (const pg of pages) {
    const anns = await pg.page.getAnnotations({ intent: 'display' });
    for (const a of anns) {
      if (a.subtype !== 'Widget' || !a.fieldName) continue;
      if (a.pushButton || a.hidden || a.readOnly) continue;
      const vr = toViewportRect(pg.viewport, a.rect);
      const rect = { x: Math.min(vr[0], vr[2]), y: Math.min(vr[1], vr[3]), w: Math.abs(vr[2] - vr[0]), h: Math.abs(vr[3] - vr[1]) };
      if (rect.w < 1 || rect.h < 1) continue;
      const fo = byId.get(a.id) || {};
      const widget = { id: a.id, page: pg.index, rect, exportValue: a.exportValue ?? a.buttonValue };
      let f = groups.get(a.fieldName);
      if (f) {
        f.widgets.push(widget);
        if (a.radioButton && a.buttonValue != null) f.options.push({ value: String(a.buttonValue), label: '', widget });
        continue;
      }
      let type = 'text';
      if (a.fieldType === 'Tx') type = a.multiLine ? 'multiline' : 'text';
      else if (a.fieldType === 'Btn') type = a.radioButton ? 'radio' : 'checkbox';
      else if (a.fieldType === 'Ch') type = a.combo ? 'select' : 'list';
      else if (a.fieldType === 'Sig') type = 'signature';
      else continue;
      f = {
        id: 'acro:' + a.fieldName,
        source: 'acro',
        name: a.fieldName,
        type,
        tooltip: (a.alternativeText || '').trim(),
        page: pg.index,
        rect,
        widgets: [widget],
        options: [],
        required: !!a.required,
        maxLen: a.maxLen || 0,
        comb: !!a.comb,
        editable: !!(a.combo && (a.fieldFlags & (1 << 18))),
        multiSelect: !!a.multiSelect,
        dateFormat: fo.datetimeFormat || dateFormatFromActions(fo.actions),
        initial: undefined,
      };
      if (type === 'radio' && a.buttonValue != null) f.options.push({ value: String(a.buttonValue), label: '', widget });
      if ((type === 'select' || type === 'list') && a.options) f.options = a.options.map((o) => ({ value: o.exportValue ?? o.displayValue, label: o.displayValue ?? o.exportValue }));
      // initial value
      if (type === 'text' || type === 'multiline') f.initial = typeof a.fieldValue === 'string' ? a.fieldValue : '';
      else if (type === 'checkbox') f.initial = a.fieldValue && a.fieldValue !== 'Off' && a.fieldValue === a.exportValue;
      else if (type === 'radio') f.initial = a.fieldValue && a.fieldValue !== 'Off' ? String(a.fieldValue) : '';
      else if (type === 'select') f.initial = Array.isArray(a.fieldValue) ? (a.fieldValue[0] ?? '') : (a.fieldValue ?? '');
      else if (type === 'list') f.initial = Array.isArray(a.fieldValue) ? a.fieldValue : (a.fieldValue ? [a.fieldValue] : []);
      if (type === 'checkbox') f.exportValue = a.exportValue;
      groups.set(a.fieldName, f);
      order.push(f);
    }
  }
  // checkbox groups sharing a name with several widgets behave like radios (one per export value)
  for (const f of order) {
    if (f.type === 'checkbox' && f.widgets.length > 1) {
      const vals = [...new Set(f.widgets.map((w) => String(w.exportValue)))];
      if (vals.length > 1) {
        f.type = 'radio';
        f.checkboxRadio = true;
        f.options = f.widgets.map((w) => ({ value: String(w.exportValue), label: '', widget: w }));
        f.initial = f.initial ? String(f.exportValue) : '';
      }
    }
  }
  return order;
}

function dateFormatFromActions(actions) {
  const js = actions && (actions.Format || actions.Keystroke);
  if (!js) return null;
  const m = String(js).match(/AFDate_(?:Format|Keystroke)Ex\(\s*["']([^"']+)["']/);
  if (m) return m[1];
  const n = String(js).match(/AFDate_(?:Format|Keystroke)\(\s*(\d+)/);
  if (n) return ['m/d', 'm/d/yy', 'mm/dd/yy', 'mm/yy', 'd-mmm', 'd-mmm-yy', 'dd-mmm-yy', 'yy-mm-dd', 'mmm-yy', 'mmmm-yy', 'mmm d, yyyy', 'mmmm d, yyyy', 'm/d/yy h:MM tt', 'm/d/yy HH:MM'][+n[1]] || null;
  return null;
}

export function labelAcroFields(fields, segsByPage) {
  // option labels for radios first, so they aren't reused as the question label
  const used = new Map();
  const markUsed = (p, s) => { if (!s) return; if (!used.has(p)) used.set(p, new Set()); used.get(p).add(s); };
  for (const f of fields) {
    if (f.type !== 'radio') continue;
    for (const o of f.options) {
      const segs = segsByPage[o.widget.page] || [];
      const r = findLabel(o.widget.rect, segs, 'check');
      o.label = cleanLabel(r.label) || prettyName(o.value) || o.value;
      markUsed(o.widget.page, r.seg);
    }
  }
  for (const f of fields) {
    if (f.type !== 'checkbox') continue;
    const segs = segsByPage[f.page] || [];
    const r = findLabel(f.rect, segs, 'check');
    f._near = cleanLabel(r.label);
    f._seg = r.seg;
    markUsed(f.page, r.seg);
  }
  let n = 0;
  for (const f of fields) {
    n++;
    const segs = segsByPage[f.page] || [];
    const ex = used.get(f.page) || new Set();
    let near = '';
    let context = '';
    if (f.type === 'checkbox') {
      near = f._near;
      const ctx = findLabel(f.rect, segs, 'text', ex);
      if (ctx.seg && ctx.seg !== f._seg) context = cleanLabel(ctx.label);
    } else if (f.type === 'radio') {
      const first = f.options[0]?.widget || f.widgets[0];
      near = cleanLabel(findLabel(first.rect, segs, 'text', ex).label);
    } else {
      near = cleanLabel(findLabel(f.rect, segs, 'text', ex).label);
    }
    const tip = cleanLabel(f.tooltip);
    const pretty = prettyName(f.name);
    if (tip && tip.length <= 70) { f.label = tip; if (near && near !== tip && f.type !== 'checkbox') f.hint = near; }
    else f.label = near || pretty || tip || t('fieldN', { n });
    if (tip && tip.length > 70) f.hint = f.tooltip.slice(0, 220);
    f.context = context && context !== f.label ? context : '';
    if (/\*\s*$/.test(f.tooltip || '')) f.required = true;
    if (f.type !== 'checkbox' && f.type !== 'radio' && SIG_RE.test(f.label) && (f.type === 'text' || f.type === 'signature') && f.rect.h >= 14) f.signature = true;
    if (f.type === 'signature') f.signature = true;
    finishHints(f);
    delete f._near; delete f._seg;
  }
}

function finishHints(f) {
  if (f.type === 'text' || f.type === 'multiline') {
    const h = inputHints(f.label);
    f.autocomplete = h.autocomplete || '';
    f.inputType = h.type || 'text';
    f.inputmode = h.inputmode || '';
    if (f.dateFormat && !/[hHMt]/.test(f.dateFormat)) f.isDate = true;
    else if (h.date) f.dateChip = true;
  }
}

// ---------------------------------------------------------------- flat form detection (visual)
async function renderForScan(page, scale) {
  const vp = page.getViewport({ scale });
  const w = Math.ceil(vp.width), h = Math.ceil(vp.height);
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  await page.render({ canvasContext: ctx, canvas, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.DISABLE }).promise;
  const img = ctx.getImageData(0, 0, w, h);
  const dark = new Uint8Array(w * h);
  const d = img.data;
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    dark[j] = lum < 185 ? 1 : 0;
  }
  if (canvas.width) { canvas.width = 0; canvas.height = 0; }
  return { dark, w, h };
}

function findLines(dark, w, h, S, horizontal, minLenPt, textBoxes) {
  const minLen = minLenPt * S;
  const maxThick = 3.2 * S;
  const outer = horizontal ? h : w;
  const inner = horizontal ? w : h;
  const at = horizontal ? (o, i) => dark[o * w + i] : (o, i) => dark[i * w + o];
  let active = []; // {a,b,start,last}
  const done = [];
  for (let o = 0; o < outer; o++) {
    const runs = [];
    let i = 0;
    while (i < inner) {
      if (at(o, i)) {
        const s = i;
        while (i < inner && at(o, i)) i++;
        // allow 1px gaps (anti-aliasing / dashed-ish)
        while (i + 2 < inner && !at(o, i) && at(o, i + 1)) { i++; while (i < inner && at(o, i)) i++; }
        if (i - s >= minLen) runs.push([s, i]);
      } else i++;
    }
    const next = [];
    for (const r of runs) {
      const m = active.find((l) => Math.abs(l.a - r[0]) <= 2 * S && Math.abs(l.b - r[1]) <= 2 * S && l.last === o - 1);
      if (m) { m.last = o; m.a = Math.min(m.a, r[0]); m.b = Math.max(m.b, r[1]); next.push(m); active = active.filter((x) => x !== m); }
      else next.push({ a: r[0], b: r[1], start: o, last: o });
    }
    for (const l of active) done.push(l);
    active = next;
  }
  done.push(...active);
  const lines = [];
  for (const l of done) {
    const thick = l.last - l.start + 1;
    if (thick > maxThick) continue;
    const pos = (l.start + l.last + 1) / 2 / S;
    const a = l.a / S, b = l.b / S;
    if (horizontal) {
      // ignore strokes that live inside text (letters, strike-through)
      if (textBoxes.some((tb) => a >= tb.x1 - 1 && b <= tb.x2 + 1 && pos > tb.y1 + 1 && pos < tb.y2 - 1)) continue;
      lines.push({ x1: a, x2: b, y: pos, t: thick / S });
    } else lines.push({ y1: a, y2: b, x: pos, t: thick / S });
  }
  return lines;
}

const area = (r) => r.w * r.h;
function overlapRatio(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return (ix * iy) / Math.max(1, Math.min(area(a), area(b)));
}

export async function detectFlatFields(pg, segs, avoidRects = []) {
  const { page, viewport, index } = pg;
  const PW = viewport.width, PH = viewport.height;
  const S = Math.min(2.2, 2400 / Math.max(PW, PH));
  const { dark, w, h } = await renderForScan(page, S);
  const textSegs = segs.filter((s) => s.kind === 'text');
  const textBoxes = textSegs.map((s) => ({ x1: s.x1, x2: s.x2, y1: s.y1, y2: s.y2 }));
  const H = findLines(dark, w, h, S, true, 5, textBoxes);
  const V = findLines(dark, w, h, S, false, 5, []);
  const out = [];
  const used = new Set();

  // --- checkbox squares
  const shortH = H.filter((l) => l.x2 - l.x1 >= 5 && l.x2 - l.x1 <= 26);
  for (const top of shortH) {
    if (used.has(top)) continue;
    const len = top.x2 - top.x1;
    const bot = shortH.find((b) => b !== top && !used.has(b) && b.y > top.y && Math.abs(b.x1 - top.x1) < 1.6 && Math.abs(b.x2 - top.x2) < 1.6 && (b.y - top.y) >= len * 0.6 && (b.y - top.y) <= len * 1.5);
    if (!bot) continue;
    const hasSide = (x) => V.some((v) => Math.abs(v.x - x) < 2 && v.y1 <= top.y + 2 && v.y2 >= bot.y - 2);
    if (!hasSide(top.x1) || !hasSide(top.x2)) continue;
    used.add(top); used.add(bot);
    out.push({ type: 'checkbox', rect: { x: top.x1, y: top.y, w: len, h: bot.y - top.y } });
  }
  const boxRects = out.map((o) => o.rect);
  const inBox = (v) => boxRects.some((r) => v.x >= r.x - 2 && v.x <= r.x + r.w + 2 && v.y1 >= r.y - 2 && v.y2 <= r.y + r.h + 2);
  const Vs = V.filter((v) => !inBox(v));
  const Hs = H.filter((l) => !used.has(l) && l.x2 - l.x1 >= 8);

  // --- cells (boxes and table cells)
  const cells = [];
  const sortedH = [...Hs].sort((a, b) => a.y - b.y);
  for (const top of sortedH) {
    const xs = [];
    for (const v of Vs) {
      if (v.x < top.x1 - 2 || v.x > top.x2 + 2) continue;
      if (v.y1 > top.y + 2.5 || v.y2 < top.y + 6) continue;
      if (!xs.some((x) => Math.abs(x.x - v.x) < 2)) xs.push(v);
    }
    xs.sort((a, b) => a.x - b.x);
    for (let i = 0; i + 1 < xs.length; i++) {
      const va = xs[i], vb = xs[i + 1];
      if (vb.x - va.x < 8) continue;
      const bottomLimit = Math.min(va.y2, vb.y2) + 2.5;
      const bot = sortedH.find((b) => b !== top && b.y > top.y + 6 && b.y <= bottomLimit && b.x1 <= va.x + 2.5 && b.x2 >= vb.x - 2.5);
      if (!bot) continue;
      const r = { x: va.x, y: top.y, w: vb.x - va.x, h: bot.y - top.y };
      if (r.w > PW * 0.96 || r.h > PH * 0.6 || r.h < 8) continue;
      if (cells.some((c) => Math.abs(c.x - r.x) < 2 && Math.abs(c.y - r.y) < 2 && Math.abs(c.w - r.w) < 2 && Math.abs(c.h - r.h) < 2)) continue;
      cells.push(r);
      used.add(top); used.add(bot);
      r._top = top; r._bot = bot;
    }
  }
  // drop cells that contain other cells (outer frames)
  const leafCells = cells.filter((c) => !cells.some((o) => o !== c && o.x >= c.x - 1 && o.y >= c.y - 1 && o.x + o.w <= c.x + c.w + 1 && o.y + o.h <= c.y + c.h + 1 && area(o) < area(c) * 0.9));
  const cellText = (c) => textSegs.filter((s) => {
    const cx = (s.x1 + s.x2) / 2, cy = (s.y1 + s.y2) / 2;
    return cx > c.x && cx < c.x + c.w && cy > c.y && cy < c.y + c.h;
  });
  const cellInfo = leafCells.map((c) => ({ c, texts: cellText(c) }));
  const tableFields = [];
  for (const { c, texts } of cellInfo) {
    if (boxRects.some((b) => overlapRatio(b, c) > 0.5)) continue;
    if (!texts.length) {
      // column header = text in the cell right above; row header = text in leftmost cell of this row
      const aboveCell = cellInfo.find((o) => o.texts.length && Math.abs(o.c.y + o.c.h - c.y) < 2.5 && Math.abs(o.c.x - c.x) < 3 && Math.abs(o.c.w - c.w) < 3);
      const rowHead = cellInfo.find((o) => o.texts.length && Math.abs(o.c.y - c.y) < 2.5 && Math.abs(o.c.h - c.h) < 2.5 && o.c.x < c.x && o.c.w < PW * 0.5);
      let label = '';
      let header = null;
      if (aboveCell) { label = aboveCell.texts.map((s) => s.str).join(' '); header = aboveCell; }
      else {
        // walk up the column through empty cells to find a header
        let cur = c;
        for (let k = 0; k < 40; k++) {
          const up = cellInfo.find((o) => Math.abs(o.c.y + o.c.h - cur.y) < 2.5 && Math.abs(o.c.x - cur.x) < 3 && Math.abs(o.c.w - cur.w) < 3);
          if (!up) break;
          if (up.texts.length) { label = up.texts.map((s) => s.str).join(' '); header = up; break; }
          cur = up.c;
        }
      }
      if (rowHead) label = label ? `${rowHead.texts.map((s) => s.str).join(' ')} – ${label}` : rowHead.texts.map((s) => s.str).join(' ');
      const inner = { x: c.x + 1.5, y: c.y + 1.5, w: c.w - 3, h: c.h - 3 };
      const f = { type: c.h >= 30 ? 'multiline' : 'text', rect: inner, label: cleanLabel(label), table: header && !rowHead ? header : null };
      if (!f.label) f.label = cleanLabel(findLabel(c, segs, 'text').label);
      tableFields.push(f);
    } else {
      // label inside the box (e.g. a small caption in the top-left) and empty space below / right
      const tb = texts.reduce((a, s) => ({ x1: Math.min(a.x1, s.x1), x2: Math.max(a.x2, s.x2), y1: Math.min(a.y1, s.y1), y2: Math.max(a.y2, s.y2) }), { x1: Infinity, x2: -Infinity, y1: Infinity, y2: -Infinity });
      const label = cleanLabel(texts.sort((a, b) => a.y1 - b.y1 || a.x1 - b.x1).map((s) => s.str).join(' '));
      const below = c.y + c.h - tb.y2;
      const rightSpace = c.x + c.w - tb.x2;
      const totalTextLen = texts.reduce((n, s) => n + s.str.length, 0);
      if (totalTextLen > 80) continue; // a paragraph, not a label
      // a column header (an empty cell of the same width sits right below it)
      if (cellInfo.some((o) => !o.texts.length && Math.abs(o.c.y - (c.y + c.h)) < 2.5 && Math.abs(o.c.x - c.x) < 3 && Math.abs(o.c.w - c.w) < 3)) continue;
      if (below >= 12) tableFields.push({ type: below >= 30 ? 'multiline' : 'text', rect: { x: c.x + 2, y: tb.y2 + 1, w: c.w - 4, h: below - 2.5 }, label });
      else if (rightSpace >= 45 && c.h >= 11 && tb.y1 - c.y < c.h * 0.6) tableFields.push({ type: 'text', rect: { x: tb.x2 + 4, y: c.y + 1.5, w: rightSpace - 6, h: c.h - 3 }, label });
    }
  }
  // number repeated table rows ("Make (row 2)")
  const byHeader = new Map();
  for (const f of tableFields) if (f.table) { if (!byHeader.has(f.table)) byHeader.set(f.table, []); byHeader.get(f.table).push(f); }
  for (const list of byHeader.values()) if (list.length > 1) list.sort((a, b) => a.rect.y - b.rect.y).forEach((f, i) => { f.label = `${f.label} (${t('row', { n: i + 1 })})`; });
  out.push(...tableFields);

  // --- free lines (blanks to write on)
  const isCellEdge = (l) => used.has(l);
  for (const l of H) {
    if (isCellEdge(l) || used.has(l)) continue;
    const len = l.x2 - l.x1;
    if (len < 24 || len > PW * 0.97) continue;
    // something written on/above it? then it's an underline or separator, not a blank
    const above = textSegs.filter((s) => s.y2 > l.y - 11 && s.y1 < l.y + 0.5 && vOverlap(s.x1, s.x2, l.x1, l.x2) > Math.min(len, s.x2 - s.x1) * 0.25);
    if (above.length) continue;
    const nearestAbove = textSegs.filter((s) => s.y2 <= l.y && vOverlap(s.x1, s.x2, l.x1, l.x2) > 2).reduce((m, s) => Math.max(m, s.y2), -Infinity);
    const topY = Math.max(l.y - 17, nearestAbove + 1);
    const rect = { x: l.x1, y: topY, w: len, h: l.y - topY - 0.5 };
    if (rect.h < 8) continue;
    out.push({ type: 'text', rect, line: true });
  }

  // --- underscore / dot-leader blanks from the text layer
  for (const s of segs) {
    if (s.kind !== 'blank') continue;
    const rect = { x: s.x1, y: s.base - Math.max(13, s.size * 1.25), w: s.x2 - s.x1, h: Math.max(13, s.size * 1.25) + 0.5 };
    out.push({ type: 'text', rect, line: true });
  }

  // --- ☐ glyph checkboxes
  for (const s of textSegs) {
    const idx = [...s.str].findIndex((c) => /[☐□❏❑○◯]/.test(c));
    if (idx < 0 || s.str.length > 60) continue;
    // find all boxes in the segment
    const chars = [...s.str];
    const tw = chars.reduce((a, c) => a + charW(c), 0) || 1;
    let cx = s.x1;
    chars.forEach((c) => {
      const cw = (s.x2 - s.x1) * (charW(c) / tw);
      if (/[☐□❏❑○◯]/.test(c)) out.push({ type: 'checkbox', rect: { x: cx, y: s.base - s.size * 0.75, w: Math.max(cw, s.size * 0.7), h: s.size * 0.8 }, glyph: true });
      cx += cw;
    });
  }

  // --- "Label:" followed by empty space
  const contentRight = Math.max(PW - 40, ...textSegs.map((s) => s.x2));
  for (const s of textSegs) {
    if (!/:\s*$/.test(s.str) || s.str.length > 45) continue;
    const y1 = s.base - s.size * 1.15, y2 = s.base + s.size * 0.35;
    const rightObstacle = [...textSegs.filter((o) => o !== s && o.x1 > s.x2 && vOverlap(o.y1, o.y2, y1, y2) > 1).map((o) => o.x1),
      ...out.filter((o) => o.rect.x >= s.x2 - 2 && vOverlap(o.rect.y, o.rect.y + o.rect.h, y1, y2) > 2).map((o) => o.rect.x)];
    const limit = Math.min(contentRight, ...rightObstacle);
    if (rightObstacle.some((x) => x - s.x2 < 50)) continue;
    const width = limit - s.x2 - 10;
    if (width < 60) continue;
    // anything already detected right below/at this spot (e.g. a line)?
    const rect = { x: s.x2 + 5, y: y1, w: width, h: y2 - y1 };
    if (out.some((o) => overlapRatio(o.rect, rect) > 0.3)) continue;
    out.push({ type: 'text', rect, label: cleanLabel(s.str), colon: true });
  }

  // --- dedupe, drop anything on top of real form widgets
  const kept = [];
  for (const f of out) {
    if (f.rect.w < 4 || f.rect.h < 4) continue;
    if (avoidRects.some((r) => overlapRatio(r, f.rect) > 0.3)) continue;
    const dup = kept.find((k) => overlapRatio(k.rect, f.rect) > 0.45);
    if (dup) {
      // prefer the pixel geometry of a line, keep any label we already had
      if (dup.line && f.line && f.rect.w > dup.rect.w * 0.6) dup.rect = { ...dup.rect, x: Math.min(dup.rect.x, f.rect.x), w: Math.max(dup.rect.x + dup.rect.w, f.rect.x + f.rect.w) - Math.min(dup.rect.x, f.rect.x) };
      continue;
    }
    kept.push(f);
  }
  // labels
  const usedSegs = new Set();
  for (const f of kept.filter((k) => k.type === 'checkbox')) {
    const r = findLabel(f.rect, segs, 'check');
    f.label = f.label || cleanLabel(r.label);
    if (r.seg) usedSegs.add(r.seg);
    f._seg = r.seg;
  }
  for (const f of kept) {
    if (f.type === 'checkbox') {
      const ctx = findLabel(f.rect, segs, 'text', usedSegs);
      if (ctx.seg && ctx.seg !== f._seg) f.context = cleanLabel(ctx.label);
      delete f._seg;
      continue;
    }
    if (!f.label) f.label = cleanLabel(findLabel(f.rect, segs, 'text', usedSegs).label);
  }
  return kept.map((f) => ({ ...f, page: index }));
}

export function finishFlatFields(list, startN = 0) {
  let n = startN;
  return list.map((f) => {
    n++;
    const field = {
      id: 'flat:' + Math.random().toString(36).slice(2, 9),
      source: 'flat',
      type: f.type,
      label: f.label || t('fieldN', { n }),
      context: f.context || '',
      page: f.page,
      rect: f.rect,
      widgets: [],
      options: [],
      required: false,
      initial: f.type === 'checkbox' ? false : '',
      line: !!f.line,
    };
    if (f.type !== 'checkbox' && SIG_RE.test(field.label)) field.signature = true;
    finishHints(field);
    return field;
  });
}

export function sortFields(fields) {
  const key = (f) => (f.type === 'radio' ? (f.options[0]?.widget?.rect || f.rect) : f.rect);
  return fields.sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    const ra = key(a), rb = key(b);
    const ca = ra.y + ra.h / 2, cb = rb.y + rb.h / 2;
    if (Math.abs(ca - cb) > Math.max(5, Math.min(ra.h, rb.h) * 0.45)) return ca - cb;
    return ra.x - rb.x;
  });
}

// Word boxes inside a text segment (positions estimated from character widths).
export function wordBoxes(seg) {
  const chars = [...seg.str];
  const total = chars.reduce((a, c) => a + charW(c), 0) || 1;
  const scale = (seg.x2 - seg.x1) / total;
  const out = [];
  let x = seg.x1, start = null, word = '';
  chars.forEach((c, i) => {
    const w = charW(c) * scale;
    if (c === ' ') { if (start != null) { out.push({ x1: start, x2: x, word }); start = null; word = ''; } }
    else { if (start == null) start = x; word += c; }
    x += w;
    if (i === chars.length - 1 && start != null) out.push({ x1: start, x2: x, word });
  });
  return out.map((b) => ({ ...b, y1: seg.y1, y2: seg.y2 }));
}
