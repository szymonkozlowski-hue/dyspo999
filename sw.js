const CACHE_NAME = 'dyspozytornia-v2';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './app.js',
  './config.js',
  './logo1.png',
  './logo2.png',
  './czekaj.mp3',
  './czekajcpr.mp3',
  './aed_database.json',
  './procedury.txt'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_TO_CACHE))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const isAppCode = url.pathname.endsWith('.js') || url.pathname.endsWith('.html') || url.pathname.endsWith('/');
  if (isAppCode) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }
  event.respondWith(
    caches.match(event.request).then((response) => response || fetch(event.request))
  );
});
