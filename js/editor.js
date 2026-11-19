// The drawing screen: Pencil strokes, onion skin, frames, layers, undo, playback, autosave.
import * as store from './store.js';
import { floodFill } from './fill.js';
import { toast, hideToast, makeCanvas, canvasToBlob } from './ui.js';
import { openExport } from './exporter.js';
import { Brush, PENS, drawSample } from './brushes.js';

const $ = (id) => document.getElementById(id);
const BACK = '#EF6F8E', FWD = '#4F7FD9';
export const PALETTE = [
  ['#3A3536', 'Graphite'], ['#6B4532', 'Cocoa'], ['#EF6F8E', 'Strawberry'], ['#F59E78', 'Peach'],
  ['#F28A3C', 'Tangerine'], ['#F4CF4A', 'Lemon'], ['#A6D46B', 'Pistachio'], ['#6CCBA6', 'Mint'],
  ['#6BBFE3', 'Sky'], ['#4F7FD9', 'Blueberry'], ['#A88BDD', 'Lilac'], ['#FFFFFF', 'Cloud white'],
];
const PALETTE_SET = new Set(PALETTE.map(([h]) => h));
const TOOLS = [...PENS.map((p) => p.id), 'bucket'];
const COMPACT = matchMedia('(max-width: 900px), (orientation: portrait)');
const MAX_LAYERS = 8;
const UNDO_BYTES = 100e6, UNDO_STEPS = 60;

// ---------- state ----------
let P = null;                 // project details (saved)
let onExit = null;
let cells = new Map();        // "fid|lid" -> { blob, pending }
let live = new Map();         // lid -> { canvas, ctx } for the frame on screen
let dirty = new Set();        // layers changed on the frame on screen, not yet saved
let flats = new Map();        // fid -> Promise<ImageBitmap> (all visible layers merged)
let loadToken = 0, onionToken = 0, playToken = 0;
let loading = false, playing = false;
let undoStack = [], redoStack = [];
let stroke = null, penSeen = false, lastPenAt = 0;
// Paper zoom: only the paper zooms (trays and bars stay put), with the console's buttons.
const ZOOMS = [1, 1.5, 2, 3, 4];
let zoomIdx = 0, panX = 0, panY = 0, base = { left: 0, top: 0, w: 0, h: 0 };
let saveTimer = null, metaTimer = null, inFlight = new Set();
let clipboard = null;
let brush, onionCtx, playCtx, tintCanvas, tintCtx, tailCtx, tailBox = null;
let openPop = null, openTray = null;
let wired = false;

const prefs = loadPrefs();
function loadPrefs() {
  const size = Object.fromEntries(PENS.map((p) => [p.id, p.size]));
  const d = { tool: 'marker', size, colour: '#3A3536', recent: [], swap: false };
  try {
    const saved = JSON.parse(localStorage.getItem('flipout-prefs-v2') || '{}');
    const out = { ...d, ...saved, size: { ...size, ...(saved.size || {}) } };
    if (!TOOLS.includes(out.tool)) out.tool = 'marker';
    return out;
  } catch { return d; }
}
function savePrefs() { try { localStorage.setItem('flipout-prefs-v2', JSON.stringify(prefs)); } catch { /* private mode */ } }

const key = (fid, lid) => `${fid}|${lid}`;
const curFid = () => P.frames[P.current];
// Guide layers (from the storyboard) are faint, can't be drawn on, and never appear in exports, onion skin or playback.
const isGuide = (l) => !!(l && l.guide);
const drawLayers = () => P.layers.filter((l) => !l.guide);
const activeLayer = () => P.layers.find((l) => l.id === P.activeLayer && !l.guide) || drawLayers().at(-1) || P.layers[P.layers.length - 1];

// ---------- open / close ----------
export async function openEditor(meta, exitCallback) {
  wireOnce();
  P = meta; onExit = exitCallback;
  P.onion = { on: true, back: 1, fwd: 0, opacity: 0.35, tint: true, ...(P.onion || {}) };
  P.current = Math.min(P.current || 0, P.frames.length - 1);
  if (!P.layers.find((l) => l.id === P.activeLayer && !l.guide)) P.activeLayer = (drawLayers().at(-1) || P.layers[P.layers.length - 1]).id;
  cells = new Map(); live = new Map(); dirty = new Set(); flats = new Map();
  undoStack = []; redoStack = []; stroke = null; playing = false; clipboard = null;
  zoomIdx = 0; panX = 0; panY = 0;

  const all = await store.getAllCells(P.id);
  const frameSet = new Set(P.frames), layerSet = new Set(P.layers.map((l) => l.id));
  const orphans = [];
  for (const c of all) {
    if (frameSet.has(c.fid) && layerSet.has(c.lid)) cells.set(key(c.fid, c.lid), { blob: c.blob, pending: null });
    else orphans.push([c.fid, c.lid]);
  }
  store.deleteCells(P.id, orphans).catch(() => {});

  for (const id of ['onion', 'playback', 'ink-tail']) { const c = $(id); c.width = P.w; c.height = P.h; }
  tailCtx = $('ink-tail').getContext('2d'); tailBox = null;
  onionCtx = $('onion').getContext('2d');
  playCtx = $('playback').getContext('2d');
  brush = new Brush(P.w, P.h, P.w / 800);
  tintCanvas = makeCanvas(P.w, P.h); tintCtx = tintCanvas.getContext('2d');
  $('layer-stack').innerHTML = '';
  rebuildLive();

  $('home').hidden = true; $('editor').hidden = false;
  $('btn-rename').textContent = P.name;
  $('playback').hidden = true; $('layer-stack').hidden = false; $('onion').hidden = false;
  setSaveState();
  document.body.classList.toggle('swap', !!prefs.swap);
  $('set-swap').setAttribute('aria-checked', String(!!prefs.swap));
  layout();
  renderSwatches();
  updateToolUI(); updateUndoUI(); updateOnionUI(); updateFps(); renderTicks();
  await loadFrame();
  renderOnion();
}

async function closeEditor() {
  stopPlay(); closePop();
  flushCurrent();
  await waitForSaves();
  try { await makeThumb(); } catch { /* thumbnail is optional */ }
  P.updatedAt = Date.now();
  await store.putProject(P);
  $('editor').hidden = true; $('home').hidden = false;
  live.forEach(({ canvas }) => { canvas.width = 0; canvas.height = 0; });
  live = new Map(); flats = new Map(); undoStack = []; redoStack = [];
  onExit && onExit();
}

// ---------- layout & view ----------
function layout() {
  if (!P || $('editor').hidden) return;
  const W = window.innerWidth, H = window.innerHeight;
  let top = 16, bottom = H - 16, left = 16, right = W - 16;
  for (const el of document.querySelectorAll('#editor .titlebar, #editor .toolbar, #editor .actions, #editor .scrubber')) {
    const r = el.getBoundingClientRect();
    if (r.height === 0) continue;
    if (r.top + r.height / 2 < H / 2) top = Math.max(top, r.bottom + 14);
    else bottom = Math.min(bottom, r.top - 14);
  }
  if (!COMPACT.matches) {
    for (const el of document.querySelectorAll('#editor .tray')) { // pens, colours and the zoom console
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      if (r.left + r.width / 2 < W / 2) left = Math.max(left, r.right + 24);
      else right = Math.min(right, r.left - 24);
    }
  }
  const availH = Math.max(100, bottom - top), availW = Math.max(100, right - left);
  const s = Math.min(availW / P.w, availH / P.h);
  base = { w: Math.round(P.w * s), h: Math.round(P.h * s) };
  base.left = Math.round(left + (availW - base.w) / 2);
  base.top = Math.round(top + (availH - base.h) / 2);
  const paper = $('paper');
  paper.style.left = base.left + 'px'; paper.style.top = base.top + 'px';
  paper.style.width = base.w + 'px'; paper.style.height = base.h + 'px';
  applyView();
}
function applyView() {
  const s = ZOOMS[zoomIdx];
  if (s === 1) { panX = 0; panY = 0; }
  // never let the paper slide fully off screen
  const mx = base.w * (s - 1) / 2 + base.w * 0.35, my = base.h * (s - 1) / 2 + base.h * 0.35;
  panX = Math.max(-mx, Math.min(mx, panX)); panY = Math.max(-my, Math.min(my, panY));
  // zoom around the middle of the paper's usual spot, then shift by the pan
  const ox = base.w * (1 - s) / 2 + panX, oy = base.h * (1 - s) / 2 + panY;
  $('paper').style.transform = s === 1 ? '' : `translate(${ox}px, ${oy}px) scale(${s})`;
  $('zoom-level').textContent = (s % 1 ? s.toFixed(1) : s) + '×';
  $('dpad').classList.toggle('off', s === 1);
  $('zoom-out').disabled = $('zoom-fit').disabled = zoomIdx === 0;
  $('zoom-in').disabled = zoomIdx === ZOOMS.length - 1;
}
function resetView() { zoomIdx = 0; panX = 0; panY = 0; applyView(); }
function zoomBy(d) {
  const old = ZOOMS[zoomIdx];
  zoomIdx = Math.max(0, Math.min(ZOOMS.length - 1, zoomIdx + d));
  const s = ZOOMS[zoomIdx];
  panX *= s / old; panY *= s / old; // keep the same spot in the middle
  applyView();
}
function nudge(dx, dy, px) {
  if (ZOOMS[zoomIdx] === 1) return;
  panX += dx * px; panY += dy * px;
  applyView();
}

function toCanvas(e, rect) {
  const r = rect || $('paper').getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width * P.w, y: (e.clientY - r.top) / r.height * P.h };
}

// ---------- layers on screen ----------
function rebuildLive() {
  const stack = $('layer-stack');
  const keep = new Set(P.layers.map((l) => l.id));
  for (const [lid, v] of live) if (!keep.has(lid)) { v.canvas.remove(); v.canvas.width = 0; live.delete(lid); }
  for (const l of P.layers) {
    let v = live.get(l.id);
    if (!v) {
      const canvas = makeCanvas(P.w, P.h);
      v = { canvas, ctx: canvas.getContext('2d') };
      live.set(l.id, v);
    }
    stack.appendChild(v.canvas); // appending in order also re-orders
    v.canvas.style.visibility = l.visible ? 'visible' : 'hidden';
    v.canvas.style.opacity = l.guide ? '0.35' : '';
    v.canvas.classList.toggle('guide-layer', isGuide(l));
  }
}

async function loadFrame() {
  const tok = ++loadToken;
  loading = true;
  const fid = curFid();
  const bmps = await Promise.all(P.layers.map(async (l) => {
    const b = await getCellBlob(fid, l.id);
    return b ? createImageBitmap(b).catch(() => null) : null;
  }));
  if (tok !== loadToken) { bmps.forEach((b) => b && b.close && b.close()); return; }
  P.layers.forEach((l, i) => {
    const { ctx } = live.get(l.id);
    ctx.clearRect(0, 0, P.w, P.h);
    if (bmps[i]) { ctx.drawImage(bmps[i], 0, 0); bmps[i].close && bmps[i].close(); }
  });
  dirty.clear();
  loading = false;
  if (openPop === 'pop-layers') renderLayers();
}

async function getCellBlob(fid, lid) {
  const e = cells.get(key(fid, lid));
  if (!e) return null;
  if (e.pending) { try { return await e.pending; } catch { return null; } }
  return e.blob;
}

// Merged picture of a frame (visible layers), cached.
export function getFlat(i) {
  const fid = P.frames[i];
  if (i === P.current && dirty.size) {
    const c = makeCanvas(P.w, P.h), cx = c.getContext('2d');
    for (const l of P.layers) if (l.visible && !l.guide) cx.drawImage(live.get(l.id).canvas, 0, 0);
    return createImageBitmap(c);
  }
  let p = flats.get(fid);
  if (p) { flats.delete(fid); flats.set(fid, p); return p; }
  p = (async () => {
    const c = makeCanvas(P.w, P.h), cx = c.getContext('2d');
    for (const l of P.layers) {
      if (!l.visible || l.guide) continue;
      const b = await getCellBlob(fid, l.id);
      if (!b) continue;
      const bmp = await createImageBitmap(b);
      cx.drawImage(bmp, 0, 0);
      bmp.close && bmp.close();
    }
    const out = await createImageBitmap(c);
    c.width = 0;
    return out;
  })();
  flats.set(fid, p);
  const maxFlats = Math.max(6, Math.min(240, Math.floor(180e6 / (P.w * P.h * 4))));
  while (flats.size > maxFlats) flats.delete(flats.keys().next().value);
  return p;
}

// ---------- saving ----------
// PNGs are made by a background helper (js/png-worker.js) so saving never pauses the Pencil.
// Until the helper has proved it works on this device, the slower built-in way is used.
let pngWorker = null, workerReady = false, jobId = 0;
const jobs = new Map();
(function startPngWorker() {
  try {
    if (typeof OffscreenCanvas === 'undefined' || !('convertToBlob' in OffscreenCanvas.prototype) || typeof Worker === 'undefined') return;
    pngWorker = new Worker('js/png-worker.js');
    pngWorker.onmessage = (e) => {
      const j = jobs.get(e.data.id);
      if (!j) return;
      jobs.delete(e.data.id);
      if (e.data.blob) j.resolve(e.data.blob); else j.reject(new Error(e.data.error || 'Could not save'));
    };
    pngWorker.onerror = () => { workerReady = false; for (const j of jobs.values()) j.reject(new Error('Save helper stopped')); jobs.clear(); };
    const test = makeCanvas(2, 2);
    test.getContext('2d').fillRect(0, 0, 1, 1);
    workerEncode(test).then((b) => { workerReady = b.size > 0; }).catch(() => { workerReady = false; });
  } catch { pngWorker = null; }
})();
function workerEncode(canvas) {
  const snapshot = createImageBitmap(canvas); // the picture is copied now, before anything else is drawn
  return snapshot.then((bitmap) => new Promise((resolve, reject) => {
    const id = ++jobId;
    jobs.set(id, { resolve, reject });
    pngWorker.postMessage({ id, bitmap }, [bitmap]);
  }));
}
function encodePNG(canvas) { return workerReady ? workerEncode(canvas) : canvasToBlob(canvas); }

function track(promise) {
  inFlight.add(promise);
  setSaveState();
  promise.catch((e) => {
    console.error(e);
    toast('Couldn’t save to this device. Export a backup file to be safe.');
  }).finally(() => { inFlight.delete(promise); setSaveState(); });
  return promise;
}
function setSaveState() {
  const text = inFlight.size > 0 || dirty.size > 0 ? 'Saving…' : 'Saved';
  const el = $('save-state');
  if (el.textContent !== text) el.textContent = text;
}
async function waitForSaves() { while (inFlight.size) await Promise.allSettled([...inFlight]); }

function scheduleSave() {
  setSaveState();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { if (!stroke) flushCurrent(); else scheduleSave(); }, 2000);
}

// Save changed layers of the frame on screen. The picture is copied right away,
// the PNG is made and stored in the background.
function flushCurrent() {
  clearTimeout(saveTimer);
  if (!P || !dirty.size) return;
  const fid = curFid();
  for (const lid of dirty) {
    const canvas = live.get(lid)?.canvas;
    if (!canvas) continue;
    const entry = { blob: null, pending: null };
    entry.pending = encodePNG(canvas).then((blob) => { entry.blob = blob; entry.pending = null; return blob; });
    cells.set(key(fid, lid), entry);
    track(entry.pending.then((blob) => store.putCell(P.id, fid, lid, blob)));
  }
  dirty.clear();
  flats.delete(fid);
  setSaveState();
  saveMetaSoon();
}

function saveMetaSoon() {
  clearTimeout(metaTimer);
  metaTimer = setTimeout(() => { P.updatedAt = Date.now(); track(store.putProject(P)); }, 400);
}

async function makeThumb() {
  const flat = await getFlat(0);
  const tw = 240, th = Math.round(240 * P.h / P.w);
  const c = makeCanvas(tw, th), cx = c.getContext('2d');
  cx.fillStyle = '#fff'; cx.fillRect(0, 0, tw, th);
  cx.drawImage(flat, 0, 0, tw, th);
  P.thumb = await (await canvasToBlob(c)).arrayBuffer();
}

function markDirty(lid) {
  dirty.add(lid);
  flats.delete(curFid());
  scheduleSave();
}

// ---------- drawing ----------
function strokeWidth(e) {
  const size = prefs.size[prefs.tool] || 8;
  const p = e.pointerType === 'pen' ? (e.pressure > 0 ? e.pressure : 0.3) : 0.6;
  return Math.max(0.8, size * (0.3 + 0.7 * Math.pow(p, 0.8)));
}

function beginStroke(e) {
  const layer = activeLayer();
  if (isGuide(layer)) { toast('That’s the guide. Add or pick a drawing layer in Layers.'); return; }
  if (!layer.visible) { toast('This layer is hidden. Show it in Layers to draw on it.'); return; }
  const { canvas, ctx } = live.get(layer.id);
  const pt = toCanvas(e);
  if (prefs.tool === 'bucket') {
    const res = floodFill(ctx, P.w, P.h, pt.x, pt.y, prefs.colour);
    if (res) {
      const box = { x: res.x, y: res.y, w: res.w, h: res.h };
      pushUndo({ type: 'paint', fid: curFid(), lid: layer.id, box, before: imageCanvas(res.before), after: imageCanvas(res.after), bytes: box.w * box.h * 8 });
      markDirty(layer.id);
    }
    return;
  }
  brush.begin(canvas, prefs.tool, prefs.colour);
  stroke = { id: e.pointerId, lid: layer.id, rect: $('paper').getBoundingClientRect() };
  brush.point(pt.x, pt.y, strokeWidth(e));
  brush.flush();
}

function addPoint(x, y, w) { brush.point(x, y, w); }

function endStroke() {
  if (!stroke) return;
  const s = stroke;
  stroke = null;
  clearTail();
  const box = brush.end();
  if (box) { pushPaint(s.lid, box); markDirty(s.lid); }
}

// ---------- undo ----------
function pushPaint(lid, box) {
  const before = regionCopy(brush.backup, box);
  const after = regionCopy(live.get(lid).canvas, box);
  pushUndo({ type: 'paint', fid: curFid(), lid, box, before, after, bytes: box.w * box.h * 8 });
}
function pushUndo(entry) {
  undoStack.push(entry);
  redoStack.forEach(dropBitmaps);
  redoStack = [];
  let total = undoStack.reduce((n, e) => n + (e.bytes || 0), 0);
  while (undoStack.length > UNDO_STEPS || (total > UNDO_BYTES && undoStack.length > 1)) {
    const old = undoStack.shift();
    total -= old.bytes || 0;
    dropBitmaps(old);
  }
  updateUndoUI();
}
// Undo copies stay on the graphics chip (a canvas-to-canvas copy). Reading pixels back
// (getImageData) made Safari stop and wait at the end of every stroke.
function regionCopy(src, box) {
  const c = makeCanvas(box.w, box.h);
  c.getContext('2d').drawImage(src, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
  return c;
}
function imageCanvas(img) {
  const c = makeCanvas(img.width, img.height);
  c.getContext('2d').putImageData(img, 0, 0);
  return c;
}
function dropBitmaps(e) {
  if (e.type !== 'paint') return;
  for (const k of ['before', 'after']) if (e[k]) e[k].width = 0;
}
async function undo() { await step(undoStack, redoStack, 'before'); }
async function redo() { await step(redoStack, undoStack, 'after'); }
async function step(from, to, which) {
  if (playing || stroke || !from.length) return;
  hideToast();
  const e = from.pop();
  to.push(e);
  if (e.type === 'paint') {
    const idx = P.frames.indexOf(e.fid);
    if (idx >= 0 && live.has(e.lid)) {
      if (idx !== P.current) await goTo(idx);
      const img = e[which];
      const ctx = live.get(e.lid).ctx;
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(e.box.x, e.box.y, e.box.w, e.box.h);
      ctx.drawImage(img, e.box.x, e.box.y);
      ctx.restore();
      markDirty(e.lid);
    }
  } else {
    flushCurrent();
    applySnap(e[which]);
    rebuildLive(); flats.clear();
    renderTicks(); await loadFrame(); renderOnion(); saveMetaSoon();
    if (openPop === 'pop-layers') renderLayers();
  }
  updateUndoUI();
}
function updateUndoUI() {
  $('btn-undo').disabled = !undoStack.length;
  $('btn-redo').disabled = !redoStack.length;
}
const snap = () => ({ frames: [...P.frames], layers: P.layers.map((l) => ({ ...l })), current: P.current, activeLayer: P.activeLayer });
function applySnap(s) { P.frames = [...s.frames]; P.layers = s.layers.map((l) => ({ ...l })); P.current = s.current; P.activeLayer = s.activeLayer; }

// A change to frames or layers, undoable as one step.
async function structOp(fn) {
  if (playing) stopPlay();
  flushCurrent();
  const before = snap();
  const ok = await fn();
  if (ok === false) return;
  pushUndo({ type: 'struct', before, after: snap(), bytes: 0 });
  rebuildLive(); flats.clear();
  renderTicks();
  await loadFrame();
  renderOnion(); saveMetaSoon();
  if (openPop === 'pop-layers') renderLayers();
}

// ---------- frames ----------
async function goTo(i) {
  i = Math.max(0, Math.min(P.frames.length - 1, i));
  if (i === P.current) return;
  flushCurrent();
  P.current = i;
  renderTicks();
  await loadFrame();
  renderOnion();
  saveMetaSoon();
}

function copyCellsTo(srcFid, newFid) {
  return Promise.all(P.layers.map(async (l) => {
    const b = await getCellBlob(srcFid, l.id);
    if (!b) return;
    cells.set(key(newFid, l.id), { blob: b, pending: null });
    track(store.putCell(P.id, newFid, l.id, b));
  }));
}

const frameActions = {
  add: () => structOp(() => { P.frames.splice(P.current + 1, 0, store.uid()); P.current++; }),
  dup: () => structOp(async () => {
    const fid = store.uid();
    await copyCellsTo(curFid(), fid);
    P.frames.splice(P.current + 1, 0, fid); P.current++;
  }),
  copy: async () => {
    flushCurrent();
    const fid = curFid();
    clipboard = new Map();
    for (const l of P.layers) { const b = await getCellBlob(fid, l.id); if (b) clipboard.set(l.id, b); }
    toast('Frame copied');
  },
  paste: () => {
    if (!clipboard) { toast('Copy a frame first'); return; }
    return structOp(() => {
      const fid = store.uid();
      for (const [lid, b] of clipboard) {
        if (!P.layers.find((l) => l.id === lid)) continue;
        cells.set(key(fid, lid), { blob: b, pending: null });
        track(store.putCell(P.id, fid, lid, b));
      }
      P.frames.splice(P.current + 1, 0, fid); P.current++;
    });
  },
  left: () => structOp(() => {
    if (P.current === 0) return false;
    const f = P.frames; [f[P.current - 1], f[P.current]] = [f[P.current], f[P.current - 1]]; P.current--;
  }),
  right: () => structOp(() => {
    if (P.current >= P.frames.length - 1) return false;
    const f = P.frames; [f[P.current + 1], f[P.current]] = [f[P.current], f[P.current + 1]]; P.current++;
  }),
  clear: () => {
    const l = activeLayer();
    const { ctx, canvas } = live.get(l.id);
    const box = { x: 0, y: 0, w: P.w, h: P.h };
    const before = regionCopy(canvas, box);
    ctx.clearRect(0, 0, P.w, P.h);
    pushUndo({ type: 'paint', fid: curFid(), lid: l.id, box, before, after: makeCanvas(P.w, P.h), bytes: P.w * P.h * 8 });
    markDirty(l.id);
  },
  delete: async () => {
    if (P.frames.length === 1) { toast('This is the only frame. Use “Clear this layer” instead.'); return; }
    await structOp(() => { P.frames.splice(P.current, 1); P.current = Math.min(P.current, P.frames.length - 1); });
    toast('Frame deleted', 'Undo', undo);
  },
};

// ---------- layers ----------
const layerActions = {
  add: () => {
    if (P.layers.length >= MAX_LAYERS) { toast(`Up to ${MAX_LAYERS} layers`); return; }
    return structOp(() => {
      const n = P.layers.length + 1;
      const id = store.uid();
      const at = P.layers.findIndex((l) => l.id === P.activeLayer) + 1;
      P.layers.splice(at, 0, { id, name: `Layer ${n}`, visible: true });
      P.activeLayer = id;
    });
  },
  remove: (id) => {
    const l = P.layers.find((x) => x.id === id);
    if (P.layers.length === 1 || (!l.guide && drawLayers().length === 1)) { toast('You need at least one drawing layer'); return; }
    if (!confirm(`Delete “${l.name}” on every frame?`)) return;
    return structOp(() => {
      const i = P.layers.findIndex((x) => x.id === id);
      P.layers.splice(i, 1);
      if (P.activeLayer === id) P.activeLayer = (drawLayers().at(-1) || P.layers[Math.max(0, i - 1)]).id;
    }).then(() => toast('Layer deleted', 'Undo', undo));
  },
  move: (id, d) => structOp(() => {
    const i = P.layers.findIndex((x) => x.id === id), j = i + d;
    if (j < 0 || j >= P.layers.length) return false;
    [P.layers[i], P.layers[j]] = [P.layers[j], P.layers[i]];
  }),
  toggle: (id) => {
    const l = P.layers.find((x) => x.id === id);
    l.visible = !l.visible;
    live.get(id).canvas.style.visibility = l.visible ? 'visible' : 'hidden';
    flats.clear(); renderOnion(); saveMetaSoon(); renderLayers();
  },
  pick: (id) => {
    if (isGuide(P.layers.find((x) => x.id === id))) { toast('That’s the guide: it stays faint and is never exported. Draw on another layer.'); return; }
    if (P.activeLayer === id) {
      const l = P.layers.find((x) => x.id === id);
      const name = prompt('Layer name', l.name);
      if (name && name.trim()) { l.name = name.trim(); saveMetaSoon(); }
    } else P.activeLayer = id;
    saveMetaSoon(); renderLayers();
  },
};

const ICON = {
  eye: '<svg class="ico" aria-hidden="true" viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg class="ico" aria-hidden="true" viewBox="0 0 24 24"><path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 3.9M6.1 6.6C3.5 8.3 2 12 2 12s4 7 10 7a9.6 9.6 0 0 0 4.4-1"/></svg>',
  up: '<svg class="ico" aria-hidden="true" viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg>',
  down: '<svg class="ico" aria-hidden="true" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
  trash: '<svg class="ico" aria-hidden="true" viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
};

function renderLayers() {
  const ul = $('layer-list');
  ul.innerHTML = '';
  [...P.layers].reverse().forEach((l, ri) => {
    const li = document.createElement('li');
    li.className = 'layer-row' + (l.id === P.activeLayer && !l.guide ? ' active' : '') + (l.visible ? '' : ' hidden-layer') + (l.guide ? ' guide-row' : '');
    const pick = document.createElement('button');
    pick.className = 'layer-pick';
    pick.setAttribute('aria-label', `${l.name}${l.guide ? ' (guide: faint, not exported)' : l.id === P.activeLayer ? ' (drawing on this layer, tap to rename)' : ''}`);
    const th = makeCanvas(68, Math.round(68 * P.h / P.w));
    th.getContext('2d').drawImage(live.get(l.id).canvas, 0, 0, th.width, th.height);
    const name = document.createElement('span'); name.textContent = l.name;
    pick.append(th, name);
    pick.onclick = () => layerActions.pick(l.id);
    const mk = (html, label, fn, disabled) => {
      const b = document.createElement('button');
      b.className = 'blob'; b.innerHTML = html; b.setAttribute('aria-label', label); b.disabled = !!disabled;
      b.onclick = fn; return b;
    };
    const top = ri === 0, bottom = ri === P.layers.length - 1;
    li.append(pick,
      mk(l.visible ? ICON.eye : ICON.eyeOff, (l.visible ? 'Hide ' : 'Show ') + l.name, () => layerActions.toggle(l.id)),
      mk(ICON.up, 'Move ' + l.name + ' forward', () => layerActions.move(l.id, 1), top),
      mk(ICON.down, 'Move ' + l.name + ' back', () => layerActions.move(l.id, -1), bottom),
      mk(ICON.trash, 'Delete ' + l.name, () => layerActions.remove(l.id), P.layers.length === 1));
    ul.appendChild(li);
  });
}

// ---------- onion skin ----------
async function renderOnion() {
  const tok = ++onionToken;
  const o = P.onion;
  const list = [];
  if (o.on && !playing) {
    for (let k = o.back; k >= 1; k--) if (P.current - k >= 0) list.push({ i: P.current - k, k, col: BACK });
    for (let k = o.fwd; k >= 1; k--) if (P.current + k < P.frames.length) list.push({ i: P.current + k, k, col: FWD });
  }
  let bmps;
  try { bmps = await Promise.all(list.map((x) => getFlat(x.i))); } catch { bmps = []; }
  if (tok !== onionToken) return;
  onionCtx.clearRect(0, 0, P.w, P.h);
  list.forEach((x, n) => {
    const bmp = bmps[n]; if (!bmp) return;
    const alpha = o.opacity * Math.max(0.3, 1 - (x.k - 1) * 0.28);
    let src = bmp;
    if (o.tint) {
      tintCtx.globalCompositeOperation = 'source-over';
      tintCtx.clearRect(0, 0, P.w, P.h);
      tintCtx.drawImage(bmp, 0, 0);
      tintCtx.globalCompositeOperation = 'source-in';
      tintCtx.fillStyle = x.col; tintCtx.fillRect(0, 0, P.w, P.h);
      tintCtx.globalCompositeOperation = 'source-over';
      src = tintCanvas;
    }
    onionCtx.globalAlpha = alpha;
    onionCtx.drawImage(src, 0, 0);
  });
  onionCtx.globalAlpha = 1;
}

function updateOnionUI() {
  const o = P.onion;
  $('onion-on').setAttribute('aria-checked', String(o.on));
  $('onion-tint').setAttribute('aria-checked', String(o.tint));
  $('onion-back').textContent = o.back;
  $('onion-fwd').textContent = o.fwd;
  $('onion-opacity').value = Math.round(o.opacity * 100);
  $('onion-opacity-val').textContent = Math.round(o.opacity * 100) + '%';
  const b = $('btn-onion');
  b.classList.toggle('on', o.on); b.classList.toggle('off', !o.on);
  b.setAttribute('aria-label', o.on ? `Onion skin on: ${o.back} back, ${o.fwd} forward` : 'Onion skin off');
}

// ---------- playback ----------
async function play() {
  if (playing) { stopPlay(); return; }
  closePop();
  flushCurrent();
  playing = true;
  const tok = ++playToken;
  $('ico-play').hidden = true; $('ico-stop').hidden = false; $('btn-play').setAttribute('aria-label', 'Stop');
  $('layer-stack').hidden = true; $('onion').hidden = true; $('playback').hidden = false;
  const n = P.frames.length;
  let i = P.current, next = performance.now();
  while (playing && tok === playToken) {
    let bmp;
    try { bmp = await getFlat(i); } catch { bmp = null; }
    for (let k = 1; k <= 3; k++) getFlat((i + k) % n);
    const wait = next - performance.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (!playing || tok !== playToken) break;
    playCtx.clearRect(0, 0, P.w, P.h);
    if (bmp) playCtx.drawImage(bmp, 0, 0);
    $('frame-count').textContent = `${i + 1} / ${n}`;
    const ms = 1000 / P.fps;
    next += ms;
    if (performance.now() - next > ms * 3) next = performance.now();
    i = (i + 1) % n;
  }
}
function stopPlay() {
  if (!playing) return;
  playing = false; playToken++;
  $('ico-play').hidden = false; $('ico-stop').hidden = true; $('btn-play').setAttribute('aria-label', 'Play');
  $('layer-stack').hidden = false; $('onion').hidden = false; $('playback').hidden = true;
  renderTicks(); renderOnion();
}

// ---------- scrubber ----------
function renderTicks() {
  const box = $('ticks'), n = P.frames.length;
  while (box.children.length < n) { const t = document.createElement('div'); t.className = 'tick'; t.appendChild(document.createElement('i')); box.appendChild(t); }
  while (box.children.length > n) box.lastChild.remove();
  const o = P.onion;
  [...box.children].forEach((t, i) => {
    const d = i - P.current;
    t.className = 'tick' + (d === 0 ? ' cur' : o.on && d < 0 && -d <= o.back ? ' back' : o.on && d > 0 && d <= o.fwd ? ' fwd' : '');
  });
  $('frame-count').textContent = `${P.current + 1} / ${n}`;
  box.setAttribute('aria-valuemax', n); box.setAttribute('aria-valuenow', P.current + 1);
  box.setAttribute('aria-valuetext', `Frame ${P.current + 1} of ${n}`);
}
function tickIndex(e) {
  const r = $('ticks').getBoundingClientRect();
  return Math.max(0, Math.min(P.frames.length - 1, Math.floor((e.clientX - r.left) / r.width * P.frames.length)));
}

function updateFps() {
  $('btn-fps').textContent = `${P.fps} fps`;
  $('fps-range').value = P.fps; $('fps-val').textContent = `${P.fps} fps`;
  [...$('fps-presets').children].forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.v === P.fps)));
}

// ---------- tools & colours ----------
const penName = (id) => (PENS.find((p) => p.id === id) || { name: 'Paint bucket' }).name;
const colourName = (c) => (PALETTE.find(([h]) => h === c.toUpperCase()) || [c, c])[1];

function setTool(t) { if (!TOOLS.includes(t)) return; prefs.tool = t; savePrefs(); updateToolUI(); }
function setColour(c) {
  prefs.colour = c.toUpperCase();
  if (prefs.tool === 'eraser') prefs.tool = 'marker';
  savePrefs(); renderSwatches(); updateToolUI();
}
// Your own colours (from "+"), kept under the palette.
function addRecent(c) {
  c = c.toUpperCase();
  if (PALETTE_SET.has(c)) return;
  prefs.recent = [c, ...prefs.recent.filter((x) => x !== c)].slice(0, 4);
  savePrefs(); renderSwatches();
}
function updateToolUI() {
  document.querySelectorAll('.tool').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === prefs.tool)));
  const sized = prefs.tool !== 'bucket';
  const sz = prefs.size[prefs.tool] ?? 8;
  const range = $('size-range');
  range.disabled = !sized;
  range.value = sz;
  $('size-val').textContent = sized ? sz : '–';
  const d = sized ? Math.max(4, Math.min(40, 3 + sz * 0.6)) : 4;
  const dot = $('size-dot');
  dot.style.width = dot.style.height = d + 'px';
  dot.style.background = prefs.tool === 'eraser' ? '#fff' : prefs.colour;
  dot.style.boxShadow = '0 0 0 1.5px rgba(90,58,46,0.45)';
  $('colour-dot').style.background = prefs.colour;
  $('btn-colours').setAttribute('aria-label', `Colours (now ${colourName(prefs.colour)})`);
  $('btn-pens-use').setAttribute('href', `#pen-${prefs.tool}`);
  $('btn-pens').setAttribute('aria-label', `Pens (now ${penName(prefs.tool)})`);
}
function renderSwatches() {
  const mk = ([hex, name]) => {
    const b = document.createElement('button');
    b.className = 'sw'; b.style.setProperty('--c', hex);
    b.setAttribute('aria-label', name);
    b.setAttribute('aria-pressed', String(hex.toUpperCase() === prefs.colour.toUpperCase()));
    b.onclick = () => setColour(hex);
    return b;
  };
  $('palette').replaceChildren(...PALETTE.map(mk));
  $('recent').replaceChildren(...prefs.recent.map((h) => mk([h, 'Your colour ' + h])));
}

// Hold a pen for a moment to see a sample of its line.
let tipTimer = null, tipHideTimer = null;
function showPenTip(btn) {
  const tool = btn.dataset.tool, tip = $('pen-tip'), c = $('pen-tip-canvas');
  setTool(tool);
  $('pen-tip-name').textContent = penName(tool);
  if (tool === 'bucket') {
    const ctx = c.getContext('2d'), b = new Brush(c.width, c.height);
    ctx.clearRect(0, 0, c.width, c.height);
    const cx = c.width / 2, cy = c.height / 2, rx = c.width * 0.3, ry = c.height * 0.32;
    b.begin(c, 'marker', '#3A3536');
    for (let i = 0; i <= 48; i++) { const a = i / 46 * Math.PI * 2; b.point(cx + rx * Math.cos(a), cy + ry * Math.sin(a), 5); }
    b.end();
    floodFill(ctx, c.width, c.height, cx, cy, prefs.colour.toUpperCase() === '#FFFFFF' ? '#F4CF4A' : prefs.colour);
  } else {
    drawSample(c, tool, prefs.colour);
  }
  tip.hidden = false;
  const r = btn.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight;
  let left, top;
  if (COMPACT.matches) { left = r.left + r.width / 2 - tw / 2; top = r.top - th - 12; }
  else if (r.left < window.innerWidth / 2) { left = r.right + 18; top = r.top + r.height / 2 - th / 2; }
  else { left = r.left - tw - 18; top = r.top + r.height / 2 - th / 2; }
  tip.style.left = Math.max(8, Math.min(window.innerWidth - tw - 8, left)) + 'px';
  tip.style.top = Math.max(8, Math.min(window.innerHeight - th - 8, top)) + 'px';
}
function hidePenTip(delay = 0) {
  clearTimeout(tipTimer); clearTimeout(tipHideTimer);
  if ($('pen-tip').hidden) return;
  tipHideTimer = setTimeout(() => { $('pen-tip').hidden = true; }, delay);
}

// ---------- popovers & trays ----------
function togglePop(id, anchor) {
  if (openPop === id) { closePop(); return; }
  closePop();
  const pop = $(id);
  if (id === 'pop-layers') renderLayers();
  pop.hidden = false;
  openPop = id;
  anchor.classList.add('open');
  const r = anchor.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  pop.style.left = Math.max(12, Math.min(window.innerWidth - pw - 12, r.left + r.width / 2 - pw / 2)) + 'px';
  if (r.top < window.innerHeight / 2) pop.style.top = (r.bottom + 12) + 'px';
  else pop.style.top = Math.max(12, r.top - ph - 12) + 'px';
}
function closePop() {
  closeTray();
  if (!openPop) return;
  $(openPop).hidden = true;
  document.querySelectorAll('[data-pop].open').forEach((b) => b.classList.remove('open'));
  openPop = null;
}
// Upright iPad: the pens and colours trays open from the tool bar.
function toggleTray(id, anchor) {
  if (openTray === id) { closeTray(); return; }
  closePop();
  $(id).classList.add('show');
  openTray = id;
  anchor.classList.add('open');
}
function closeTray() {
  if (!openTray) return;
  $(openTray).classList.remove('show');
  document.querySelectorAll('[data-tray].open').forEach((b) => b.classList.remove('open'));
  openTray = null;
}

// ---------- input: Pencil, mouse, fingers ----------
const touches = new Map();
let gesture = null;

function onDown(e) {
  if (e.pointerType === 'touch') { touchDown(e); return; }
  if (e.button !== 0) return;
  if (e.pointerType === 'pen') { penSeen = true; lastPenAt = performance.now(); }
  if (openPop || openTray) { closePop(); return; }
  if (playing) { stopPlay(); return; }
  if (loading || stroke) return;
  e.preventDefault();
  $('stage').setPointerCapture(e.pointerId);
  beginStroke(e);
}
function onMove(e) {
  if (e.pointerType === 'touch') { touchMove(e); return; }
  if (!stroke || e.pointerId !== stroke.id) return;
  if (e.pointerType === 'pen') lastPenAt = performance.now();
  const list = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
  for (const ev of (list.length ? list : [e])) {
    const pt = toCanvas(ev, stroke.rect);
    addPoint(pt.x, pt.y, strokeWidth(ev));
  }
  brush.flush();
  drawTail(e);
}

// Draw the newest stretch of the stroke straight to the Pencil tip (and a little ahead,
// where Safari predicts the Pencil is going), so the line keeps up with the Pencil.
function drawTail(e) {
  clearTail();
  const t = brush.tail();
  if (!t) return;
  let end = t.to;
  const pred = e.getPredictedEvents ? e.getPredictedEvents() : [];
  if (pred.length) {
    const q = toCanvas(pred[pred.length - 1], stroke.rect);
    const step = Math.hypot(t.to.x - t.from.x, t.to.y - t.from.y) * 2 + 4;
    const d = Math.hypot(q.x - t.to.x, q.y - t.to.y);
    if (d > 0 && d < step * 3) end = { x: q.x, y: q.y, w: t.to.w };
  }
  const c = tailCtx;
  c.save();
  c.strokeStyle = prefs.colour; c.lineCap = 'round'; c.lineJoin = 'round';
  c.lineWidth = t.to.w;
  c.beginPath(); c.moveTo(t.from.x, t.from.y); c.lineTo(t.to.x, t.to.y);
  if (end !== t.to) c.lineTo(end.x, end.y);
  c.stroke();
  c.restore();
  const r = t.to.w / 2 + 3;
  tailBox = {
    x: Math.min(t.from.x, t.to.x, end.x) - r, y: Math.min(t.from.y, t.to.y, end.y) - r,
    x1: Math.max(t.from.x, t.to.x, end.x) + r, y1: Math.max(t.from.y, t.to.y, end.y) + r,
  };
}
function clearTail() {
  if (!tailBox) return;
  tailCtx.clearRect(tailBox.x, tailBox.y, tailBox.x1 - tailBox.x, tailBox.y1 - tailBox.y);
  tailBox = null;
}
function onUp(e) {
  if (e.pointerType === 'touch') { touchUp(e); return; }
  if (stroke && e.pointerId === stroke.id) endStroke();
}

// Fingers never draw and never zoom. Quick two-finger tap = undo, three-finger tap = redo.
function touchDown(e) {
  if (touches.size === 0) gesture = { t0: performance.now(), max: 0, moved: false, palm: false };
  touches.set(e.pointerId, { x0: e.clientX, y0: e.clientY });
  gesture.max = Math.max(gesture.max, touches.size);
  if (stroke || performance.now() - lastPenAt < 400) gesture.palm = true;
  if ((openPop || openTray) && touches.size === 1) closePop();
}
function touchMove(e) {
  const t = touches.get(e.pointerId);
  if (!t || !gesture) return;
  if (Math.hypot(e.clientX - t.x0, e.clientY - t.y0) > 14) gesture.moved = true;
}
function touchUp(e) {
  if (!touches.delete(e.pointerId)) return;
  const g = gesture;
  if (touches.size > 0 || !g) return;
  if (!g.moved && !g.palm && performance.now() - g.t0 < 350) {
    if (g.max === 2) { undo(); flashHint('Undo'); }
    else if (g.max === 3) { redo(); flashHint('Redo'); }
  }
  gesture = null;
}
function flashHint(text) { toast(text, null, null, 700); }

// ---------- wiring (once) ----------
function wireOnce() {
  if (wired) return;
  wired = true;
  const stage = $('stage');
  stage.addEventListener('pointerdown', onDown);
  stage.addEventListener('pointermove', onMove);
  stage.addEventListener('pointerup', onUp);
  stage.addEventListener('pointercancel', onUp);
  stage.addEventListener('contextmenu', (e) => e.preventDefault());
  // Safari's own pinch/zoom gestures: never on the drawing screen.
  for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
  document.addEventListener('pointerdown', (e) => {
    if (!openPop && !openTray) return;
    if (e.target.closest('.popover, .tray, [data-pop], [data-tray], #stage')) return;
    closePop();
  }, true);
  window.addEventListener('resize', () => { closePop(); layout(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && P && !$('editor').hidden) {
      flushCurrent();
      makeThumb().then(() => store.putProject({ ...P, updatedAt: Date.now() })).catch(() => {});
    }
  });

  $('btn-back').onclick = closeEditor;
  $('btn-rename').onclick = () => {
    const name = prompt('Animation name', P.name);
    if (name && name.trim()) { P.name = name.trim(); $('btn-rename').textContent = P.name; saveMetaSoon(); }
  };
  $('btn-undo').onclick = undo;
  $('btn-redo').onclick = redo;
  document.querySelectorAll('.tool').forEach((b) => {
    b.onclick = () => setTool(b.dataset.tool);
    b.addEventListener('pointerdown', () => { clearTimeout(tipTimer); clearTimeout(tipHideTimer); tipTimer = setTimeout(() => showPenTip(b), 380); });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => hidePenTip(900));
    b.addEventListener('contextmenu', (e) => e.preventDefault());
  });
  document.querySelectorAll('[data-pop]').forEach((b) => { b.onclick = () => togglePop(b.dataset.pop, b); });
  document.querySelectorAll('[data-tray]').forEach((b) => { b.onclick = () => toggleTray(b.dataset.tray, b); });
  $('set-swap').onclick = () => {
    prefs.swap = !prefs.swap; savePrefs();
    document.body.classList.toggle('swap', prefs.swap);
    $('set-swap').setAttribute('aria-checked', String(prefs.swap));
    layout();
  };
  $('btn-play').onclick = play;
  $('btn-export').onclick = () => { stopPlay(); closePop(); flushCurrent(); openExport(exportApi); };
  $('btn-add').onclick = frameActions.add;
  $('btn-dup').onclick = frameActions.dup;
  // zoom console
  $('zoom-in').onclick = () => zoomBy(1);
  $('zoom-out').onclick = () => zoomBy(-1);
  $('zoom-fit').onclick = resetView;
  let glide = null;
  document.querySelectorAll('#dpad .arm').forEach((b) => {
    const dx = +b.dataset.dx, dy = +b.dataset.dy;
    const stop = () => { if (glide) cancelAnimationFrame(glide.raf); glide = null; b.classList.remove('held'); };
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault(); stop();
      b.setPointerCapture(e.pointerId); b.classList.add('held');
      nudge(dx, dy, 60); // tap: a nudge
      const t0 = performance.now();
      const tick = (t) => { if (!glide) return; if (t - t0 > 260) nudge(dx, dy, 9); glide.raf = requestAnimationFrame(tick); }; // hold: glide
      glide = { raf: requestAnimationFrame(tick) };
    });
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(ev, stop);
    b.addEventListener('contextmenu', (e) => e.preventDefault());
  });
  $('pop-frame').querySelectorAll('[data-act]').forEach((b) => { b.onclick = () => { closePop(); frameActions[b.dataset.act](); }; });

  // size
  $('size-range').oninput = (e) => {
    if (prefs.tool === 'bucket') return;
    prefs.size[prefs.tool] = +e.target.value; savePrefs(); updateToolUI();
  };

  // colour: "+" opens the iPad's own colour picker; picked colours are kept under the palette
  $('colour-input').addEventListener('input', (e) => setColour(e.target.value));
  $('colour-input').addEventListener('change', (e) => addRecent(e.target.value));

  // onion
  $('onion-on').onclick = () => { P.onion.on = !P.onion.on; onionChanged(); };
  $('onion-tint').onclick = () => { P.onion.tint = !P.onion.tint; onionChanged(); };
  $('onion-opacity').oninput = (e) => { P.onion.opacity = +e.target.value / 100; onionChanged(); };
  document.querySelectorAll('[data-step]').forEach((b) => {
    b.onclick = () => { const k = b.dataset.step; P.onion[k] = Math.max(0, Math.min(5, P.onion[k] + +b.dataset.d)); if (P.onion[k] > 0) P.onion.on = true; onionChanged(); };
  });

  // layers
  $('layer-add').onclick = layerActions.add;

  // fps
  $('fps-range').oninput = (e) => { P.fps = +e.target.value; updateFps(); saveMetaSoon(); };
  $('fps-presets').replaceChildren(...[4, 6, 8, 12, 15, 24].map((v) => {
    const b = document.createElement('button'); b.textContent = v; b.dataset.v = v; b.setAttribute('aria-label', v + ' frames per second');
    b.onclick = () => { P.fps = v; updateFps(); saveMetaSoon(); };
    return b;
  }));

  // scrubber: tap or drag to flip through frames
  const ticks = $('ticks');
  let scrubbing = false;
  ticks.addEventListener('pointerdown', (e) => { if (playing) stopPlay(); scrubbing = true; ticks.setPointerCapture(e.pointerId); goTo(tickIndex(e)); });
  ticks.addEventListener('pointermove', (e) => { if (scrubbing) { const i = tickIndex(e); if (i !== P.current) goTo(i); } });
  ticks.addEventListener('pointerup', () => { scrubbing = false; });
  ticks.addEventListener('pointercancel', () => { scrubbing = false; });
  ticks.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { goTo(P.current - 1); e.preventDefault(); }
    if (e.key === 'ArrowRight') { goTo(P.current + 1); e.preventDefault(); }
  });

  // keyboard (for a keyboard case or laptop)
  document.addEventListener('keydown', (e) => {
    if ($('editor').hidden || document.querySelector('dialog[open]') || e.target.matches('input, textarea')) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod) return;
    if (e.target.id === 'ticks') return;
    const k = e.key;
    if (k === 'ArrowLeft' || k === ',') goTo(P.current - 1);
    else if (k === 'ArrowRight' || k === '.') goTo(P.current + 1);
    else if (k === ' ') { e.preventDefault(); play(); }
    else if (k === 'p' || k === 'm') setTool('marker');
    else if (k === 'f') setTool('fuzzy');
    else if (k === 'e') setTool('eraser');
    else if (k === 'g') setTool('bucket');
    else if (k === 'o') { P.onion.on = !P.onion.on; onionChanged(); }
    else if (k === '+' || k === '=') zoomBy(1);
    else if (k === '-') zoomBy(-1);
    else if (k === '0') resetView();
    else if (k === 'n') frameActions.add();
    else if (k === 'd') frameActions.dup();
  });
}

function onionChanged() { updateOnionUI(); renderTicks(); renderOnion(); saveMetaSoon(); }

// What the export screen needs.
const exportApi = {
  get meta() { return P; },
  getFlat: (i) => getFlat(i),
  async allCells() {
    flushCurrent();
    const out = [];
    for (const fid of P.frames) for (const l of P.layers) {
      const b = await getCellBlob(fid, l.id);
      if (b) out.push({ fid, lid: l.id, blob: b });
    }
    return out;
  },
  markBackedUp() { P.lastBackup = Date.now(); saveMetaSoon(); },
};
