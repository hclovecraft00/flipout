// Small shared helpers: toast messages, handing files to the share sheet or downloads.

const $ = (id) => document.getElementById(id);
let toastTimer = null;

export function toast(msg, actionLabel, action, ms = 3500) {
  const el = $('toast'), btn = $('toast-action');
  $('toast-msg').textContent = msg;
  btn.hidden = !actionLabel;
  btn.textContent = actionLabel || '';
  btn.onclick = () => { el.hidden = true; action && action(); };
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, actionLabel ? Math.max(ms, 6000) : ms);
}

export function hideToast() { $('toast').hidden = true; clearTimeout(toastTimer); }

export const isTouchDevice = () => navigator.maxTouchPoints > 1;

export function canShareFiles(files) {
  try { return isTouchDevice() && !!navigator.canShare && navigator.canShare({ files }); } catch { return false; }
}

// Must be called from a tap (the share sheet needs one).
export async function deliver(files) {
  if (canShareFiles(files)) {
    try { await navigator.share({ files }); return true; }
    catch (e) { if (e && e.name === 'AbortError') return false; }
  }
  for (const f of files) download(f);
  return true;
}

export function download(file) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

export function slug(name) {
  return (name || 'animation').trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'animation';
}

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

export function canvasToBlob(canvas, type = 'image/png', quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not make image'))), type, quality);
  });
}

export const nextTick = () => new Promise((r) => setTimeout(r, 0));
