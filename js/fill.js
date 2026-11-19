// Paint bucket: fills the area you tap, using only the lines on the current layer.
// Empty area: small gaps in grainy pencil/crayon lines are closed first so the colour
// doesn't leak, then the colour slides under the lines (no white halo along soft edges).
// Coloured area: recolours it.

const GAP = 2; // pixels of gap that count as closed

export function floodFill(ctx, W, H, sx, sy, hex) {
  sx = Math.floor(sx); sy = Math.floor(sy);
  if (sx < 0 || sy < 0 || sx >= W || sy >= H) return null;
  const [fr, fg, fb] = hexToRgb(hex);
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  const i0 = sy * W + sx;
  const sa = d[i0 * 4 + 3];
  const sr = d[i0 * 4], sg = d[i0 * 4 + 1], sb = d[i0 * 4 + 2];
  const emptySeed = sa < 128;
  if (!emptySeed && Math.abs(sr - fr) + Math.abs(sg - fg) + Math.abs(sb - fb) < 6) return null;

  let match;
  if (emptySeed) {
    const wall = thickWalls(d, W, H);
    if (wall[i0]) return null; // tapped right on a line
    match = (i) => !wall[i];
  } else {
    match = (i) => d[i * 4 + 3] >= 128 && Math.abs(d[i * 4] - sr) + Math.abs(d[i * 4 + 1] - sg) + Math.abs(d[i * 4 + 2] - sb) < 90;
  }

  const mask = new Uint8Array(W * H);
  let minX = sx, maxX = sx, minY = sy, maxY = sy;
  const stack = [sx, sy];
  while (stack.length) {
    const y = stack.pop(), x0 = stack.pop();
    let x = x0;
    const row = y * W;
    if (mask[row + x] || !match(row + x)) continue;
    while (x > 0 && !mask[row + x - 1] && match(row + x - 1)) x--;
    let upOpen = false, downOpen = false;
    for (; x < W && !mask[row + x] && match(row + x); x++) {
      mask[row + x] = 1;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y > 0) {
        const up = row - W + x, ok = !mask[up] && match(up);
        if (ok && !upOpen) { stack.push(x, y - 1); upOpen = true; } else if (!ok) upOpen = false;
      }
      if (y < H - 1) {
        const dn = row + W + x, ok = !mask[dn] && match(dn);
        if (ok && !downOpen) { stack.push(x, y + 1); downOpen = true; } else if (!ok) downOpen = false;
      }
    }
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }

  // reach back under the lines: the gap we closed, plus 2px for soft edges
  const pad = emptySeed ? GAP + 2 : 0;
  const bx = Math.max(0, minX - pad), by = Math.max(0, minY - pad);
  const ex = Math.min(W - 1, maxX + pad), ey = Math.min(H - 1, maxY + pad);
  const m = pad ? dilate(mask, W, H, pad, bx, by, ex, ey) : mask;
  const before = region(d, W, bx, by, ex - bx + 1, ey - by + 1); // for undo

  for (let y = by; y <= ey; y++) {
    for (let x = bx; x <= ex; x++) {
      const i = y * W + x;
      if (!m[i]) continue;
      const p = i * 4;
      if (emptySeed) {
        // the existing line stays on top of the new colour
        const a = d[p + 3] / 255;
        d[p] = Math.round(d[p] * a + fr * (1 - a));
        d[p + 1] = Math.round(d[p + 1] * a + fg * (1 - a));
        d[p + 2] = Math.round(d[p + 2] * a + fb * (1 - a));
        d[p + 3] = 255;
      } else {
        d[p] = fr; d[p + 1] = fg; d[p + 2] = fb;
      }
    }
  }
  const box = { x: bx, y: by, w: ex - bx + 1, h: ey - by + 1 };
  ctx.putImageData(img, 0, 0, box.x, box.y, box.w, box.h);
  // Undo copies come from the pixels we already have. (Copying the canvas instead
  // can catch the after-fill picture in Safari, which delays canvas copies.)
  return { ...box, before, after: region(d, W, box.x, box.y, box.w, box.h) };
}

function region(d, W, x, y, w, h) {
  const out = new ImageData(w, h);
  for (let r = 0; r < h; r++) out.data.set(d.subarray(((y + r) * W + x) * 4, ((y + r) * W + x + w) * 4), r * w * 4);
  return out;
}

// Line pixels, grown by GAP so small holes in grainy strokes count as closed.
function thickWalls(d, W, H) {
  const base = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) base[i] = d[i * 4 + 3] > 40 ? 1 : 0;
  return dilate(base, W, H, GAP, 0, 0, W - 1, H - 1);
}

// Grow a mask by r pixels (square), within a box. Done in two passes (rows, then columns).
function dilate(src, W, H, r, bx, by, ex, ey) {
  const tmp = new Uint8Array(W * H), out = new Uint8Array(W * H);
  const y0 = Math.max(0, by - r), y1 = Math.min(H - 1, ey + r);
  for (let y = y0; y <= y1; y++) {
    const row = y * W;
    for (let x = bx; x <= ex; x++) {
      const a = Math.max(0, x - r), b = Math.min(W - 1, x + r);
      for (let k = a; k <= b; k++) if (src[row + k]) { tmp[row + x] = 1; break; }
    }
  }
  for (let y = by; y <= ey; y++) {
    const a = Math.max(0, y - r), b = Math.min(H - 1, y + r);
    for (let x = bx; x <= ex; x++) {
      for (let k = a; k <= b; k++) if (tmp[k * W + x]) { out[y * W + x] = 1; break; }
    }
  }
  return out;
}

export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
