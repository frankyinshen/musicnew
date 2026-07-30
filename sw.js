var CACHE_NAME = 'player-shell-v2.4.29';
var SHELL_URL  = '/';
var IDB_NAME   = 'AudioOfflineCache';
var IDB_STORE  = 'audios';
var IDB_VERSION = 1;
var AUDIO_EXTS = ['.mp3','.wav','.flac','.m4a','.aac','.ogg','.opus'];

// SW 内存缓存，防止频繁 Range 请求导致反复读取 IDB 造成内存溢出
var _swAudioCache = { url: null, buffer: null };

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

function parseRange(rangeHeader, totalLength) {
    if (!rangeHeader) return { start: 0, end: totalLength - 1 };
    var parts = rangeHeader.replace(/bytes=/, "").split("-");
    var start = parseInt(parts[0], 10);
    var end = parts[1] ? parseInt(parts[1], 10) : totalLength - 1;
    if (isNaN(start)) start = 0;
    if (isNaN(end)) end = totalLength - 1;
    return { start: start, end: end };
}

function _guessMime(url) {
    var u = url.toLowerCase();
    if (u.indexOf('.mp3')  > -1) return 'audio/mpeg';
    if (u.indexOf('.m4a')  > -1) return 'audio/mp4';
    if (u.indexOf('.aac')  > -1) return 'audio/aac';
    if (u.indexOf('.ogg')  > -1) return 'audio/ogg';
    if (u.indexOf('.flac') > -1) return 'audio/flac';
    if (u.indexOf('.wav')  > -1) return 'audio/wav';
    if (u.indexOf('.opus') > -1) return 'audio/ogg';
    return 'audio/mpeg';
}

function getAudioFromIndexedDB(url) {
    if (_swAudioCache.url === url && _swAudioCache.buffer) {
        return Promise.resolve(_swAudioCache.buffer);
    }
    return new Promise(function(resolve) {
        if (typeof indexedDB === 'undefined' || !indexedDB) {
            resolve(null); return;
        }
        var req = indexedDB.open(IDB_NAME, IDB_VERSION);
        req.onupgradeneeded = function(e) {
            var db = e.target.result;
            if (!db.objectStoreNames.contains(IDB_STORE)) {
                db.createObjectStore(IDB_STORE);
            }
        };
        req.onerror = function() { resolve(null); };
        req.onsuccess = function(e) {
            var db = e.target.result;
            if (!db.objectStoreNames.contains(IDB_STORE)) {
                resolve(null); return;
            }
            try {
                var tx = db.transaction(IDB_STORE, 'readonly');
                var getReq = tx.objectStore(IDB_STORE).get(url);
                getReq.onsuccess = function() {
                    var res = getReq.result || null;
                    if (res) {
                        _swAudioCache = { url: url, buffer: res };
                    }
                    resolve(res);
                };
                getReq.onerror = function() { resolve(null); };
            } catch (err) { resolve(null); }
        };
    });
}

self.addEventListener('fetch', function(e) {
    var req = e.request;
    if (req.method !== 'GET') return;

    var url = req.url;
    var isAudio = AUDIO_EXTS.some(function(ext) {
        return url.toLowerCase().split('?')[0].endsWith(ext);
    });

    if (isAudio) {
        e.respondWith(
            getAudioFromIndexedDB(url).then(function(buffer) {
                if (!buffer) {
                    _swAudioCache = { url: null, buffer: null };
                    return fetch(req);
                }
                
                var total = buffer.byteLength;
                var rangeHeader = req.headers.get('Range');
                var range = parseRange(rangeHeader, total);
                
                // [优化 1] iOS 经常发送超大 end 的探测请求，必须截断而不是报错
                if (range.start >= total) {
                    return new Response('', {
                        status: 416,
                        headers: { 'Content-Range': 'bytes */' + total }
                    });
                }
                range.end = Math.min(range.end, total - 1);
                
                var sliced = buffer.slice(range.start, range.end + 1);
                var mime = _guessMime(url);
                
                return new Response(sliced, {
                    status: rangeHeader ? 206 : 200,
                    statusText: rangeHeader ? 'Partial Content' : 'OK',
                    headers: {
                        'Content-Type': mime,
                        'Content-Length': String(sliced.byteLength),
                        'Content-Range': 'bytes ' + range.start + '-' + range.end + '/' + total,
                        'Accept-Ranges': 'bytes'
                    }
                });
            }).catch(function() {
                return fetch(req);
            })
        );
        return;
    }

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
        var urlPath = new URL(req.url).pathname;
        if (urlPath.indexOf('/_api/') === 0 || urlPath === '/sw.js') return;

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
