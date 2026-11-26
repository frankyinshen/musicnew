/* 英语精听播放器 Service Worker v2.9.3 */
var CACHE_NAME = 'player-shell-v2.9.3';
var SHELL_URL  = '/';
var IDB_NAME   = 'AudioOfflineCache';
var IDB_STORE  = 'audios';
var IDB_SUB_STORE = 'subtitles';   // v2.6.0：字幕离线 store
var IDB_VERSION = 2;               // v2.6.0：1→2，新增 subtitles（旧 audios 数据保留）
var AUDIO_EXTS = ['.mp3','.wav','.flac','.m4a','.aac','.ogg','.opus'];
var SUBTITLE_EXTS = ['.lrc','.srt','.ass'];

// 统一 IDB key：一律用解码后的 URL。
// 原因：浏览器发出的请求 req.url 是百分号编码形式，而页面端写入 IDB 用的是未编码 URL，
// 中文/空格文件名若不统一，SW 查询永远 miss（v2.5.0 及之前的遗留 bug，本轮修复）。
function _swKey(url) {
    try { return decodeURIComponent(url); } catch (e) { return url; }
}

// SW 内存缓存：避免同一文件反复 Range 请求时反复读 IDB。
// 页面删除缓存后会通过 postMessage 通知这里失效，防止“幽灵缓存”返回旧数据。
// v2.6.0：url 字段统一存解码 key，与页面端 invalidate 消息完全对齐。
var _swAudioCache = { url: null, buffer: null, ts: 0 };
var _swSubCache = {};      // v2.6.0：字幕内存缓存 { 解码key: ArrayBuffer | string(老数据) }（上限 64 条）
var _swSubCacheKeys = [];
var _swIDB = null; // 复用 IDB 连接，避免频繁 indexedDB.open

// ===== v2.7.0·P1-3.2 已缓存音频键集合（解码形式）=====
// 集合就绪后，未缓存的音频请求同步直接放行（不调用 respondWith），
// 浏览器与 CDN 原生直连 —— 消除 SW 异步 IDB 查询的 IPC 延迟与 iOS SW 流卡顿。
var _cachedAudioKeySet = {};
var _audioKeysReady = false;
var _AUDIO_MEM_MAX = 15 * 1048576;   // 仅缓存 <=15MB 的音频进内存（防长音频撑爆 SW 进程）
var _AUDIO_MEM_TTL = 60000;          // 60 秒无访问自动释放引用

function _initAudioKeySet() {
    if (_audioKeysReady) return Promise.resolve();
    return _openIDB().then(function(db) {
        // 【v2.9.3 修复】打开失败（iOS 回收后重开失败/隐私模式等）不标记就绪：
        // 旧版置 true 会拿空集合把已缓存音频全部同步放行到网络，离线播放失灵。
        // 保持未就绪 → 下一个音频请求重试初始化（音频分支已有 not-ready 兑底路径）
        if (!db) return;
        if (!db.objectStoreNames || !db.objectStoreNames.contains(IDB_STORE)) {
            _audioKeysReady = true;   // 库确实没有该 store（全新安装）：空集合是事实
            return;
        }
        return new Promise(function(resolve) {
            try {
                var req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).getAllKeys();
                req.onsuccess = function() {
                    (req.result || []).forEach(function(k) { _cachedAudioKeySet[k] = true; });
                    _audioKeysReady = true;
                    resolve();
                };
                // 【v2.9.3】事务失败（死句柄等）不置就绪：下个请求重试，
                // 避免一次瞬时故障把空集合钉死到 SW 生命周期结束
                req.onerror = function() { resolve(); };
            } catch(e) { resolve(); }
        });
    });
}

self.addEventListener('install', function(e) {
    e.waitUntil(
        caches.open(CACHE_NAME).then(function(cache) {
            // no-cache 确保安装时拿到的是最新壳文件，新版本部署后能及时触达
            var shellReq = SHELL_URL;
            try { shellReq = new Request(SHELL_URL, { cache: 'no-cache' }); } catch(err) {}
            return cache.add(shellReq);
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
        }).then(function() { return self.clients.claim(); })
         .then(function() { return _initAudioKeySet(); })   // v2.7.0：激活即装载已缓存键集合
    );
});

// 页面 → SW 消息：删除缓存后同步失效内存缓存
self.addEventListener('message', function(e) {
    var msg = e.data || {};
    if (msg.type === 'invalidate-audio' && msg.url) {
        // v2.7.0：键集合同步移除（否则 SW 会继续拦截一个已删除的缓存去查 IDB）
        delete _cachedAudioKeySet[_swKey(msg.url)];
        // v2.6.0：双向解码比较，编码/未编码的 msg.url 都能命中
        if (_swAudioCache.url === _swKey(msg.url) || _swAudioCache.url === msg.url) {
            _swAudioCache = { url: null, buffer: null, ts: 0 };
        }
    } else if (msg.type === 'cache-audio-added' && msg.url) {
        // v2.7.0·P1-3.2：页面端 _idbPut 成功 → 新缓存立即可被拦截（直连→拦截的无缝切换）
        _cachedAudioKeySet[_swKey(msg.url)] = true;
    } else if (msg.type === 'invalidate-subtitle' && msg.url) {
        var sk = _swKey(msg.url);
        delete _swSubCache[sk];
        var ki = _swSubCacheKeys.indexOf(sk);
        if (ki > -1) _swSubCacheKeys.splice(ki, 1);
        _openIDB().then(function(db) {
            if (db && db.objectStoreNames && db.objectStoreNames.contains(IDB_SUB_STORE)) {
                try { db.transaction(IDB_SUB_STORE, 'readwrite').objectStore(IDB_SUB_STORE).delete(sk); } catch (err) {}
            }
        });
    } else if (msg.type === 'clear-audio-cache') {
        _swAudioCache = { url: null, buffer: null, ts: 0 };
        _cachedAudioKeySet = {};   // v2.7.0：键集合一并清空（全部放行直连）
        _swSubCache = {};
        _swSubCacheKeys = [];
    } else if (msg.type === 'skip-waiting') {
        self.skipWaiting();
    }
});

/* 完整的 Range 解析：
   - 无 Range → 整文件 {0, total-1}
   - bytes=-500（后缀范围）→ 最后 500 字节
   - bytes=100-（开放结尾）→ 100 到末尾
   - start > end 或 start >= total 或非法格式 → invalid（返回 416）
   - end 超过 total-1 → 截断（iOS 常发超大 end 的探测请求） */
function parseRange(rangeHeader, totalLength) {
    if (!rangeHeader) return { start: 0, end: totalLength - 1 };
    var m = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
    if (!m) return { start: 0, end: totalLength - 1 };
    var startStr = m[1], endStr = m[2];

    // 后缀范围：bytes=-500
    if (startStr === '' && endStr !== '') {
        var len = parseInt(endStr, 10);
        if (isNaN(len) || len <= 0) return { invalid: true };
        return { start: Math.max(0, totalLength - len), end: totalLength - 1 };
    }

    var start = parseInt(startStr, 10);
    var end   = endStr === '' ? totalLength - 1 : parseInt(endStr, 10);
    if (isNaN(start) || start < 0) return { invalid: true };
    if (isNaN(end)) end = totalLength - 1;
    if (end > totalLength - 1) end = totalLength - 1; // 截断超大 end
    if (start > end || start >= totalLength) return { invalid: true };
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

function _openIDB() {
    if (_swIDB) return Promise.resolve(_swIDB);
    return new Promise(function(resolve) {
        if (typeof indexedDB === 'undefined' || !indexedDB) { resolve(null); return; }
        var req = indexedDB.open(IDB_NAME, IDB_VERSION);
        req.onupgradeneeded = function(e) {
            var db = e.target.result;
            if (!db.objectStoreNames.contains(IDB_STORE)) {
                db.createObjectStore(IDB_STORE);
            }
            // v2.6.0：新增字幕 store（已存在则跳过）
            if (!db.objectStoreNames.contains(IDB_SUB_STORE)) {
                db.createObjectStore(IDB_SUB_STORE);
            }
        };
        req.onsuccess = function(e) {
            _swIDB = e.target.result;
            // 【v2.9.1】iOS 后台挂起/系统回收连接后句柄会失效，之后每次 transaction
            // 都抛 InvalidStateError 并静默返回 null → 整个离线缓存与字幕读取失灵。
            // onclose 置空句柄，下次使用时自动重开；onversionchange 主动让位防 upgrade 阻塞
            _swIDB.onclose = function() { _swIDB = null; };
            _swIDB.onversionchange = function() {
                try { _swIDB.close(); } catch (err) {}
                _swIDB = null;
            };
            resolve(_swIDB);
        };
        req.onerror = function() { resolve(null); };
    });
}

function getAudioFromIndexedDB(url) {
    var key = _swKey(url);   // v2.6.0：与页面端存储 key 对齐（解码形式）
    var now = Date.now();
    if (_swAudioCache.url === key && _swAudioCache.buffer) {
        _swAudioCache.ts = now;                 // v2.7.0：命中续期
        return Promise.resolve(_swAudioCache.buffer);
    }
    // v2.7.0：TTL 回收 —— 60 秒无访问的内存缓存直接丢弃，长会话不撑爆 SW 进程
    if (_swAudioCache.url && now - _swAudioCache.ts > _AUDIO_MEM_TTL) {
        _swAudioCache = { url: null, buffer: null, ts: 0 };
    }
    return _openIDB().then(function(db) {
        if (!db || !db.objectStoreNames || !db.objectStoreNames.contains(IDB_STORE)) return null;
        return new Promise(function(resolve) {
            try {
                var tx = db.transaction(IDB_STORE, 'readonly');
                var getReq = tx.objectStore(IDB_STORE).get(key);
                getReq.onsuccess = function() {
                    var res = getReq.result || null;
                    if (res) {
                        // v2.8.0：页面下载改为流式 Blob 落盘，此处兼容 Blob / ArrayBuffer 两种形态
                        var resSize = res.size || res.byteLength || 0;
                        // v2.7.0：>15MB 的文件仍从 IDB 正常返回，但不进内存缓存（防 OOM）
                        if (resSize <= _AUDIO_MEM_MAX) {
                            _swAudioCache = { url: key, buffer: res, ts: Date.now() };
                        }
                    }
                    resolve(res);
                };
                getReq.onerror = function() { resolve(null); };
            } catch (err) { resolve(null); }
        });
    });
}

/* v2.6.0 字幕存取：内存 → IDB → 网络（成功回写 IDB，实现"播过即离线"） */
function getSubtitleText(url) {
    var key = _swKey(url);
    if (_swSubCache[key] !== undefined) return Promise.resolve(_swSubCache[key]);
    return _openIDB().then(function(db) {
        if (!db || !db.objectStoreNames || !db.objectStoreNames.contains(IDB_SUB_STORE)) return null;
        return new Promise(function(resolve) {
            try {
                var tx = db.transaction(IDB_SUB_STORE, 'readonly');
                var getReq = tx.objectStore(IDB_SUB_STORE).get(key);
                getReq.onsuccess = function() { resolve(getReq.result || null); };
                getReq.onerror = function() { resolve(null); };
            } catch (err) { resolve(null); }
        });
    });
}

/* 【v2.7.0·P0-1.1】存原始 ArrayBuffer 而非解码文本：
   此前用 text() 读取响应会按 UTF-8 强制解码，GBK / UTF-16 字幕二次或离线加载时永久乱码。
   命中返回时统一以 octet-stream 交回原始字节，编码探测交给页面端 _decodeSubBuffer()。 */
function putSubtitleBuffer(url, buffer) {
    var key = _swKey(url);
    _swSubCache[key] = buffer;
    // v2.7.0·P2-4.4：重复键不再入队（同键多次入队会把其他字幕提前驱逐出 LRU）
    if (_swSubCacheKeys.indexOf(key) < 0) {
        _swSubCacheKeys.push(key);
        while (_swSubCacheKeys.length > 64) {
            delete _swSubCache[_swSubCacheKeys.shift()];
        }
    }
    // 【v2.9.3 修复】返回落盘 Promise（事务 oncomplete 才算写完）：
    // 旧版只到函数同步返回，IDB 写入悬空 —— iOS 提前挂起 SW 时字幕丢失。
    // 调用方 e.waitUntil 现在能真正保活到落盘完成
    return _openIDB().then(function(db) {
        if (!db || !db.objectStoreNames || !db.objectStoreNames.contains(IDB_SUB_STORE)) return;
        return new Promise(function(resolve) {
            try {
                var tx = db.transaction(IDB_SUB_STORE, 'readwrite');
                tx.objectStore(IDB_SUB_STORE).put(buffer, key);
                tx.oncomplete = function() { resolve(); };
                tx.onerror    = function() { resolve(); };
                tx.onabort    = function() { resolve(); };
            } catch (err) { resolve(); }
        });
    });
}

function _guessSubMime(url) {
    var u = url.toLowerCase().split('?')[0];
    if (u.slice(-4) === '.lrc') return 'text/plain; charset=utf-8';
    if (u.slice(-4) === '.srt') return 'text/plain; charset=utf-8';
    if (u.slice(-4) === '.ass') return 'text/plain; charset=utf-8';
    return 'text/plain; charset=utf-8';
}

// 网络兜底：只尝试一次 fetch，离线/失败直接回 504，不再二次请求
function _netFetch(req) {
    return fetch(req).catch(function() {
        return new Response('', { status: 504, statusText: 'Offline' });
    });
}

self.addEventListener('fetch', function(e) {
    var req = e.request;
    if (req.method !== 'GET') return;
    var url = req.url;
    var urlPath = url.toLowerCase().split('?')[0];
    var isAudio = AUDIO_EXTS.some(function(ext) {
        return urlPath.slice(-ext.length) === ext;
    });
    // v2.6.0：字幕请求 —— IDB 命中直接回文本；未命中走网络，成功则回写 IDB（自动离线化）
    var isSubtitle = SUBTITLE_EXTS.some(function(ext) {
        return urlPath.slice(-ext.length) === ext;
    });

    if (isSubtitle) {
        e.respondWith(
            getSubtitleText(url).then(function(cachedVal) {
                // v2.7.0：命中可能是 ArrayBuffer（新数据）或 string（v2.6.0 老 UTF-8 数据），都直接下发；
                // Content-Type 用 octet-stream —— 页面端 res.arrayBuffer() + _decodeSubBuffer() 统一探测编码
                if (cachedVal !== null && cachedVal !== undefined && cachedVal !== '') {
                    return new Response(cachedVal, {
                        status: 200,
                        headers: { 'Content-Type': 'application/octet-stream' }
                    });
                }
                return fetch(req).then(function(resp) {
                    if (resp && resp.status === 200) {
                        var cl = parseInt(resp.headers.get('Content-Length') || '0', 10);
                        // 【v2.9.1】校验 Content-Type：SPA 回退会以 200 返回 text/html 错误页，
                        // 旧版照存不误 → 幽灵字幕条目永久留在离线空间列表里
                        var ct = (resp.headers.get('Content-Type') || '').toLowerCase();
                        if ((cl === 0 || cl <= 524288) && ct.indexOf('text/html') < 0) {
                            // 【v2.7.0·P0-1.1】取原始字节（arrayBuffer）而非文本读取
                            // （文本读取强制 UTF-8 解码，GBK/UTF-16 字幕写进 IDB 即永久乱码）
                            // 【v2.9.1】写入包进 e.waitUntil：SW 保活到落盘完成，不再被提前回收
                            var _writeP = resp.clone().arrayBuffer().then(function(buf) {
                                if (buf && buf.byteLength > 0 && buf.byteLength <= 524288) {
                                    return putSubtitleBuffer(url, buf);   // 【v2.9.3】链入落盘 Promise，waitUntil 保活到事务完成
                                }
                            }).catch(function() {});
                            try { e.waitUntil(_writeP); } catch (err2) {}
                        }
                    }
                    return resp;
                }).catch(function() {
                    return new Response('', { status: 504, statusText: 'Offline' });
                });
            })
        );
        return;
    }

    if (isAudio) {
        // 【v2.7.0·P1-3.2】同步放行：集合已就绪且未缓存 → 不调用 respondWith，
        // 浏览器与 CDN 原生直连（下载/在线播放在 iOS 上显著提速，且绕开 SW 流卡顿）。
        if (_audioKeysReady && !_cachedAudioKeySet[_swKey(url)]) return;
        if (!_audioKeysReady) e.waitUntil(_initAudioKeySet());   // 首次请求时后台装载集合
        e.respondWith(
            getAudioFromIndexedDB(url).then(function(buffer) {
                if (!buffer) {
                    // 未缓存：只走一次网络（离线时 _netFetch 返回 504，页面端有对应提示）
                    return _netFetch(req);
                }

                var total = buffer.size || buffer.byteLength || 0;   // v2.8.0：兼容 Blob 缓存
                var rangeHeader = req.headers.get('Range');
                var range = parseRange(rangeHeader, total);

                // 【优化 1】iOS 超大 end 探测请求已被 parseRange 截断；非法范围统一 416
                if (range.invalid || range.start >= total) {
                    return new Response('', {
                        status: 416,
                        headers: { 'Content-Range': 'bytes */' + total }
                    });
                }

                var sliced = buffer.slice(range.start, range.end + 1);
                var mime = _guessMime(url);

                if (rangeHeader) {
                    return new Response(sliced, {
                        status: 206,
                        statusText: 'Partial Content',
                        headers: {
                            'Content-Type': mime,
                            'Content-Length': String(sliced.size || sliced.byteLength),
                            'Content-Range': 'bytes ' + range.start + '-' + range.end + '/' + total,
                            'Accept-Ranges': 'bytes'
                        }
                    });
                }

                // 【HTTP 规范修复】200 OK 响应不得携带 Content-Range
                return new Response(sliced, {
                    status: 200,
                    statusText: 'OK',
                    headers: {
                        'Content-Type': mime,
                        'Content-Length': String(sliced.size || sliced.byteLength),
                        'Accept-Ranges': 'bytes'
                    }
                });
            }).catch(function() { return _netFetch(req); })
        );
        return;
    }

    if (req.mode === 'navigate') {
        e.respondWith(
            caches.match(SHELL_URL).then(function(cached) {
                // 后台悄悄拉最新壳文件更新缓存（no-cache 绕过 HTTP 缓存），失败无所谓
                var netUpdate = fetch(req, { cache: 'no-cache' }).then(function(resp) {
                    if (resp && resp.status === 200) {
                        var respClone = resp.clone();
                        caches.open(CACHE_NAME).then(function(cache) {
                            cache.put(SHELL_URL, respClone);
                        });
                    }
                    return resp;
                }).catch(function() { return null; });

                if (cached) {
                    e.waitUntil(netUpdate);
                    return cached;
                }
                // 缓存里没有壳，只能等网络；网络也没有给个兜底页
                return netUpdate.then(function(resp) {
                    return resp || new Response(
                        '<!doctype html><meta charset="utf-8"><body style="font-family:-apple-system,sans-serif;padding:60px 24px;text-align:center;color:#666;">📶 当前离线，且本机暂无可用缓存<br><br>请连接一次网络后重新打开</body>',
                        { status: 200, headers: { 'Content-Type': 'text/html;charset=utf-8' } }
                    );
                });
            })
        );
        return;
    }

    if (req.url.startsWith(self.location.origin)) {
        var urlPath = new URL(req.url).pathname;
        if (urlPath.indexOf('/_api/') === 0 || urlPath === '/sw.js') return;

        // 同源静态资源：缓存优先 + 在线时后台更新（SWR）
        e.respondWith(
            caches.match(req).then(function(cached) {
                if (cached) {
                    if (navigator.onLine !== false) {
                        e.waitUntil(
                            fetch(req, { cache: 'no-cache' }).then(function(resp) {
                                // 【修复】只缓存 200；206 等 Partial 响应会让 cache.put 抛错
                                if (resp && resp.status === 200) {
                                    var clone = resp.clone();
                                    return caches.open(CACHE_NAME).then(function(c) { c.put(req, clone); });
                                }
                            }).catch(function() {})
                        );
                    }
                    return cached;
                }
                // 【修复】离线时不发起注定失败的请求，直接 504
                if (navigator.onLine === false) {
                    return new Response('', { status: 504, statusText: 'Offline' });
                }
                return fetch(req).then(function(resp) {
                    if (resp && resp.status === 200) {
                        var clone2 = resp.clone();
                        caches.open(CACHE_NAME).then(function(c) { c.put(req, clone2); });
                    }
                    return resp;
                });
            })
        );
    }
});
