// Service worker: offline support + receiving PDFs from the Android share sheet.
// App files (html/css/js) are fetched network-first so an update is never mixed with old cached
// files; the cache is only used when offline. Large libraries in vendor/ are cache-first.
const VERSION = new URL(location.href).searchParams.get('v') || 'dev';
const CACHE = 'formfiller-' + VERSION;
const SHELL = [
  './', 'index.html', 'css/styles.css', 'manifest.webmanifest',
  'js/app.js', 'js/i18n.js', 'js/pdf.js', 'js/detect.js', 'js/fill.js', 'js/version.js',
  'vendor/pdf-lib.esm.min.js', 'vendor/pdfjs/pdf.min.mjs', 'vendor/pdfjs/pdf.worker.min.mjs',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('formfiller-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      const data = await e.request.formData();
      const file = data.get('pdf');
      if (file && file.size) {
        const c = await caches.open('ff-share');
        await c.put('shared-file', new Response(file, { headers: { 'content-type': 'application/pdf', 'x-name': encodeURIComponent(file.name || 'shared.pdf') } }));
      }
      return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
    })());
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const isNav = e.request.mode === 'navigate';
  const key = isNav ? new Request(new URL('./', self.registration.scope).href) : e.request;
  const vendor = url.pathname.includes('/vendor/');

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (vendor) {
      const hit = await cache.match(key);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) cache.put(key, res.clone());
      return res;
    }
    try {
      const res = await fetch(e.request, { cache: 'no-cache' });
      if (res.ok && res.type === 'basic') cache.put(key, res.clone());
      return res;
    } catch {
      const hit = await cache.match(key, { ignoreSearch: isNav });
      return hit || new Response('Offline', { status: 503 });
    }
  })());
});
