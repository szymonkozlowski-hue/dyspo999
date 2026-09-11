const CACHE_NAME = 'dyspozytornia-v1';
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
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_TO_CACHE))
  );
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => response || fetch(event.request))
  );
});
