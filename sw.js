// 最小構成のservice worker。オフライン時にアプリの殻(HTML/CSS/JS)だけは開けるようにする。
// GAS APIへの通信自体はキャッシュしない(常に最新のシフト・掃除状況が必要なため)。
const CACHE_NAME = 'enosuke-app-shell-v1';
const SHELL_FILES = ['./', './index.html', './style.css', './app.js', './config.js', './manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // GASや他ドメインへのAPIリクエストはネットワーク直行(キャッシュしない)
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
