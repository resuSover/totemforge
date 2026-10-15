// © 2026 Totem Forge. All rights reserved.
// Service worker: the app works offline once opened, and Android's "Share to Totem Forge" lands here.
// Online, every file comes from the network (so updates show up straight away) and a copy is kept;
// offline, or when the network takes longer than 4 s, the kept copy is used. "From the network"
// skips the browser's own cache: the website lets browsers reuse files for 10 minutes, and right
// after a publish that could mix new and old files.
const CACHE = 'totemforge-app';
const SHARED = 'totemforge-shared';
// Everything the app needs offline; tests/run.py checks this list against the web folder
const FILES = [
  './',
  'css/app.css',
  'css/fonts.css',
  'data/classic-fantasy.tfc',
  'fonts/AlegreyaSans-400-latin-ext.woff2',
  'fonts/AlegreyaSans-400-latin.woff2',
  'fonts/AlegreyaSans-700-latin-ext.woff2',
  'fonts/AlegreyaSans-700-latin.woff2',
  'fonts/Cinzel-700-latin-ext.woff2',
  'fonts/Cinzel-700-latin.woff2',
  'fonts/Cinzel-900-latin-ext.woff2',
  'fonts/Cinzel-900-latin.woff2',
  'icon.png',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
  'index.html',
  'js/app.js',
  'js/core/base.js',
  'js/core/gallerydir.js',
  'js/core/imaging.js',
  'js/core/protocol.js',
  'js/core/store.js',
  'js/core/tfc.js',
  'js/core/zip.js',
  'js/platform/fakebase.js',
  'js/platform/files.js',
  'js/platform/folder.js',
  'js/platform/install.js',
  'js/platform/transport.js',
  'manifest.webmanifest'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== SHARED).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) return e.respondWith(receiveShare(e.request));
  if (e.request.method === 'GET') e.respondWith(networkFirst(e.request));
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  let response = null;
  try { response = await withTimeout(fetch(fresh(request)), 4000); } catch {}
  if (response && response.ok) {
    if (response.type === 'basic' && !new URL(request.url).search) cache.put(request, response.clone());
    return response;
  }
  return await cache.match(request, { ignoreSearch: true })
      || (request.mode === 'navigate' && await cache.match('./'))
      || response || Response.error();
}
// The same request, but checked with the website even if the browser has a copy ("no-cache"); a
// page load can't be given options, so it's asked again by its address
const fresh = request => request.mode === 'navigate'
  ? new Request(request.url, { cache: 'no-cache', credentials: request.credentials })
  : new Request(request, { cache: 'no-cache' });
const withTimeout = (promise, ms) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('timeout')), ms);
  promise.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
});

// The shared file waits in its own cache until the app opens with ?shared=1 and takes it
async function receiveShare(request) {
  try {
    const files = (await request.formData()).getAll('file').filter(f => typeof f !== 'string');
    if (files.length) {
      await (await caches.open(SHARED)).put('shared-file', new Response(files[0], { headers: {
        'Content-Type': files[0].type || 'application/octet-stream',
        'X-File-Name': encodeURIComponent(files[0].name || 'shared'),
        'X-Count': String(files.length)
      } }));
    }
  } catch {}
  return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
}
