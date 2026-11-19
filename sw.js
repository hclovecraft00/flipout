// Keeps Flipout working offline.
// Online: always asks GitHub for the latest files (so a new version never arrives half
// old, half new) and keeps a copy. Offline, or if the connection is very slow: uses the copy.
const CACHE = 'flipout-v9';
const FILES = [
  './', 'index.html', 'style.css', 'manifest.webmanifest',
  'js/main.js', 'js/editor.js', 'js/brushes.js', 'js/png-worker.js', 'js/exporter.js', 'js/fill.js', 'js/store.js', 'js/ui.js',
  'vendor/gifenc.esm.js', 'vendor/mp4-muxer.mjs', 'vendor/fflate.esm.js',
  'fonts/mochiy-pop-one.woff2', 'fonts/mplus-rounded-500.woff2', 'fonts/mplus-rounded-800.woff2',
  'icons/icon-32.png', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // 'no-cache' = check with GitHub every time (it answers "not changed" quickly when nothing is new)
    const fresh = fetch(e.request, { cache: 'no-cache' }).then((res) => {
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    });
    const slow = new Promise((resolve) => setTimeout(resolve, 4000));
    try {
      const res = await Promise.race([fresh, slow]);
      if (res) return res;
    } catch { /* offline */ }
    const cached = await cache.match(e.request, { ignoreSearch: true });
    return cached || fresh;
  })());
});
