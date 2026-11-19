// Export: GIF, MP4, PNG frames, backup file. No watermark, ever.
import { GIFEncoder, quantize, applyPalette } from '../vendor/gifenc.esm.js';
import { Muxer, ArrayBufferTarget } from '../vendor/mp4-muxer.mjs';
import { zipSync, unzipSync, strToU8, strFromU8 } from '../vendor/fflate.esm.js';
import { deliver, canShareFiles, slug, makeCanvas, canvasToBlob, nextTick, isTouchDevice } from './ui.js';
import * as store from './store.js';

const $ = (id) => document.getElementById(id);
let api = null, job = 0, ready = null, wired = false;

export function openExport(editorApi) {
  api = editorApi;
  wire();
  resetStatus();
  $('dlg-export').showModal();
}

function wire() {
  if (wired) return;
  wired = true;
  for (const id of ['gif-size', 'mp4-len']) {
    const seg = $(id);
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    });
  }
  document.querySelectorAll('[data-make]').forEach((b) => { b.onclick = () => run(b.dataset.make); });
  $('export-close').onclick = () => { job++; $('dlg-export').close(); };
  $('dlg-export').addEventListener('close', () => { job++; });
  $('export-save').onclick = async () => {
    if (!ready) return;
    const { files, zipName } = ready;
    if (files.length > 1 && !canShareFiles(files)) {
      // laptop: many PNGs go in one zip
      const entries = {};
      for (const f of files) entries[f.name] = [new Uint8Array(await f.arrayBuffer()), { level: 0 }];
      await deliver([new File([zipSync(entries)], zipName, { type: 'application/zip' })]);
    } else {
      await deliver(files);
    }
    if (ready.backup) api.markBackedUp();
  };
}

const choice = (id) => $(id).querySelector('[aria-checked="true"]').dataset.v;

function resetStatus() {
  ready = null;
  $('export-status').hidden = true;
  $('export-save').hidden = true;
  $('export-bar').style.width = '0';
}
function progress(frac, msg) {
  $('export-status').hidden = false;
  $('export-bar').style.width = Math.round(frac * 100) + '%';
  if (msg) $('export-msg').textContent = msg;
}

async function run(kind) {
  const my = ++job;
  resetStatus();
  document.querySelectorAll('[data-make]').forEach((b) => { b.disabled = true; });
  const alive = () => my === job;
  try {
    const name = slug(api.meta.name);
    let result;
    if (kind === 'gif') result = await makeGif(+choice('gif-size'), alive);
    if (kind === 'mp4') result = await makeMp4(choice('mp4-len'), alive);
    if (kind === 'png') result = await makePngs(alive);
    if (kind === 'backup') result = await makeBackup(alive);
    if (!result || !alive()) return;
    ready = { ...result, zipName: `${name}-frames.zip` };
    const size = result.files.reduce((n, f) => n + f.size, 0);
    progress(1, `${result.label} ready (${(size / 1e6).toFixed(size < 1e6 ? 2 : 1)} MB).`);
    $('export-save').textContent = isTouchDevice() ? 'Save or share' : 'Download';
    $('export-save').hidden = false;
  } catch (e) {
    console.error(e);
    if (alive()) progress(0, 'Something went wrong: ' + (e && e.message ? e.message : e));
  } finally {
    document.querySelectorAll('[data-make]').forEach((b) => { b.disabled = false; });
  }
}

// Draw frame i onto a white canvas of the given size.
async function frameOnWhite(i, ctx, w, h) {
  const flat = await api.getFlat(i);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(flat, 0, 0, w, h);
}

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

// ---------- GIF ----------
async function makeGif(scale, alive) {
  const P = api.meta, n = P.frames.length;
  const w = even(P.w * scale), h = even(P.h * scale);
  const c = makeCanvas(w, h), ctx = c.getContext('2d', { willReadFrequently: true });
  // 1) one shared colour palette, sampled from every frame (stops colours flickering)
  const total = w * h * n, stride = Math.max(1, Math.ceil(total / 500000));
  const sample = new Uint8ClampedArray((Math.ceil(total / stride) + n + 1) * 4);
  let s = 0, pos = 0;
  for (let i = 0; i < n; i++) {
    if (!alive()) return null;
    progress(i / n * 0.3, `Choosing colours… frame ${i + 1} of ${n}`);
    await frameOnWhite(i, ctx, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    for (let p = (stride - pos % stride) % stride; p < w * h; p += stride) {
      sample[s++] = d[p * 4]; sample[s++] = d[p * 4 + 1]; sample[s++] = d[p * 4 + 2]; sample[s++] = 255;
    }
    pos += w * h;
    await nextTick();
  }
  const palette = quantize(sample.subarray(0, s), 256);
  // 2) encode
  const gif = GIFEncoder();
  for (let i = 0; i < n; i++) {
    if (!alive()) return null;
    progress(0.3 + i / n * 0.7, `Making GIF… frame ${i + 1} of ${n}`);
    await frameOnWhite(i, ctx, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    const index = applyPalette(d, palette);
    gif.writeFrame(index, w, h, { palette: i === 0 ? palette : undefined, delay: 1000 / P.fps, repeat: i === 0 ? 0 : undefined });
    await nextTick();
  }
  gif.finish();
  const file = new File([gif.bytes()], `${slug(P.name)}.gif`, { type: 'image/gif' });
  return { files: [file], label: 'GIF' };
}

// ---------- MP4 ----------
function videoPlan(len) {
  const P = api.meta, n = P.frames.length, fps = P.fps;
  let loops = 1;
  if (len === 'x3') loops = 3;
  else if (len.endsWith('s')) loops = Math.max(1, Math.ceil(parseInt(len, 10) * fps / n));
  // Video players like 24–30 frames a second: hold each drawing for a whole number of video frames.
  const hold = fps >= 24 ? 1 : Math.ceil(24 / fps);
  return { n, loops, hold, rate: fps * hold, drawings: n * loops };
}

async function makeMp4(len, alive) {
  const P = api.meta;
  const w = even(P.w), h = even(P.h);
  const plan = videoPlan(len);
  if (!('VideoEncoder' in window)) return recordMp4(plan, w, h, alive);
  const codecs = ['avc1.640028', 'avc1.4d0028', 'avc1.42e028', 'avc1.640033', 'avc1.42e033'];
  let config = null;
  for (const codec of codecs) {
    const cfg = { codec, width: w, height: h, bitrate: 6_000_000, framerate: plan.rate, avc: { format: 'avc' } };
    try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) { config = cfg; break; } } catch { /* try next */ }
  }
  if (!config) return recordMp4(plan, w, h, alive);

  const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: 'avc', width: w, height: h, frameRate: plan.rate }, fastStart: 'in-memory' });
  let failed = null;
  const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { failed = e; } });
  enc.configure(config);
  const c = makeCanvas(w, h), ctx = c.getContext('2d');
  const dur = 1e6 / plan.rate;
  let k = 0;
  for (let d = 0; d < plan.drawings; d++) {
    if (!alive()) { enc.close(); return null; }
    if (failed) throw failed;
    progress(d / plan.drawings, `Making video… ${d + 1} of ${plan.drawings}`);
    await frameOnWhite(d % plan.n, ctx, w, h);
    for (let r = 0; r < plan.hold; r++, k++) {
      const vf = new VideoFrame(c, { timestamp: Math.round(k * dur), duration: Math.round(dur) });
      enc.encode(vf, { keyFrame: k % (plan.rate * 2) === 0 });
      vf.close();
    }
    while (enc.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 5));
  }
  await enc.flush();
  enc.close();
  if (failed) throw failed;
  muxer.finalize();
  const file = new File([muxer.target.buffer], `${slug(P.name)}.mp4`, { type: 'video/mp4' });
  return { files: [file], label: 'Video' };
}

// Fallback for browsers without the video encoder: record the canvas in real time.
async function recordMp4(plan, w, h, alive) {
  const type = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t));
  if (!type) throw new Error('This browser can’t make videos. Try Safari on the iPad.');
  const c = makeCanvas(w, h), ctx = c.getContext('2d');
  await frameOnWhite(0, ctx, w, h);
  const stream = c.captureStream(plan.rate);
  const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 6_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise((r) => { rec.onstop = r; });
  rec.start();
  const ms = 1000 / api.meta.fps, t0 = performance.now();
  for (let d = 0; d < plan.drawings; d++) {
    if (!alive()) { rec.stop(); return null; }
    progress(d / plan.drawings, `Recording video in real time… ${d + 1} of ${plan.drawings}`);
    await frameOnWhite(d % plan.n, ctx, w, h);
    const wait = t0 + (d + 1) * ms - performance.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  rec.stop();
  await stopped;
  const ext = type.startsWith('video/mp4') ? 'mp4' : 'webm';
  const file = new File(chunks, `${slug(api.meta.name)}.${ext}`, { type: type.split(';')[0] });
  return { files: [file], label: 'Video' };
}

// ---------- PNG frames ----------
async function makePngs(alive) {
  const P = api.meta, n = P.frames.length;
  const c = makeCanvas(P.w, P.h), ctx = c.getContext('2d');
  const files = [];
  const pad = String(n).length < 3 ? 3 : String(n).length;
  for (let i = 0; i < n; i++) {
    if (!alive()) return null;
    progress(i / n, `Making PNGs… frame ${i + 1} of ${n}`);
    await frameOnWhite(i, ctx, P.w, P.h);
    const blob = await canvasToBlob(c);
    files.push(new File([blob], `${slug(P.name)}-${String(i + 1).padStart(pad, '0')}.png`, { type: 'image/png' }));
  }
  return { files, label: `${n} PNG frame${n === 1 ? '' : 's'}` };
}

// ---------- backup ----------
async function makeBackup(alive) {
  progress(0.1, 'Packing your project…');
  const P = api.meta;
  const cells = await api.allCells();
  if (!alive()) return null;
  const { thumb, ...meta } = P;
  const entries = { 'flipout.json': [strToU8(JSON.stringify({ app: 'flipout', format: 1, savedAt: new Date().toISOString(), project: meta })), { level: 6 }] };
  let i = 0;
  for (const c of cells) {
    entries[`cells/${c.fid}_${c.lid}.png`] = [new Uint8Array(await c.blob.arrayBuffer()), { level: 0 }];
    if (++i % 20 === 0) progress(0.1 + 0.8 * i / cells.length);
  }
  const stamp = new Date().toISOString().slice(0, 10);
  const file = new File([zipSync(entries)], `${slug(P.name)}-${stamp}.flipout`, { type: 'application/zip' });
  return { files: [file], label: 'Backup file', backup: true };
}

// Open a backup file as a new animation (never overwrites one you have).
export async function importBackup(file) {
  const files = unzipSync(new Uint8Array(await file.arrayBuffer()));
  if (!files['flipout.json']) throw new Error('That isn’t a Flipout backup file.');
  const data = JSON.parse(strFromU8(files['flipout.json']));
  const meta = data.project;
  if (!meta || !Array.isArray(meta.frames) || !Array.isArray(meta.layers)) throw new Error('That backup file looks damaged.');
  const existing = await store.getProject(meta.id);
  if (existing) { meta.id = store.uid(); meta.name = meta.name + ' (from backup)'; }
  meta.updatedAt = Date.now();
  const cells = [];
  for (const [path, bytes] of Object.entries(files)) {
    const m = path.match(/^cells\/([^_/]+)_([^_/]+)\.png$/);
    if (m) cells.push({ fid: m[1], lid: m[2], buf: bytes.slice().buffer });
  }
  await store.putCells(meta.id, cells);
  // thumbnail from frame 1
  try {
    const W = meta.w, H = meta.h, c = makeCanvas(240, Math.round(240 * H / W)), ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    for (const l of meta.layers) {
      if (!l.visible || l.guide) continue;
      const cell = cells.find((x) => x.fid === meta.frames[0] && x.lid === l.id);
      if (!cell) continue;
      const bmp = await createImageBitmap(new Blob([cell.buf], { type: 'image/png' }));
      ctx.drawImage(bmp, 0, 0, c.width, c.height);
    }
    meta.thumb = await (await canvasToBlob(c)).arrayBuffer();
  } catch { /* no thumbnail */ }
  await store.putProject(meta);
  return meta;
}
