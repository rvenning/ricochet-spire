// Ricochet Spire service worker.
// Network-first with a cache fallback: online players always get the newest
// deploy, offline players get the last version they loaded. Firestore sync
// degrades gracefully offline because gk-storage falls back to localStorage.
//
// BUMP THE CACHE NAME whenever any shell file below changes, or devices keep
// serving the copy they already have and the fix never lands.

const CACHE = "ricochet-spire-v8";

const SHELL = [
  "./",
  "index.html",
  "manifest.json",
  "css/style.css",
  "lib/gk-base.css",
  "lib/gk-util.js",
  "lib/gk-audio.js",
  "lib/gk-ui.js",
  "lib/gk-storage.js",
  "lib/gk-profiles.js",
  "lib/gk-pwa.js",
  "lib/gk-fx.js",
  "lib/gk-debug.js",
  "js/firebase-config.js",
  "js/rng.js",
  "js/physics.js",
  "js/cards.js",
  "js/bricks.js",
  "js/powerups.js",
  "js/arenas.js",
  "js/game.js",
  "js/bosses.js",
  "js/events.js",
  "js/unlocks.js",
  "js/run.js",
  "js/storage.js",
  "js/audio.js",
  "js/render.js",
  "js/main.js",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // Same-origin GETs only. Google Fonts and Firebase traffic pass through.
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req, { ignoreSearch: true }).then(
          (hit) => hit || (req.mode === "navigate" ? caches.match("index.html") : Response.error())
        )
      )
  );
});
