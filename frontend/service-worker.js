const CACHE_NAME = "code-explainer-v1";
const urlsToCache = [
  "/",
  "/login.html",
  "/index.html",
  "/styles.css",
  "/login.css",
  "/manifest.json"
];

// Install
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(urlsToCache))
  );
});

// Fetch
self.addEventListener("fetch", (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request);
    })
  );
});
