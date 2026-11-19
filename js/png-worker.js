// Background helper: turns a snapshot of a layer into a PNG file, off the drawing thread,
// so saving never makes the Pencil stutter.
self.onmessage = async (e) => {
  const { id, bitmap } = e.data;
  try {
    const c = new OffscreenCanvas(bitmap.width, bitmap.height);
    c.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close();
    const blob = await c.convertToBlob({ type: 'image/png' });
    self.postMessage({ id, blob });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
