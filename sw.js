/* Service Worker: يتيح فتح التطبيق بدون إنترنت (الشبكة أولاً ثم الذاكرة المؤقتة) */
const CACHE = 'sawt-naqi-v2';
const ASSETS = ['./', 'index.html', 'style.css', 'app.js', 'dsp.js', 'dsp-worker.js', 'manifest.json', 'icon.svg',
  'vendor/rnnoise/rnnoise.js', 'vendor/rnnoise/rnnoise.wasm'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('index.html')))
  );
});
