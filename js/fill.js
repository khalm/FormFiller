// Writes the user's answers into the PDF.
// Real form fields are filled through pdf.js (good appearance generation, handles protected PDFs
// and non-latin text). Everything else (printed-style blanks, drawn signatures, locking,
// keeping only the form pages) is done with pdf-lib.
import { openPdf, pdfjsLib, PDFLib } from './pdf.js';
import { t } from './i18n.js';
import { markLines } from './marks.js';

const { PDFDocument, StandardFonts, degrees, rgb, PDFRef, PDFNull, TextAlignment, LineCapStyle } = PDFLib;
const TEXTISH = new Set(['text', 'multiline', 'select']);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function formatDate(iso, fmt) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return iso || '';
  const [, Y, M, D] = m;
  if (!fmt) return iso;
  const map = { yyyy: Y, yy: Y.slice(2), mmmm: MONTHS[+M - 1], mmm: MONTHS[+M - 1].slice(0, 3), mm: M, m: String(+M), dd: D, d: String(+D) };
  return fmt.replace(/yyyy|yy|mmmm|mmm|mm|m|dd|d/g, (k) => map[k]);
}

export function parseDateToIso(s, fmt) {
  // best effort reverse of formatDate for pre-filled values
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const order = (fmt || 'dd.mm.yyyy').replace(/[^dmy]+/g, ' ').trim().split(' ').map((x) => x[0]);
  const parts = s.split(/[^\d]+/).filter(Boolean);
  if (parts.length !== 3 || order.length !== 3) return '';
  const o = {};
  order.forEach((k, i) => { o[k] = parts[i]; });
  if (!o.y || !o.m || !o.d) return '';
  const y = o.y.length === 2 ? '20' + o.y : o.y;
  return `${y}-${o.m.padStart(2, '0')}-${o.d.padStart(2, '0')}`;
}

export function hasValue(f, v) {
  if (v == null) return false;
  if (typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return !!(v.sig || v.text);
  return String(v).trim() !== '';
}

function textOf(f, v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v.text || '';
  let s = v == null ? '' : String(v);
  if (f.isDate) s = formatDate(s, f.dateFormat);
  if (f.maxLen) s = s.slice(0, f.maxLen);
  return s;
}

function same(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a || []) === JSON.stringify(b || []);
  return (a ?? '') === (b ?? '');
}

function toPdfRect(vp, r) {
  const [x1, y1] = vp.convertToPdfPoint(r.x, r.y);
  const [x2, y2] = vp.convertToPdfPoint(r.x + r.w, r.y + r.h);
  return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
}

/**
 * @param {object} o
 * @param {Uint8Array} o.bytes original file
 * @param {string} [o.password]
 * @param {boolean} o.encrypted
 * @param {Array} o.fields detected fields
 * @param {object} o.values answers keyed by field id
 * @param {Array} o.viewports scale-1 viewports per page
 * @param {'all'|'form'} o.mode
 * @param {boolean} o.flatten
 */
export async function buildPdf(o) {
  const warnings = new Set();
  const { fields, values, viewports } = o;
  // Multi-line fields with "auto" font size get one giant line from most generators.
  // Give them a fixed size that makes the text fit before the appearance is generated.
  let srcBytes = o.bytes;
  if (!o.encrypted) srcBytes = await fixAutoSizedMultiline(o.bytes, fields, values, o.color).catch(() => o.bytes);
  const task = openPdf(srcBytes, o.password);
  const doc = await task.promise;
  const storage = doc.annotationStorage;
  let changed = false;

  // 1) real form fields
  for (const f of fields) {
    if (f.source !== 'acro') continue;
    const v = values[f.id];
    if (f.signature && v && typeof v === 'object' && v.sig) continue; // drawn later as an image
    if (f.type === 'signature') continue;
    if (same(v, f.initial) && !(f.isDate && v)) continue;
    changed = true;
    if (f.type === 'text' || f.type === 'multiline') {
      const s = textOf(f, v);
      for (const w of f.widgets) storage.setValue(w.id, { value: s });
    } else if (f.type === 'checkbox') {
      for (const w of f.widgets) storage.setValue(w.id, { value: !!v });
    } else if (f.type === 'radio') {
      for (const w of f.widgets) storage.setValue(w.id, { value: v != null && String(w.exportValue) === String(v) });
    } else if (f.type === 'select') {
      for (const w of f.widgets) storage.setValue(w.id, { value: v ?? '' });
    } else if (f.type === 'list') {
      for (const w of f.widgets) storage.setValue(w.id, { value: Array.isArray(v) ? v : (v ? [v] : []) });
    }
  }

  const flatToDraw = fields.filter((f) => (f.source === 'flat' || (f.signature && values[f.id]?.sig)) && hasValue(f, values[f.id]));

  // 2) protected PDFs: pdf-lib can't edit them, so printed-style blanks become text annotations
  if (o.encrypted) {
    let k = 0;
    for (const f of flatToDraw) {
      const v = values[f.id];
      if (v && typeof v === 'object' && v.sig) { warnings.add(t('sigSkipped')); continue; }
      const vp = viewports[f.page];
      const rect = toPdfRect(vp, f.rect);
      const text = f.type === 'checkbox' ? 'X' : textOf(f, v);
      const fontSize = f.type === 'checkbox' ? Math.max(7, Math.min(rect[3] - rect[1], 14)) : Math.max(7, Math.min(11, (rect[3] - rect[1]) * 0.7));
      storage.setValue('pdfjs_internal_editor_' + (900000 + k++), {
        annotationType: pdfjsLib.AnnotationEditorType.FREETEXT,
        color: (o.color || [0, 0, 0]).map((c) => Math.round(c * 255)), fontSize, value: text, pageIndex: f.page,
        rect, rotation: vp.rotation || 0, id: null, structTreeParentId: null,
      });
      changed = true;
    }
    if (o.flatten || o.mode === 'form') warnings.add(t('encryptedNote'));
    if (o.marks && o.marks.length) warnings.add(t('marksProtected'));
    if (o.color && fields.some((f) => f.source === 'acro' && TEXTISH.has(f.type) && hasValue(f, values[f.id]))) warnings.add(t('colorProtected'));
    const out = changed ? await doc.saveDocument() : srcBytes.slice(0);
    await task.destroy();
    return { bytes: out, warnings: [...warnings] };
  }

  let bytes = changed ? await doc.saveDocument() : srcBytes.slice(0);
  await task.destroy();

  const detach = o.detach || [];
  const marks = o.marks || [];
  const needLib = flatToDraw.length || o.flatten || o.mode === 'form' || detach.length || marks.length;
  if (!needLib) return { bytes, warnings: [...warnings] };

  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  // form fields that sit under a merged box are removed so the merged text is visible
  for (const name of detach) detachField(pdf, name);
  // whiteout / strike-out go on first, so new text can be written on top of a whiteout
  for (const m of marks) {
    const page = pdf.getPage(m.page);
    const vp = viewports[m.page];
    const r = m.rect;
    const P = (x, y) => { const [px, py] = vp.convertToPdfPoint(x, y); return { x: px, y: py }; };
    if (m.kind === 'cover') {
      const [x1, y1, x2, y2] = toPdfRect(vp, r);
      const bg = /^#[0-9a-f]{6}$/i.test(m.color || '') ? [1, 3, 5].map((i) => parseInt(m.color.slice(i, i + 2), 16) / 255) : [1, 1, 1];
      page.drawRectangle({ x: x1, y: y1, width: x2 - x1, height: y2 - y1, color: rgb(...bg) });
    } else if (m.kind === 'blur') {
      if (!m.image) continue;
      const img = await pdf.embedPng(m.image);
      const [x1, y1, x2, y2] = toPdfRect(vp, r);
      page.drawImage(img, { x: x1, y: y1, width: x2 - x1, height: y2 - y1 });
    } else {
      const geo = markLines(m.kind, r, m.seed);
      if (!geo) continue;
      const color = o.color ? rgb(...o.color) : rgb(0.05, 0.05, 0.12);
      for (const [a, b, c, d] of geo.lines) page.drawLine({ start: P(a, b), end: P(c, d), thickness: geo.width, color, lineCap: LineCapStyle.Round });
    }
  }
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const safe = (s) => [...s].map((c) => {
    if (c === '\n') return c;
    try { helv.encodeText(c); return c; } catch { warnings.add(t('charsReplaced')); return '?'; }
  }).join('');

  for (const f of flatToDraw) {
    const page = pdf.getPage(f.page);
    const vp = viewports[f.page];
    const rot = vp.rotation || 0;
    const v = values[f.id];
    const r = f.source === 'acro' ? f.widgets[0].rect : f.rect;
    const pageOfField = f.source === 'acro' ? f.widgets[0].page : f.page;
    const pg = pdf.getPage(pageOfField);
    const vpp = viewports[pageOfField];
    const at = (dx, dy) => { const [x, y] = vpp.convertToPdfPoint(dx, dy); return { x, y }; };

    if (v && typeof v === 'object' && v.sig) {
      const png = await pdf.embedPng(v.sig);
      const scale = Math.min((r.w - 2) / png.width, (r.h - 2) / png.height);
      const w = png.width * scale, h = png.height * scale;
      const dx = r.x + 2, dy = r.y + r.h - 1; // bottom-left in display space
      const p = at(dx, dy);
      pg.drawImage(png, { ...p, width: w, height: h, rotate: degrees(rot) });
      // the field's own (usually opaque) box would cover the drawing, so the field is removed
      if (f.source === 'acro') detachField(pdf, f.name);
      continue;
    }
    if (f.type === 'checkbox') {
      if (!v) continue;
      // a vector check mark (no font needed, looks the same in every viewer)
      const sz = Math.min(r.w, r.h) * 0.9;
      const ox = r.x + (r.w - sz) / 2, oy = r.y + (r.h - sz) / 2;
      page.drawSvgPath('M 0.14 0.55 L 0.40 0.80 L 0.88 0.18', { ...at(ox, oy), scale: sz, borderColor: o.color ? rgb(...o.color) : rgb(0.05, 0.05, 0.12), borderWidth: Math.max(0.12, 0.13), rotate: degrees(rot) });
      continue;
    }
    const text = safe(textOf(f, v));
    if (!text.trim()) continue;
    const color = o.color ? rgb(...o.color) : rgb(0.05, 0.07, 0.16);
    const multi = f.type === 'multiline' || (r.h >= 30 && text.length * 5 > r.w);
    if (!multi) {
      const one = text.replace(/\s*\n\s*/g, ', ');
      let size = Math.max(6, Math.min(11, r.h * (f.line ? 0.75 : 0.68)));
      while (size > 6 && helv.widthOfTextAtSize(one, size) > r.w - 4) size -= 0.25;
      const base = f.line ? r.y + r.h - Math.max(2.5, r.h * 0.18) : r.y + r.h / 2 + size * 0.34;
      const tx = f.center ? r.x + Math.max(0, (r.w - helv.widthOfTextAtSize(one, size)) / 2) : r.x + 2;
      page.drawText(one, { ...at(tx, base), size, font: helv, color, rotate: degrees(rot) });
    } else {
      let size = Math.min(11, Math.max(7, r.h / 3));
      let lines;
      const wrap = (sz) => {
        const out = [];
        for (const para of text.split('\n')) {
          let line = '';
          for (const word of para.split(/\s+/)) {
            const tryL = line ? line + ' ' + word : word;
            if (helv.widthOfTextAtSize(tryL, sz) <= r.w - 6 || !line) line = tryL;
            else { out.push(line); line = word; }
          }
          out.push(line);
        }
        return out;
      };
      for (;;) {
        lines = wrap(size);
        if (lines.length * size * 1.22 <= r.h - 4 || size <= 6) break;
        size -= 0.5;
      }
      lines.forEach((ln, i) => {
        const base = r.y + 3 + size * 0.9 + i * size * 1.22;
        page.drawText(ln, { ...at(r.x + 3, base), size, font: helv, color, rotate: degrees(rot) });
      });
    }
  }

  if (o.flatten) {
    const form = pdf.getForm();
    try { form.flatten({ updateFieldAppearances: false }); }
    catch {
      try { form.flatten(); } catch { warnings.add(t('flattenFailed')); }
    }
  }

  if (o.mode === 'form') {
    const keep = new Set(fields.flatMap((f) => (f.widgets.length ? f.widgets.map((w) => w.page) : [f.page])));
    if (keep.size) for (let i = pdf.getPageCount() - 1; i >= 0; i--) if (!keep.has(i)) pdf.removePage(i);
  }
  plugXrefGaps(pdf);
  const out = await pdf.save();
  return { bytes: out, warnings: [...warnings] };
}

async function fixAutoSizedMultiline(bytes, fields, values, color) {
  const str = (v) => (typeof v === 'string' ? v : (v && typeof v === 'object' && typeof v.text === 'string' ? v.text : ''));
  const targets = fields.filter((f) => f.source === 'acro' && (f.type === 'multiline' || f.type === 'text' || (color && f.type === 'select')) && !f.comb && (str(values[f.id]).trim() || (f.type === 'select' && values[f.id]) || f.center));
  if (!targets.length) return bytes;
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const form = pdf.getForm();
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const width = (s, size) => { try { return helv.widthOfTextAtSize(s, size); } catch { return s.length * size * 0.55; } };
  const colorOp = color ? ` ${color.map((c) => +c.toFixed(3)).join(' ')} rg` : '';
  let touched = false;
  for (const f of targets) {
    let tf;
    try { tf = f.type === 'select' ? form.getDropdown(f.name) : form.getTextField(f.name); } catch { continue; }
    const text = f.type === 'select' ? '' : str(values[f.id]);
    const { w, h } = f.widgets[0].rect;
    let size = 12;
    if (f.type === 'text') {
      const one = f.isDate ? formatDate(text, f.dateFormat) : text;
      size = Math.min(12, (h - 2) * 0.72);
      while (size > 6 && width(one, size) > w - 5) size -= 0.5;
    } else for (; size > 6; size -= 0.5) {
      let lines = 0;
      for (const para of text.split('\n')) {
        let line = '';
        lines++;
        for (const word of para.split(/\s+/)) {
          const tryL = line ? line + ' ' + word : word;
          if (width(tryL, size) <= w - 6 || !line) line = tryL; else { lines++; line = word; }
        }
      }
      if (lines * size * 1.16 <= h - 3) break;
    }
    if (f.center) { try { tf.setAlignment(TextAlignment.Center); touched = true; } catch {} }
    const fix = (getDA, setDA) => {
      const da = getDA();
      if (!da) return;
      const m = /(-?[\d.]+)\s+Tf/.exec(da);
      const cur = m ? Number(m[1]) : NaN;
      // only touch "auto" sizes (multi-line) or sizes too big for the text to fit
      let nd = da;
      if (f.type !== 'select' && m && ((cur === 0 && f.type === 'multiline') || (cur > 0 && cur > size + 0.4))) nd = nd.replace(m[0], `${Math.round(size * 2) / 2} Tf`);
      // the user's chosen ink colour replaces the field's own text colour
      if (colorOp) nd = nd.replace(/(^|\s)[-\d.]+\s+g(?=\s|$)|(^|\s)[-\d.]+\s+[-\d.]+\s+[-\d.]+\s+rg(?=\s|$)|(^|\s)[-\d.]+\s+[-\d.]+\s+[-\d.]+\s+[-\d.]+\s+k(?=\s|$)/g, ' ').trim() + colorOp;
      if (nd !== da) { setDA(nd); touched = true; }
    };
    fix(() => tf.acroField.getDefaultAppearance(), (d) => tf.acroField.setDefaultAppearance(d));
    for (const wd of tf.acroField.getWidgets()) fix(() => wd.getDefaultAppearance(), (d) => wd.setDefaultAppearance(d));
  }
  return touched ? await pdf.save() : bytes;
}

// Removes a field and its widgets from the form without deleting any objects
// (pdf-lib's removeField can leave a broken xref table behind).
function detachField(pdf, name) {
  try {
    const form = pdf.getForm();
    const field = form.getField(name);
    const widgets = field.acroField.getWidgets();
    // keep the box visible: redraw its border/background as plain page content
    for (const w of widgets) {
      try {
        const ref = pdf.context.getObjectRef(w.dict);
        const page = pdf.getPages().find((pg) => (pg.node.Annots()?.asArray() || []).some((a) => a === ref));
        if (!page) continue;
        const r = w.getRectangle();
        const mk = w.getAppearanceCharacteristics();
        const toRgb = (c) => (c && c.length === 3 ? rgb(c[0], c[1], c[2]) : c && c.length === 1 ? rgb(c[0], c[0], c[0]) : undefined);
        const bc = toRgb(mk?.getBorderColor()), bg = toRgb(mk?.getBackgroundColor());
        const bw = w.getBorderStyle()?.getWidth() ?? 1;
        if (bc || bg) page.drawRectangle({ x: r.x + bw / 2, y: r.y + bw / 2, width: r.width - bw, height: r.height - bw, color: bg, borderColor: bc, borderWidth: bc ? bw : 0 });
      } catch {}
    }
    for (const page of pdf.getPages()) {
      for (const w of widgets) {
        const ref = pdf.context.getObjectRef(w.dict);
        if (ref) page.node.removeAnnot(ref);
      }
    }
    form.acroForm.removeField(field.acroField);
  } catch (e) { console.warn('detach failed', e); }
}

// pdf-lib leaves holes in the cross-reference table when it deletes objects (flattening,
// removing fields). Strict readers complain about that, so fill the holes with null objects.
function plugXrefGaps(pdf) {
  const ctx = pdf.context;
  for (let n = 1; n <= ctx.largestObjectNumber; n++) {
    const ref = PDFRef.of(n, 0);
    if (!ctx.indirectObjects.has(ref)) ctx.assign(ref, PDFNull);
  }
}
