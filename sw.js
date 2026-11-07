/* Service Worker: العمل بدون إنترنت + استقبال الملفات المُشارَكة من تطبيقات أندرويد */
const CACHE = 'sawt-naqi-v3';
const SHARED = 'sawt-naqi-shared';
const ASSETS = ['./', 'index.html', 'style.css', 'app.js', 'dsp.js', 'dsp-worker.js', 'manifest.json',
  'icon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png',
  'vendor/rnnoise/rnnoise.js', 'vendor/rnnoise/rnnoise.wasm'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== SHARED).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/** مشاركة ← صوت نقي: يحفظ الملف مؤقتاً ثم يفتح التطبيق ليقرأه. */
async function handleShare(request) {
  try {
    const form = await request.formData();
    const file = form.getAll('audio').find((f) => f && typeof f !== 'string');
    if (file) {
      const cache = await caches.open(SHARED);
      await cache.put('shared-audio', new Response(file, {
        headers: {
          'content-type': file.type || 'application/octet-stream',
          'x-file-name': encodeURIComponent(file.name || 'تسجيل'),
        },
      }));
    }
  } catch (err) {
    // تجاهل: ستُظهر الصفحة رسالة بأن الملف لم يصل
  }
  return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith(handleShare(e.request));
    return;
  }
  if (e.request.method !== 'GET') return;
  // الشبكة أولاً ثم الذاكرة المؤقتة
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
  );
});
