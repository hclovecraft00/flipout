// Pens: pencil, crayon, marker, oil pastel, fuzzy, eraser.
// Grainy pens draw the whole stroke into a buffer, then show it through a paper-grain
// texture fixed to the page, so the texture lines up like real paper tooth.

// Pencil, crayon and oil pastel were taken out of the app (too slow on the iPad Air);
// their engine code stays below in case they come back.
export const PENS = [
  { id: 'marker', name: 'Pen', size: 12 },
  { id: 'fuzzy', name: 'Fuzzy', size: 32 },
  { id: 'eraser', name: 'Eraser', size: 40 },
];
const TEXTURED = new Set(['pencil', 'crayon', 'oil']);

function mk(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

function grainTile(kind) {
  const S = 256, c = mk(S, S), x = c.getContext('2d'), img = x.createImageData(S, S), d = img.data;
  let coarse = null;
  if (kind !== 'pencil') {
    const g = mk(40, 40), gx = g.getContext('2d'), gi = gx.createImageData(40, 40);
    for (let i = 0; i < 1600; i++) { const v = Math.random() * 255; gi.data.set([v, v, v, 255], i * 4); }
    gx.putImageData(gi, 0, 0);
    const big = mk(S, S), bx = big.getContext('2d');
    bx.imageSmoothingEnabled = true; bx.drawImage(g, 0, 0, S, S);
    coarse = bx.getImageData(0, 0, S, S).data;
  }
  for (let p = 0; p < S * S; p++) {
    const r = Math.random();
    let a;
    if (kind === 'pencil') a = r < 0.36 ? 0 : 120 + r * 135;
    else if (kind === 'oil') { const v = (coarse[p * 4] / 255) * 0.8 + r * 0.2; a = v < 0.2 ? 0 : 205 + v * 50; }
    else { const v = (coarse[p * 4] / 255) * 0.7 + r * 0.3; a = v < 0.34 ? 0 : 238; }
    d[p * 4 + 3] = a;
  }
  x.putImageData(img, 0, 0);
  return c;
}
let GRAIN = null;

export class Brush {
  // grainScale: how big the paper grain is (1 = tuned for an 800px-wide page)
  constructor(w, h, grainScale = 1) {
    GRAIN = GRAIN || { pencil: grainTile('pencil'), crayon: grainTile('crayon'), oil: grainTile('oil') };
    this.w = w; this.h = h;
    this.backup = mk(w, h); this.buf = mk(w, h); this.tmp = mk(w, h);
    this.grainScale = grainScale;
    this.sheets = {}; // a page-sized sheet of grain per pen, made the first time that pen is used
  }

  // Drawing through a ready-made sheet is a fast copy in Safari; a pattern fill is slow.
  sheet(pen) {
    if (!this.sheets[pen]) {
      const c = mk(this.w, this.h), x = c.getContext('2d');
      const p = x.createPattern(GRAIN[pen], 'repeat');
      if (this.grainScale !== 1 && p.setTransform) p.setTransform(new DOMMatrix().scale(this.grainScale));
      x.fillStyle = p; x.fillRect(0, 0, this.w, this.h);
      this.sheets[pen] = c;
    }
    return this.sheets[pen];
  }

  // Copy of the layer before a change (used for undo, and under grainy strokes).
  snapshot(canvas) {
    const b = this.backup.getContext('2d');
    b.clearRect(0, 0, this.w, this.h);
    b.drawImage(canvas, 0, 0);
  }

  begin(canvas, pen, colour) {
    this.ctx = canvas.getContext('2d');
    this.pen = pen; this.colour = colour; this.pts = [];
    this.textured = TEXTURED.has(pen);
    this.box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    this.dirty = null;
    this.snapshot(canvas);
    if (this.textured) { this.sheet(pen); this.buf.getContext('2d').clearRect(0, 0, this.w, this.h); }
  }

  point(x, y, w) {
    const pts = this.pts, last = pts[pts.length - 1];
    if (last && Math.hypot(x - last.x, y - last.y) < 0.8) return;
    if (last) w = last.w * 0.6 + w * 0.4;
    pts.push({ x, y, w });
    const n = pts.length;
    if (this.pen === 'fuzzy') { this.stipple(last || { x, y, w }, pts[n - 1]); return; }
    const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, w: (a.w + b.w) / 2 });
    if (n === 1) this.curve(pts[0], pts[0], pts[0]);
    else if (n === 2) this.curve(pts[0], pts[0], mid(pts[0], pts[1]));
    else this.curve(mid(pts[n - 3], pts[n - 2]), pts[n - 2], mid(pts[n - 2], pts[n - 1]));
  }

  // The bit between where the smooth curve stops and the newest point. Smoothing always lags
  // one point behind, so the editor draws this bit straight away as a temporary tail.
  tail() {
    const pts = this.pts, n = pts.length;
    if (this.pen === 'fuzzy' || this.pen === 'eraser' || n < 2) return null;
    const a = pts[n - 2], b = pts[n - 1];
    return { from: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, w: (a.w + b.w) / 2 }, to: b };
  }

  // Finish the stroke. Returns the area it changed (for undo), or null.
  end() {
    const pts = this.pts;
    if (pts.length >= 2 && this.pen !== 'fuzzy') {
      const a = pts[pts.length - 2], b = pts[pts.length - 1];
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, w: (a.w + b.w) / 2 };
      this.curve(m, m, b);
    }
    this.flush();
    this.pts = [];
    const b = this.box;
    if (!isFinite(b.x0)) return null;
    const x = Math.max(0, Math.floor(b.x0)), y = Math.max(0, Math.floor(b.y0));
    const box = { x, y, w: Math.min(this.w, Math.ceil(b.x1)) - x, h: Math.min(this.h, Math.ceil(b.y1)) - y };
    return box.w > 0 && box.h > 0 ? box : null;
  }

  grow(x0, y0, x1, y1) {
    const b = this.box;
    b.x0 = Math.min(b.x0, x0); b.y0 = Math.min(b.y0, y0); b.x1 = Math.max(b.x1, x1); b.y1 = Math.max(b.y1, y1);
  }

  curve(a, b, c) {
    const ctx = this.textured ? this.buf.getContext('2d') : this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = this.pen === 'eraser' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = ctx.fillStyle = this.pen === 'eraser' ? '#000' : this.colour;
    ctx.lineCap = ctx.lineJoin = 'round';
    const len = Math.hypot(b.x - a.x, b.y - a.y) + Math.hypot(c.x - b.x, c.y - b.y);
    let minX = c.x, minY = c.y, maxX = c.x, maxY = c.y;
    if (len < 0.5) {
      ctx.beginPath(); ctx.arc(c.x, c.y, c.w / 2, 0, Math.PI * 2); ctx.fill();
    } else {
      const steps = Math.max(1, Math.min(12, Math.ceil(len / 3)));
      let px = a.x, py = a.y;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps, u = 1 - t;
        const x = u * u * a.x + 2 * u * t * b.x + t * t * c.x, y = u * u * a.y + 2 * u * t * b.y + t * t * c.y;
        const lw = a.w + (c.w - a.w) * t;
        ctx.lineWidth = lw;
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(x, y); ctx.stroke();
        if (this.pen === 'oil') {
          // bumpy, smeared edges: a couple of slightly-off copies of the stroke
          for (let k = 0; k < 2; k++) {
            const jx = (Math.random() - 0.5) * lw * 0.35, jy = (Math.random() - 0.5) * lw * 0.35;
            ctx.lineWidth = lw * (0.75 + Math.random() * 0.4);
            ctx.beginPath(); ctx.moveTo(px + jx, py + jy); ctx.lineTo(x + jx, y + jy); ctx.stroke();
          }
        }
        minX = Math.min(minX, px, x); maxX = Math.max(maxX, px, x); minY = Math.min(minY, py, y); maxY = Math.max(maxY, py, y);
        px = x; py = y;
      }
    }
    ctx.restore();
    const r = Math.max(a.w, c.w) * (this.pen === 'oil' ? 0.75 : 0.5) + 3;
    this.grow(minX - r, minY - r, maxX + r, maxY + r);
    if (this.textured) {
      const d = this.dirty;
      const x0 = minX - r, y0 = minY - r, x1 = maxX + r, y1 = maxY + r;
      this.dirty = d ? { x0: Math.min(d.x0, x0), y0: Math.min(d.y0, y0), x1: Math.max(d.x1, x1), y1: Math.max(d.y1, y1) } : { x0, y0, x1, y1 };
    }
  }

  // Show the grainy stroke drawn so far. Call once per batch of points (once per screen refresh).
  flush() {
    const d = this.dirty;
    if (!d) return;
    this.dirty = null;
    this.composite(d.x0, d.y0, d.x1 - d.x0, d.y1 - d.y0);
  }

  // The stroke so far, through the paper grain, laid over the layer as it was before the stroke.
  composite(x, y, w, h) {
    x = Math.max(0, Math.floor(x)); y = Math.max(0, Math.floor(y));
    w = Math.min(this.w - x, Math.ceil(w) + 1); h = Math.min(this.h - y, Math.ceil(h) + 1);
    if (w <= 0 || h <= 0) return;
    const ctx = this.ctx, t = this.tmp.getContext('2d');
    t.clearRect(x, y, w, h);
    t.drawImage(this.buf, x, y, w, h, x, y, w, h);
    t.globalCompositeOperation = 'destination-in';
    t.drawImage(this.sheets[this.pen], x, y, w, h, x, y, w, h);
    t.globalCompositeOperation = 'source-over';
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(x, y, w, h);
    ctx.drawImage(this.backup, x, y, w, h, x, y, w, h);
    ctx.globalAlpha = this.pen === 'pencil' ? 0.9 : this.pen === 'oil' ? 0.97 : 1;
    ctx.drawImage(this.tmp, x, y, w, h, x, y, w, h);
    ctx.restore();
  }

  // Fuzzy: a spray of soft dots, thickest in the middle.
  stipple(a, b) {
    const ctx = this.ctx, d = Math.hypot(b.x - a.x, b.y - a.y), w = b.w;
    const n = Math.max(3, Math.round((d + 3) * w * 0.12));
    const dot = Math.max(1, w / 16);
    ctx.save();
    ctx.fillStyle = this.colour;
    for (let i = 0; i < n; i++) {
      const t = Math.random();
      const g1 = (Math.random() + Math.random() + Math.random() - 1.5) * w * 0.6;
      const g2 = (Math.random() + Math.random() + Math.random() - 1.5) * w * 0.6;
      ctx.globalAlpha = 0.25 + Math.random() * 0.6;
      ctx.beginPath();
      ctx.arc(a.x + (b.x - a.x) * t + g1, a.y + (b.y - a.y) * t + g2, dot * (0.7 + Math.random() * 1.4), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    const r = w + dot * 2.2;
    this.grow(Math.min(a.x, b.x) - r, Math.min(a.y, b.y) - r, Math.max(a.x, b.x) + r, Math.max(a.y, b.y) + r);
  }
}

// Draw a little sample squiggle with a pen (for the pen tray).
export function drawSample(canvas, pen, colour) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const b = new Brush(canvas.width, canvas.height);
  const H = canvas.height, W = canvas.width;
  const wave = (w) => Array.from({ length: 41 }, (_, i) => [W * 0.05 + i * W * 0.0225, H / 2 + Math.sin(i / 4) * H * 0.23, w * (0.6 + 0.5 * Math.sin(i / 7 + 1))]);
  const c = colour.toUpperCase() === '#FFFFFF' ? '#3A3536' : colour;
  if (pen === 'eraser') {
    b.begin(canvas, 'crayon', '#BFE3F2');
    for (let i = 0; i <= 20; i++) b.point(W * 0.03 + i * W * 0.047, H / 2, H * 0.58);
    b.end();
    b.begin(canvas, 'eraser', '#000');
    for (const p of wave(H * 0.17)) b.point(...p);
    b.end();
  } else {
    const w = { pencil: 0.12, crayon: 0.25, marker: 0.13, oil: 0.29, fuzzy: 0.31 }[pen] * H;
    b.begin(canvas, pen, c);
    for (const p of wave(w)) b.point(...p);
    b.end();
  }
}
