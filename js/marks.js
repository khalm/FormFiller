// Shapes for the erase styles, shared by the on-screen preview and the PDF writer.
// Coordinates are in page points (display space: origin top-left), relative to the page.

export const MARK_STYLES = ['strike1', 'strike2', 'strike3', 'scribble', 'hatch', 'blur', 'cover'];

export function normalizeKind(k) {
  if (k === 'white') return 'cover';
  if (k === 'strike') return 'strike1';
  return MARK_STYLES.includes(k) ? k : 'cover';
}

// tiny deterministic random so a scribble looks the same every time
function rng(seed) {
  let x = (seed * 2654435761) >>> 0 || 1;
  return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return ((x >>> 0) % 10000) / 10000; };
}

/** Returns { lines: [[x1,y1,x2,y2],...], width } for line-based styles, or null. */
export function markLines(kind, r, seed = 1) {
  const { x, y, w, h } = r;
  if (kind.startsWith('strike')) {
    const n = +kind.slice(6) || 1;
    const gap = Math.max(1.2, h * 0.2);
    const width = Math.max(0.7, h * 0.075);
    const cy = y + h * 0.52;
    const lines = [];
    for (let i = 0; i < n; i++) {
      const yy = cy + (i - (n - 1) / 2) * gap;
      lines.push([x, yy, x + w, yy]);
    }
    return { lines, width };
  }
  if (kind === 'scribble') {
    const rand = rng(seed);
    const step = Math.max(1.6, Math.min(h * 0.2, 6));
    const width = Math.max(1, Math.min(h * 0.15, 3.2));
    const pts = [];
    let up = true;
    for (let xx = x; xx <= x + w + 0.01; xx += step * (0.75 + rand() * 0.5)) {
      const yy = up ? y + h * (0.08 + rand() * 0.12) : y + h * (0.8 + rand() * 0.12);
      pts.push([Math.min(xx, x + w), yy]);
      up = !up;
    }
    if (pts.length < 2) pts.push([x + w, y + h / 2]);
    // second pass back the other way so it reads as a scribble, not a zigzag
    const back = pts.slice().reverse().map(([px, py], i) => [px + (rand() - 0.5) * step * 0.6, i % 2 ? y + h * (0.12 + rand() * 0.2) : y + h * (0.68 + rand() * 0.2)]);
    const again = pts.map(([px], i) => [px + step * 0.5, i % 2 ? y + h * (0.3 + rand() * 0.15) : y + h * (0.55 + rand() * 0.15)]);
    const all = [...pts, ...back, ...again];
    const lines = [];
    for (let i = 1; i < all.length; i++) lines.push([all[i - 1][0], all[i - 1][1], all[i][0], all[i][1]]);
    return { lines, width };
  }
  if (kind === 'hatch') {
    const s = Math.max(1.8, Math.min(h * 0.2, 4.5));
    const width = Math.max(0.6, s * 0.26);
    const lines = [];
    // 45° lines (bottom-left to top-right), clipped to the rectangle
    for (let c = -h; c < w; c += s) {
      let x1 = x + c, y1 = y + h, x2 = x + c + h, y2 = y;
      if (x1 < x) { y1 -= x - x1; x1 = x; }
      if (x2 > x + w) { y2 += x2 - (x + w); x2 = x + w; }
      if (x2 > x1) lines.push([x1, y1, x2, y2]);
    }
    return { lines, width };
  }
  return null;
}
