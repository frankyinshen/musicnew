var CACHE_NAME = 'player-shell-v2.4.21'; // 版本号更新
var SHELL_URL  = '/';

self.addEventListener('install', function(e) {
    e.waitUntil(
        caches.open(CACHE_NAME).then(function(cache) {
            return cache.add(SHELL_URL);
        })
    );
    self.skipWaiting();
});

self.addEventListener('activate', function(e) {
    e.waitUntil(
        caches.keys().then(function(keys) {
            return Promise.all(
                keys.filter(function(k) { return k !== CACHE_NAME; })
                    .map(function(k) { return caches.delete(k); })
            );
        })
    );
    self.clients.claim();
});

self.addEventListener('fetch', function(e) {
    var req = e.request;
    if (req.method !== 'GET') return;

    if (req.mode === 'navigate') {
        var fetchPromise = fetch(req).then(function(resp) {
            if (resp && resp.ok) {
                var respClone = resp.clone();
                caches.open(CACHE_NAME).then(function(cache) {
                    cache.put(SHELL_URL, respClone);
                });
            }
            return resp;
        });

        e.waitUntil(fetchPromise.catch(function(){}));

        e.respondWith(
            caches.match(SHELL_URL).then(function(cached) {
                return cached || fetchPromise;
            })
        );
        return;
    }

    if (req.url.startsWith(self.location.origin)) {
        var fetchPromise2 = fetch(req).then(function(resp) {
            if (resp && resp.ok) {
                var respClone = resp.clone();
                caches.open(CACHE_NAME).then(function(cache) {
                    cache.put(req, respClone);
                });
            }
            return resp;
        });
        
        e.waitUntil(fetchPromise2.catch(function(){}));

        e.respondWith(
            caches.match(req).then(function(cached) {
                return cached || fetchPromise2;
            })
        );
    }
});
