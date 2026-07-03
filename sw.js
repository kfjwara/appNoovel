importScripts('./js/version.js');

const CACHE = 'noovel-v' + NOOVEL_VERSION;
const ASSETS = ['./', './index.html', './css/style.css', './js/app.js', './js/convert.js', './js/version.js', './js/pdfjs/pdf.min.mjs', './js/pdfjs/pdf.worker.min.mjs', './manifest.json', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
