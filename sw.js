// Service worker: the app opens with no internet, and waiting entries upload when the
// internet returns, even with the app closed (Chrome's Background Sync).
importScripts('queue.js');

const CACHE = 'gate-v1';
const FILES = ['./', 'index.html', 'app.js', 'queue.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  const fresh = FILES.map((f) => new Request(f, { cache: 'reload' }));
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(fresh)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// App files: answer from the cache at once, refresh the cache in the background
// (asking the server, not the browser's HTTP cache). A code update shows on the second opening.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const key = url.pathname;   // one cache entry per file, whatever the query string
  const net = caches.open(CACHE).then((c) => fetch(e.request, { cache: 'no-cache' }).then((r) => {
    if (r.ok && !r.redirected) return c.put(key, r.clone()).then(() => r);
    return r;
  }));
  e.waitUntil(net.catch(() => {}));
  e.respondWith(caches.match(key).then((hit) => hit || net));
});

// Rejecting tells Chrome to try again later.
self.addEventListener('sync', (e) => {
  if (e.tag === 'upload') e.waitUntil(Q.flush().then((done) => { if (!done) throw new Error('entries still waiting'); }));
});
