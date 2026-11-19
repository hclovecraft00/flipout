// Keeps Flipout working offline. Shows the saved copy straight away and
// fetches any update in the background, so a new version appears next launch.
const CACHE = 'flipout-v2';
const FILES = [
  './', 'index.html', 'style.css', 'manifest.webmanifest',
  'js/main.js', 'js/editor.js', 'js/brushes.js', 'js/exporter.js', 'js/fill.js', 'js/store.js', 'js/ui.js',
  'vendor/gifenc.esm.js', 'vendor/mp4-muxer.mjs', 'vendor/fflate.esm.js',
  'fonts/mochiy-pop-one.woff2', 'fonts/mplus-rounded-500.woff2', 'fonts/mplus-rounded-800.woff2',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const cached = await cache.match(e.request, { ignoreSearch: true });
    const fresh = fetch(e.request).then((res) => {
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    }).catch(() => cached);
    return cached || fresh;
  }));
});
