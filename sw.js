// Service worker: offline support + receiving PDFs from the Android share sheet.
const VERSION = new URL(location.href).searchParams.get('v') || 'dev';
const CACHE = 'formfiller-' + VERSION;
const SHELL = [
  './', 'index.html', 'css/styles.css', 'manifest.webmanifest',
  'js/app.js', 'js/i18n.js', 'js/pdf.js', 'js/detect.js', 'js/fill.js', 'js/version.js',
  'vendor/pdf-lib.esm.min.js', 'vendor/pdfjs/pdf.min.mjs', 'vendor/pdfjs/pdf.worker.min.mjs',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('formfiller-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
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
  // cache first (fast + offline), refresh in the background
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const req = e.request.mode === 'navigate' ? new Request(new URL('./', self.registration.scope).href) : e.request;
    const cached = await cache.match(req, { ignoreSearch: e.request.mode === 'navigate' });
    const network = fetch(e.request).then((res) => {
      if (res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    if (cached) { e.waitUntil(network); return cached; }
    return (await network) || new Response('Offline', { status: 503 });
  })());
});
