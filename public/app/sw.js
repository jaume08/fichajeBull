/* Service worker: l'app funciona sense cobertura. Les dades no es desen aquí sinó a IndexedDB (app.js). */
const CACHE = 'fichaje-shell-v1';
const SHELL = ['/app/', '/app/index.html', '/app/app.css', '/app/app.js', '/app/manifest.webmanifest', '/shared/icon.svg'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())
));
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return; // l'API mai es cacheja
  e.respondWith(fetch(e.request).then(r => {
    const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r;
  }).catch(() => caches.match(e.request).then(r => r || caches.match('/app/index.html'))));
});
