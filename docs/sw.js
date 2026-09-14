/* ============================================================================
 * sw.template.js: the service worker. build.ps1 stamps the version and
 * writes docs/sw.js; do not edit that file by hand.
 *
 * What it does, and no more:
 *   - precaches the shell (the page, the manifest, the icons) at install;
 *   - serves navigations and data/*.json network-first, falling back to the
 *     cache when offline. A deploy shows on the next load, and the page
 *     still opens on a plane with the last snapshots it saw;
 *   - serves icons and the manifest cache-first;
 *   - never touches another origin: CoinGecko, Coinbase and the fonts pass
 *     straight through.
 * The cache name carries the build hash, so a new build purges the old one.
 * ========================================================================== */
/* eslint-env serviceworker */
var VERSION = 'ea4dd78a085f';
var CACHE = 'mm-' + VERSION;
var SHELL = [
  './',
  './index.html',
  './findings.html',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png'
];

/* One missing file (an icon, the debug server's absent index.html) must not
 * block installation, so each shell entry is added on its own. */
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE)
      .then(function (cache) {
        return Promise.all(SHELL.map(function (url) {
          return cache.add(url).catch(function () { /* skipped */ });
        }));
      })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k.indexOf('mm-') === 0 && k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

/* The page appends ?t=<minute> to snapshot reads to sidestep the Pages
 * cache; the worker stores and matches them without it. */
function stripSearch(request) {
  var u = new URL(request.url);
  u.search = '';
  return new Request(u.toString(), { method: 'GET', credentials: 'same-origin' });
}

/* "network-first" must mean the network, not the browser's heuristic HTTP
 * cache: revalidate every time (cheap on Pages, which sends ETags). A
 * navigation request cannot be re-issued with options, so go by URL. */
function fromNetwork(request) {
  return fetch(request.url, { cache: 'no-cache', credentials: 'same-origin' });
}

function networkFirst(request, key, fallback) {
  return fromNetwork(request).then(function (res) {
    if (res && res.ok) {
      var copy = res.clone();
      caches.open(CACHE).then(function (cache) { cache.put(key, copy); });
    }
    return res;
  }).catch(function () {
    return caches.match(key, { ignoreSearch: true }).then(function (hit) {
      if (hit) return hit;
      if (fallback) return caches.match(fallback);
      return Response.error();
    });
  });
}

function cacheFirst(request) {
  return caches.match(request).then(function (hit) {
    if (hit) return hit;
    return fetch(request).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (cache) { cache.put(request, copy); });
      }
      return res;
    });
  });
}

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;      /* other origins pass through */

  if (/\/data\/(?:stocks\/)?[^/]+\.json$/.test(url.pathname)) {
    event.respondWith(networkFirst(req, stripSearch(req), null));
    return;
  }
  if (req.mode === 'navigate' || /\/(index|findings)\.html$/.test(url.pathname)) {
    var page = /\/findings\.html$/.test(url.pathname) ? './findings.html' : './index.html';
    event.respondWith(networkFirst(req, req, page));
    return;
  }
  if (/\/icons\/|\/manifest\.webmanifest$/.test(url.pathname)) {
    event.respondWith(cacheFirst(req));
  }
});
