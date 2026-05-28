// ==UserScript==
// @name         Megaplay.buzz Immersive Translate Fix v10.5
// @namespace    http://tampermonkey.net/
// @version      10.5
// @description  Pure IT engine fix: fetch override + Referer injection + postMessage interception + TextTrack monitor + iframe relay. No Google fallback.
// @author       Antigravity
// @match        *://anisuge.tv/*
// @match        *://animesuge.cz/*
// @match        *://megaplay.buzz/*
// @match        *://1anime.site/*
// @match        *://*.mewcdn.online/*
// @match        *://*.mewstream.buzz/*
// @match        *://*.lostproject.club/*
// @grant        GM_xmlhttpRequest
// @grant        GM_webRequest
// @grant        unsafeWindow
// @run-at       document-start
// @connect      1oe.lostproject.club
// @connect      *
// ==/UserScript==

(function () {
    'use strict';

    const isInIframe = (window !== window.top);
    const frameId = isInIframe ? `IFRAME:${location.hostname}` : 'TOP';
    const log = (msg) => {
        console.log(`[IT-Fix][${frameId}] ${msg}`);
        // If we're in an iframe, also relay logs to parent for visibility
        if (isInIframe) {
            try {
                window.parent.postMessage({ type: 'it-fix-log', frameId, msg }, '*');
            } catch(e) {}
        }
    };
    const isFirefox = navigator.userAgent.toLowerCase().includes('firefox');
    
    log(`Script loaded. URL: ${location.href.substring(0, 120)}`);

    // ── 0. Enhanced Anti-Debug (Chromium-optimized) ─────────────────
    // Chromium's V8 allows redefining Function.prototype.toString
    // to hide our hooks from detection by anti-debug scripts.
    {
        const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        const _origFunction = win.Function;
        const _origEval = win.eval;
        const _origSetInterval = win.setInterval;
        const _origSetTimeout = win.setTimeout;
        const _origRAF = win.requestAnimationFrame;

        // Hook Function constructor — neutralizes `new Function('debugger')()`
        const safeFnFactory = function (...args) {
            const body = args[args.length - 1] || '';
            if (typeof body === 'string' && /\bdebugger\b/i.test(body)) {
                return function () { };
            }
            return _origFunction.apply(this, args);
        };
        safeFnFactory.prototype = _origFunction.prototype;
        win.Function = safeFnFactory;
        win.Function.prototype.constructor = safeFnFactory;

        // Hook eval — blocks direct eval("debugger")
        win.eval = function (code) {
            if (typeof code === 'string' && /\bdebugger\b/i.test(code)) return undefined;
            return _origEval.apply(this, arguments);
        };

        // Hook setInterval — blocks setInterval("debugger", ...)
        win.setInterval = function (fn, delay, ...args) {
            if (typeof fn === 'function' && fn.toString().includes('debugger')) return 0;
            if (typeof fn === 'string' && /\bdebugger\b/i.test(fn)) return 0;
            return _origSetInterval.apply(this, arguments);
        };

        // Hook setTimeout — blocks setTimeout("debugger", ...)
        win.setTimeout = function (fn, delay, ...args) {
            if (typeof fn === 'function' && fn.toString().includes('debugger')) return 0;
            if (typeof fn === 'string' && /\bdebugger\b/i.test(fn)) return 0;
            return _origSetTimeout.apply(this, arguments);
        };

        // Hook requestAnimationFrame — blocks RAF-based debugger loops
        win.requestAnimationFrame = function (fn) {
            if (typeof fn === 'function') {
                const str = fn.toString();
                if (str.includes('debugger')) return 0;
                if (/\b(?:Function|constructor)\b/.test(str) && /\bdebugger\b/.test(str)) return 0;
            }
            return _origRAF.call(this, fn);
        };

        // --- Spoof Window dimensions to bypass size-based DevTools detection ---
        try {
            Object.defineProperty(win, 'outerWidth', {
                get() { return win.innerWidth || 1024; },
                configurable: true
            });
            Object.defineProperty(win, 'outerHeight', {
                get() { return win.innerHeight || 768; },
                configurable: true
            });
        } catch (e) {
            log(`Failed to spoof window outer dimensions: ${e.message}`);
        }

        // --- Hook Console methods to neutralize console-based getters/RegExp toString detectors ---
        const consoleMethods = ['log', 'warn', 'error', 'info', 'dir', 'table', 'trace', 'group', 'groupCollapsed', 'groupEnd'];
        const _origConsole = {};
        for (const method of consoleMethods) {
            if (win.console && typeof win.console[method] === 'function') {
                _origConsole[method] = win.console[method];
                win.console[method] = function (...args) {
                    const sanitizedArgs = args.map(arg => {
                        if (arg === null || arg === undefined) return arg;
                        // Avoid triggering getters on elements or custom objects
                        if (arg instanceof HTMLElement) {
                            return `[Element: ${arg.tagName.toLowerCase()}]`;
                        }
                        if (arg instanceof RegExp) {
                            return '[RegExp]';
                        }
                        if (typeof arg === 'function') {
                            return '[Function]';
                        }
                        if (typeof arg === 'object') {
                            try {
                                const descriptors = Object.getOwnPropertyDescriptors(arg);
                                for (const key in descriptors) {
                                    if (descriptors[key].get) {
                                        return '[Object with Getters]';
                                    }
                                }
                                if (Object.prototype.hasOwnProperty.call(arg, 'toString') || arg.toString !== Object.prototype.toString) {
                                    return '[Object with custom toString]';
                                }
                            } catch (e) {
                                return '[Unsafe Object]';
                            }
                        }
                        return arg;
                    });
                    return _origConsole[method].apply(this, sanitizedArgs);
                };
            }
        }

        // --- Mask toString to hide all our hooks ---
        const _origToString = Function.prototype.toString;
        const NATIVE_STR = 'function () { [native code] }';
        Function.prototype.toString = function () {
            const fn = this;
            if (fn === safeFnFactory || fn === win.Function || fn === win.eval) {
                return NATIVE_STR;
            }
            if (fn === win.setInterval || fn === win.setTimeout ||
                fn === win.requestAnimationFrame) {
                return NATIVE_STR;
            }
            for (const method of consoleMethods) {
                if (fn === win.console[method]) {
                    return NATIVE_STR;
                }
            }
            return _origToString.apply(this, arguments);
        };

        // --- Block console.clear to preserve our logs ---
        try {
            Object.defineProperty(win.console, 'clear', {
                value: function () { },
                writable: false,
                configurable: false
            });
        } catch (e) {
            try { win.console.clear = function () { }; } catch (e2) { }
        }

        // --- Block devtools detection via element.constructor ---
        try {
            const _origErrorPrepare = Error.prepareStackTrace;
            Error.prepareStackTrace = function (err, stack) {
                const filtered = stack.filter(entry => {
                    try {
                        return !String(entry).includes('debugger');
                    } catch (e) { return true; }
                });
                if (filtered.length === 0) return '';
                return _origErrorPrepare ? _origErrorPrepare(err, filtered) : String(filtered);
            };
        } catch (e) { }
    }
    log('Anti-debug active.');

    // ── 0.5 Preact XrayWrapper Fix (for Firefox content script) ──────
    try {
        const PREACT_DOM_PROPS = [
            '__c', '__k', '__', '__b', '__e', '__h',
            '__n', '__P', '__u', '__v', '__html', '__s',
            '__d', '__l', '__r', '__i', '__t',
        ];
        const _preactStorage = new WeakMap();

        for (const prop of PREACT_DOM_PROPS) {
            if (!Object.prototype.hasOwnProperty.call(Node.prototype, prop)) {
                Object.defineProperty(Node.prototype, prop, {
                    get() { return _preactStorage.get(this); },
                    set(v) { _preactStorage.set(this, v); },
                    configurable: true,
                    enumerable: false
                });
            }
            if (!Object.prototype.hasOwnProperty.call(Event.prototype, prop)) {
                Object.defineProperty(Event.prototype, prop, {
                    get() { return _preactStorage.get(this); },
                    set(v) { _preactStorage.set(this, v); },
                    configurable: true,
                    enumerable: false
                });
            }
        }
        log(`Preact XrayWrapper fix: ${PREACT_DOM_PROPS.length} properties pre-defined.`);
    } catch (e) {
        log(`Preact XrayWrapper patch error (non-fatal): ${e.message}`);
    }

    // ── 0.55 RegExp.prototype.test debug hook ──
    try {
        const origTest = RegExp.prototype.test;
        RegExp.prototype.test = function (str) {
            if (typeof str === 'string' && str.includes('.vtt')) {
                log(`RegExp.test: regex=${this.toString()} str=${str.substring(0, 80)}`);
                const res = origTest.call(this, str);
                log(`  result: ${res}`);
                return res;
            }
            return origTest.apply(this, arguments);
        };
        log('RegExp.prototype.test debug hook installed.');
    } catch(e) {
        log(`RegExp test hook error: ${e.message}`);
    }

    // ── 0.6 Monkey-patch TextTrackCue.prototype.innerHTML ──
    try {
        const CueProto = (typeof TextTrackCue !== 'undefined' && TextTrackCue.prototype)
            || (typeof VTTCue !== 'undefined' && VTTCue.prototype);
        if (CueProto) {
            const _origTextDesc = Object.getOwnPropertyDescriptor(CueProto, 'text');
            const _cueStorage = new WeakMap();
            let _patchWriteCount = 0;

            Object.defineProperty(CueProto, 'innerHTML', {
                get() {
                    return _cueStorage.get(this) || '';
                },
                set(value) {
                    if (typeof value !== 'string') return;
                    _cueStorage.set(this, value);
                    const currentText = this.text || '';
                    if (value && value !== currentText) {
                        try {
                            if (_origTextDesc && _origTextDesc.set) {
                                _origTextDesc.set.call(this, currentText + '\n' + value);
                            } else {
                                this.text = currentText + '\n' + value;
                            }
                            _patchWriteCount++;
                            if (_patchWriteCount <= 3) {
                                log(`innerHTML → text: "${value.substring(0, 60)}${value.length > 60 ? '...' : ''}"`);
                            }
                        } catch (e) {
                            try { this.text = currentText + '\n' + value; } catch (e2) { }
                        }
                    }
                },
                configurable: true,
                enumerable: true
            });
            log('TextTrackCue.prototype.innerHTML monkey-patch installed.');
        } else {
            log('WARNING: TextTrackCue/VTTCue not available yet. Patch deferred.');
        }
    } catch (e) {
        log(`innerHTML patch error (non-fatal): ${e.message}`);
    }

    // ── 1. GM_webRequest for VTT (defense-in-depth CORS fix) ──────────
    try {
        if (typeof GM_webRequest === 'function') {
            GM_webRequest([{
                selector: { url: '*://1oe.lostproject.club/anime/*/*/subtitles/*.vtt*', types: ['xmlhttprequest', 'fetch'] },
                action: {
                    requestHeaders: [
                        { header: 'Referer', operation: 'set', value: 'https://megaplay.buzz/' },
                        { header: 'Origin', operation: 'set', value: 'https://megaplay.buzz' }
                    ],
                    responseHeaders: [
                        { header: 'Access-Control-Allow-Origin', operation: 'set', value: '*' },
                        { header: 'Access-Control-Allow-Methods', operation: 'set', value: 'GET, HEAD, OPTIONS' },
                        { header: 'Access-Control-Allow-Headers', operation: 'set', value: '*' }
                    ]
                }
            }], (info) => { if (info?.result === 'success') log(`webRequest OK: ${(info.url || '').substring(0, 80)}`); });
            log('GM_webRequest registered.');
        }
    } catch (e) { log(`GM_webRequest: ${e.message}`); }

    // ── 2. State ──────────────────────────────────────────────────────
    let vttUrl = null;
    let vttText = null;
    let cues = [];
    let translatedCues = [];
    let renderInterval = null;
    let itTranslationDetected = false;
    let textTrackMonitorInterval = null;
    let _bridgeLastSummary = '';
    let _bridgeMsgTypes = {};
    let _bridgeBlockedCount = 0;
    let _bridgeLastCount = 0;
    const vttCache = new Map();

    let itHookReady = false;
    let itHookResolve = null;
    const itHookPromise = new Promise(resolve => {
        itHookResolve = resolve;
    });

    const waitForItHook = () => {
        return Promise.race([
            itHookPromise,
            new Promise(resolve => setTimeout(resolve, 2000))
        ]);
    };

    const triggerItHookReady = () => {
        if (!itHookReady) {
            itHookReady = true;
            if (itHookResolve) itHookResolve();
            log("IT hook is marked as READY.");
        }
    };

    let ourXhrOpen = null;
    let ourXhrSend = null;
    let ourFetchWrapper = null;

    // Hook Object.defineProperty to detect IT overriding XHR prototype
    try {
        const origDefineProperty = Object.defineProperty;
        Object.defineProperty = function (obj, prop, descriptor) {
            if (obj === XMLHttpRequest.prototype && (prop === 'send' || prop === 'open')) {
                const val = descriptor && descriptor.value;
                if (val && val !== ourXhrSend && val !== ourXhrOpen) {
                    log(`Detected IT overriding XMLHttpRequest.prototype.${prop}`);
                    triggerItHookReady();
                }
            }
            return origDefineProperty.apply(this, arguments);
        };
    } catch (e) {
        log(`Failed to hook Object.defineProperty: ${e.message}`);
    }

    // Hook window.fetch setter to detect IT overriding fetch
    try {
        let currentFetch = unsafeWindow.fetch || window.fetch;
        Object.defineProperty(unsafeWindow, 'fetch', {
            get() {
                return currentFetch;
            },
            set(newFetch) {
                currentFetch = newFetch;
                if (typeof newFetch === 'function' && newFetch !== ourFetchWrapper) {
                    log(`Detected IT overriding window.fetch`);
                    triggerItHookReady();
                }
            },
            configurable: true
        });
    } catch (e) {
        log(`Failed to hook window.fetch: ${e.message}`);
    }

    // ── 3. Utilities ──────────────────────────────────────────────────
    const normalizeUrl = (url) => {
        if (!url || typeof url !== 'string') return url;
        try {
            let t = url;
            if (url.startsWith('//')) t = globalThis.location.protocol + url;
            else if (url.startsWith('/')) t = location.origin + url;
            else if (!url.startsWith('http')) t = location.protocol + '//' + url;
            return new URL(t).href;
        } catch (e) { return url; }
    };

    const toDataUri = (text) => {
        const b64 = btoa(encodeURIComponent(text).replace(/%([0-9A-F]{2})/g, (_, p1) =>
            String.fromCharCode(parseInt(p1, 16))));
        return 'data:text/vtt;charset=utf-8;base64,' + b64;
    };

    const parseVTT = (text) => {
        if (!text) return [];
        const lines = text.replace(/\r\n/g, '\n').split('\n');
        const result = [];
        let start = null, end = null, curText = [];
        for (const line of lines) {
            const m = line.match(/^(\d{2}:\d{2}(?::\d{2})?\.\d{3})\s*-->\s*(\d{2}:\d{2}(?::\d{2})?\.\d{3})/);
            if (m) {
                if (start !== null) result.push({ start: toSec(start), end: toSec(end), text: curText.join('\n').trim() });
                start = m[1]; end = m[2]; curText = [];
            } else if (line.trim() && !line.startsWith('WEBVTT') && !line.startsWith('NOTE') && !line.startsWith('STYLE') && start !== null) {
                curText.push(line.trim());
            }
        }
        if (start !== null) result.push({ start: toSec(start), end: toSec(end), text: curText.join('\n').trim() });
        return result.filter(c => c.text);
    };

    const toSec = (t) => {
        const p = t.split(':');
        if (p.length === 3) return parseFloat(p[0]) * 3600 + parseFloat(p[1]) * 60 + parseFloat(p[2]);
        if (p.length === 2) return parseFloat(p[0]) * 60 + parseFloat(p[1]);
        return parseFloat(p[0]);
    };

    // ── 3.5 Early window.fetch Override ───────────────────────────────
    // Intercepts VTT fetches to inject Referer/Origin headers via GM_xmlhttpRequest
    const VTT_FETCH_REGEX = /lostproject\.club\/.+\.vtt/i;
    const _origFetch = unsafeWindow.fetch;

    ourFetchWrapper = function (input, init) {
        let url;
        if (typeof input === 'string') {
            url = input;
        } else if (input instanceof Request) {
            url = input.url;
        } else if (input && typeof input === 'object' && input.url) {
            url = String(input.url);
        } else {
            return _origFetch.call(this, input, init);
        }

        const urlStr = String(url);

        // Discover VTT URLs
        if (urlStr.includes('.vtt') && !vttUrl) {
            vttUrl = normalizeUrl(urlStr);
            log(`VTT detected via page fetch: ${vttUrl}`);
        }

        // Delay VTT requests until IT hook is ready
        if (urlStr.includes('.vtt') && !itHookReady) {
            log(`Delaying VTT fetch for ${urlStr.substring(0, 60)} until IT hook is ready...`);
            return waitForItHook().then(() => {
                return unsafeWindow.fetch.call(this, input, init);
            });
        }

        // lostproject.club VTT: inject Referer via GM_xmlhttpRequest
        if (VTT_FETCH_REGEX.test(urlStr)) {
            const normUrl = normalizeUrl(urlStr);

            // Trigger the extension's fetch hook in the background so it registers the VTT
            try {
                _origFetch.call(this, input, init).catch(() => {});
            } catch (e) {}

            // Serve from cache if already fetched
            if (vttCache.has(normUrl)) {
                log(`Fetch proxy: ${urlStr.substring(0, 80)}... → cache (${(vttCache.get(normUrl).length / 1024).toFixed(0)}KB)`);
                return Promise.resolve(new Response(vttCache.get(normUrl), {
                    status: 200, statusText: 'OK',
                    headers: { 'Content-Type': 'text/vtt; charset=utf-8' }
                }));
            }

            log(`Fetch proxy: ${urlStr.substring(0, 80)}... → GM_xmlhttpRequest`);
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: urlStr,
                    headers: {
                        'Referer': 'https://megaplay.buzz/',
                        'Origin': 'https://megaplay.buzz'
                    },
                    onload: (resp) => {
                        if (resp.status === 200) {
                            vttCache.set(normUrl, resp.responseText);
                            resolve(new Response(resp.responseText, {
                                status: 200, statusText: 'OK',
                                headers: { 'Content-Type': 'text/vtt; charset=utf-8' }
                            }));
                        } else {
                            log(`Fetch proxy ERROR: HTTP ${resp.status} for ${urlStr.substring(0, 60)}`);
                            reject(new TypeError(`VTT fetch failed: HTTP ${resp.status}`));
                        }
                    },
                    onerror: (e) => {
                        log(`Fetch proxy NETWORK ERROR for ${urlStr.substring(0, 60)}`);
                        reject(new TypeError('VTT network error'));
                    },
                    ontimeout: () => {
                        log(`Fetch proxy TIMEOUT for ${urlStr.substring(0, 60)}`);
                        reject(new TypeError('VTT fetch timeout'));
                    }
                });
            });
        }

        return _origFetch.call(this, input, init);
    };
    log('Early fetch override installed. VTT requests will be proxied via GM_xmlhttpRequest.');

    // ── 4. VTT Discovery (page-level detection) ────────────────────────
    const findVtt = () => {
        let raw = null;
        const art = unsafeWindow.artplayer || (unsafeWindow.art && unsafeWindow.art.instances && unsafeWindow.art.instances[0]);
        if (art && art.option && art.option.subtitle && art.option.subtitle.url && art.option.subtitle.url.includes('.vtt')) {
            raw = art.option.subtitle.url;
            log(`VTT from ArtPlayer: ${raw}`);
        }
        if (!raw) {
            const jw = unsafeWindow.jwplayer || window.jwplayer;
            if (typeof jw === 'function') {
                try {
                    const inst = jw();
                    if (inst && inst.getPlaylist && inst.getPlaylist()[0] && inst.getPlaylist()[0].tracks) {
                        inst.getPlaylist()[0].tracks.forEach(t => { if (t.file && t.file.includes('.vtt')) raw = t.file; });
                        if (raw) log(`VTT from JW: ${raw}`);
                    }
                } catch (e) { }
            }
        }
        if (!raw) {
            for (let key in unsafeWindow) {
                try {
                    const val = unsafeWindow[key];
                    if (typeof val === 'string' && val.includes('.vtt') && val.startsWith('http')) {
                        raw = val; log(`VTT from ${key}: ${raw}`); break;
                    }
                } catch (e) { }
            }
        }
        if (raw) vttUrl = normalizeUrl(raw);
    };

    // XHR interceptor: detect VTT URLs and proxy them via GM_xmlhttpRequest
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;

    ourXhrOpen = function (method, url, ...args) {
        this._url = url;
        this._method = method;
        if (typeof url === 'string' && url.includes('.vtt') && !vttUrl) {
            vttUrl = normalizeUrl(url);
            log(`VTT via XHR open: ${vttUrl}`);
        }
        return origOpen.apply(this, [method, url, ...args]);
    };
    XMLHttpRequest.prototype.open = ourXhrOpen;

    // Helper: safely set XHR properties (IT's translateSubtitle may pre-set them)
    const safeDefineXHRProp = (xhr, prop, value) => {
        try {
            Object.defineProperty(xhr, prop, { value, writable: true, configurable: true });
        } catch(e) {
            try { xhr[prop] = value; } catch(e2) {}
        }
    };

    ourXhrSend = function (body) {
        const urlStr = String(this._url);

        // Delay VTT requests until IT hook is ready
        if (urlStr.includes('.vtt') && !this._delayed && !itHookReady) {
            this._delayed = true;
            log(`Delaying VTT XHR send for ${urlStr.substring(0, 60)} until IT hook is ready...`);
            waitForItHook().then(() => {
                // Call the current prototype send, which might be IT's hook now!
                XMLHttpRequest.prototype.send.call(this, body);
            });
            return;
        }

        if (VTT_FETCH_REGEX.test(urlStr)) {
            const normUrl = normalizeUrl(urlStr);

            // Serve from cache if already fetched
            if (vttCache.has(normUrl)) {
                log(`XHR proxy (cache): ${urlStr.substring(0, 80)}...`);
                
                if (this.hasOwnProperty('responseText')) {
                    log(`  IT has already defined responseText. Skipping overwrite to preserve translations.`);
                } else {
                    const responseText = vttCache.get(normUrl);
                    safeDefineXHRProp(this, 'status', 200);
                    safeDefineXHRProp(this, 'statusText', 'OK');
                    safeDefineXHRProp(this, 'readyState', 4);
                    safeDefineXHRProp(this, 'response', responseText);
                    safeDefineXHRProp(this, 'responseText', responseText);
                }

                if (typeof this.onreadystatechange === 'function') this.onreadystatechange();
                if (typeof this.onload === 'function') this.onload();
                this.dispatchEvent(new Event('readystatechange'));
                this.dispatchEvent(new Event('load'));
                return;
            }

            log(`XHR proxy (network): ${urlStr.substring(0, 80)}... → GM_xmlhttpRequest`);
            GM_xmlhttpRequest({
                method: this._method || 'GET',
                url: this._url,
                headers: {
                    'Referer': 'https://megaplay.buzz/',
                    'Origin': 'https://megaplay.buzz'
                },
                onload: (resp) => {
                    vttCache.set(normUrl, resp.responseText);
                    
                    if (this.hasOwnProperty('responseText')) {
                        log(`  IT has already defined responseText on network load. Skipping overwrite.`);
                    } else {
                        safeDefineXHRProp(this, 'status', resp.status);
                        safeDefineXHRProp(this, 'statusText', resp.statusText);
                        safeDefineXHRProp(this, 'readyState', 4);
                        safeDefineXHRProp(this, 'response', resp.responseText);
                        safeDefineXHRProp(this, 'responseText', resp.responseText);
                    }

                    if (typeof this.onreadystatechange === 'function') this.onreadystatechange();
                    if (typeof this.onload === 'function') this.onload();
                    this.dispatchEvent(new Event('readystatechange'));
                    this.dispatchEvent(new Event('load'));
                },
                onerror: (e) => {
                    this.dispatchEvent(new Event('error'));
                }
            });
            return;
        }
        return origSend.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = ourXhrSend;

    // ── 5. Fetch & Cache VTT (for IT monitor) ────────────────────────
    let fetchInProgress = false;

    const fetchAndCacheVtt = () => {
        if (fetchInProgress || !vttUrl) return;
        fetchInProgress = true;
        log(`Fetching VTT: ${vttUrl}`);

        GM_xmlhttpRequest({
            method: 'GET',
            url: vttUrl,
            headers: {
                'Referer': 'https://megaplay.buzz/',
                'Origin': 'https://megaplay.buzz'
            },
            onload: (resp) => {
                if (resp.status !== 200) {
                    log(`VTT fetch FAILED: ${resp.status}`);
                    fetchInProgress = false;
                    return;
                }
                vttText = resp.responseText;
                vttCache.set(vttUrl, vttText);
                cues = parseVTT(vttText);
                log(`VTT cached (${vttText.length} bytes, ${cues.length} cues).`);

                // Set video metadata for IT extension
                const video = document.querySelector('video');
                if (video) {
                    video.dataset.itVttUrl = vttUrl;
                    video.dataset.immersiveTranslateVideoId = 'anisuge-' + Date.now();
                    if (video.crossOrigin !== 'anonymous') video.crossOrigin = 'anonymous';
                }

                startITTranslationMonitor();
            },
            onerror: () => {
                log('VTT fetch network error');
                fetchInProgress = false;
            }
        });
    };

    // ── 6. PostMessage Interception ────────────────────────────────────
    const _origPostMessage = unsafeWindow.postMessage.bind(unsafeWindow);
    const IM_BRIDGE_EVENT = 'imt-subtitle-inject';
    let _pmInterceptCount = 0;

    const extractVttUrl = (data) => {
        if (!data || typeof data !== 'object') return null;
        if (data.url && typeof data.url === 'string' && data.url.includes('.vtt'))
            return normalizeUrl(data.url);
        if (data.fetchInfo && typeof data.fetchInfo === 'string') {
            try {
                const fi = JSON.parse(data.fetchInfo);
                if (fi.input && fi.input.url && typeof fi.input.url === 'string' && fi.input.url.includes('.vtt'))
                    return normalizeUrl(fi.input.url);
            } catch (e) { }
        }
        return null;
    };

    const buildReplacedMsg = (msg, vttUrl, dataUri) => {
        const cleanMsg = {};
        for (const k of Object.keys(msg)) {
            if (k === 'data' && typeof msg[k] === 'object' && msg[k] !== null) {
                const srcData = msg[k];
                const cleanData = {};
                for (const dk of Object.keys(srcData)) {
                    const val = srcData[dk];
                    if (dk === 'url' && typeof val === 'string' && normalizeUrl(val) === vttUrl) {
                        cleanData[dk] = dataUri;
                    } else if (dk === 'fetchInfo' && typeof srcData[dk] === 'string') {
                        try {
                            const fi = JSON.parse(srcData[dk]);
                            if (fi.input && typeof fi.input.url === 'string' && normalizeUrl(fi.input.url) === vttUrl) {
                                fi.input.url = dataUri;
                                cleanData[dk] = JSON.stringify(fi);
                            } else {
                                cleanData[dk] = srcData[dk];
                            }
                        } catch (e) { cleanData[dk] = srcData[dk]; }
                    } else {
                        cleanData[dk] = srcData[dk];
                    }
                }
                cleanMsg[k] = cleanData;
            } else {
                cleanMsg[k] = msg[k];
            }
        }
        return cleanMsg;
    };

    const previewPayload = (data) => {
        try {
            if (data === null || data === undefined) return String(data);
            if (typeof data !== 'object') return JSON.stringify(data).slice(0, 200);
            const keys = Object.keys(data);
            const preview = {};
            for (const k of keys.slice(0, 10)) {
                const v = data[k];
                if (v === null || v === undefined) preview[k] = String(v);
                else if (typeof v === 'object') preview[k] = `<${Array.isArray(v) ? 'Array[' + v.length + ']' : 'Object{' + Object.keys(v).slice(0, 5).join(',') + '}'}>`;
                else preview[k] = String(v).slice(0, 80);
            }
            return JSON.stringify(preview).slice(0, 240);
        } catch (e) { return `<preview-error: ${e.message}>`; }
    };

    const PREACT_CRASH_MSG_TYPES = new Set([
        'attachSubtitle',
        'imt-attach-subtitle-update',
        'imt-attach-subtitle',
        'updateSubtitleUI',
        'renderSubtitle',
        'showBilingualSubtitle',
    ]);

    let _pendingGetConfigIds = new Set();
    
    window.addEventListener('message', function (event) {
        const msg = event.data;
        if (msg && typeof msg === 'object' && msg.eventType === IM_BRIDGE_EVENT) {
            if (msg._patched) return;

            try {
                const msgType = msg.type || 'unknown';
                if (!_bridgeMsgTypes[msgType]) {
                    _bridgeMsgTypes[msgType] = 0;
                }
                _bridgeMsgTypes[msgType]++;
                
                // Track getConfig request IDs to match responses
                if (msgType === 'getConfig' && msg.from === 'inject' && msg.to === 'content-script' && msg.id) {
                    _pendingGetConfigIds.add(msg.id);
                }
                
                // Log ALL bridge messages with direction info
                const direction = `${msg.from}→${msg.to}`;
                
                // Detect getConfig RESPONSE by matching ID (response has no type field)
                const isGetConfigResponse = msg.from === 'content-script' && msg.to === 'inject' 
                    && msg.id && _pendingGetConfigIds && _pendingGetConfigIds.has(msg.id);
                
                if (isGetConfigResponse) {
                    _pendingGetConfigIds.delete(msg.id);
                    const cfg = msg.data;
                    const keys = cfg ? Object.keys(cfg).join(',') : 'null';
                    log(`Bridge getConfig RESPONSE: type=${cfg?.type}, hookType=${cfg?.hookType}`);
                    const regexStr = cfg?.subtitleUrlRegExp || 'undefined';
                    log(`Bridge getConfig regex len: ${regexStr.length}`);
                    for (let i = 0; i < regexStr.length; i += 25) {
                        log(`  regex part: "${regexStr.substring(i, i + 25)}"`);
                    }
                    log(`  keys: ${keys.substring(0, 100)}`);
                    log(`  subtitleButtonSelector=${cfg?.subtitleButtonSelector}, videoPlayerSelector=${cfg?.videoPlayerSelector}`);
                    log(`  id=${cfg?.id}, disabled=${cfg?.disabled}, subsrtFormat=${cfg?.subsrtFormat}`);
                    
                    // Release queue immediately if IT is disabled or has no subtitle configs
                    if (cfg?.disabled || !cfg?.type || !cfg?.hookType) {
                        log("IT is disabled or missing subtitle rule. Releasing queue immediately.");
                        triggerItHookReady();
                    } else {
                        // Otherwise, we do NOT trigger here. We wait for actual XHR/fetch overrides!
                        // But we set an 800ms safety timeout starting from getConfig response as a fallback.
                        setTimeout(() => {
                            if (!itHookReady) {
                                log("Safety timeout after getConfig reached. Releasing VTT requests.");
                                triggerItHookReady();
                            }
                        }, 800);
                    }
                } else {
                    log(`Bridge [${_bridgeMsgTypes[msgType]}] "${msgType}" (${direction}) id=${msg.id||'none'} async=${!!msg.isAsync} payload=${previewPayload(msg.data)}`);
                }

                // Block crash-prone messages ONLY on Firefox to prevent XrayWrapper crash
                if (isFirefox && PREACT_CRASH_MSG_TYPES.has(msgType)
                    && msg.from === 'content-script' && msg.to === 'inject') {
                    event.stopImmediatePropagation();
                    _bridgeBlockedCount++;
                    log(`Blocked "${msgType}" message to prevent Firefox XrayWrapper crash.`);
                    if (!itTranslationDetected) tryExtractAttachSubtitle(msg);
                    return;
                }

                // ── CRITICAL: Intercept requestSubtitle from inject→content-script ──
                // IT's inject.js sends requestSubtitle to content-script for VTT fetching.
                // Content-script can't fetch due to CORS (missing Referer). We respond
                // with our cached VTT content directly.
                if (msgType === 'requestSubtitle' && msg.from === 'inject' && msg.to === 'content-script') {
                    const reqData = msg.data || {};
                    const reqUrl = reqData.url || '';
                    let fetchInfoUrl = '';
                    if (reqData.fetchInfo) {
                        try {
                            const fi = JSON.parse(reqData.fetchInfo);
                            fetchInfoUrl = fi?.input?.url || '';
                        } catch(e) {}
                    }
                    const targetUrl = normalizeUrl(reqUrl) || normalizeUrl(fetchInfoUrl) || '';
                    log(`requestSubtitle intercepted (inject→cs): url=${targetUrl.substring(0, 80)}, id=${msg.id}, hasCache=${vttCache.has(targetUrl)}`);

                    // Check if we have this VTT cached
                    let cachedText = null;
                    if (vttCache.has(targetUrl)) {
                        cachedText = vttCache.get(targetUrl);
                    } else {
                        // Try partial match - check all cached URLs
                        for (const [cachedUrl, cachedVal] of vttCache.entries()) {
                            if (targetUrl && cachedUrl.includes('.vtt') && 
                                (targetUrl.includes(cachedUrl) || cachedUrl.includes(targetUrl.split('?')[0]))) {
                                cachedText = cachedVal;
                                log(`requestSubtitle: partial cache match: ${cachedUrl.substring(0, 80)}`);
                                break;
                            }
                        }
                        // If still no cache, try to fetch it now
                        if (!cachedText && targetUrl && targetUrl.includes('.vtt')) {
                            log(`requestSubtitle: No cache, fetching VTT now: ${targetUrl.substring(0, 80)}`);
                            const msgId = msg.id;
                            GM_xmlhttpRequest({
                                method: 'GET',
                                url: targetUrl,
                                headers: {
                                    'Referer': 'https://megaplay.buzz/',
                                    'Origin': 'https://megaplay.buzz'
                                },
                                onload: (resp) => {
                                    if (resp.status === 200 && resp.responseText) {
                                        vttCache.set(targetUrl, resp.responseText);
                                        log(`requestSubtitle: Fetched & cached (${resp.responseText.length} bytes). Responding to IT.`);
                                        // Respond to IT inject with VTT content
                                        const replyMsg = {
                                            eventType: IM_BRIDGE_EVENT,
                                            to: 'inject',
                                            from: 'content-script',
                                            type: 'requestSubtitle',
                                            data: resp.responseText,
                                            id: msgId,
                                            isAsync: true
                                        };
                                        unsafeWindow.postMessage(replyMsg, '*');
                                    } else {
                                        log(`requestSubtitle: Fetch failed (${resp.status}), letting content-script handle.`);
                                    }
                                },
                                onerror: () => {
                                    log(`requestSubtitle: Fetch error, letting content-script handle.`);
                                }
                            });
                            // Don't block the original message yet - content-script will also try
                            // If our fetch succeeds, we'll send the reply first
                        }
                    }

                    if (cachedText) {
                        // Block the original message so content-script doesn't try to fetch
                        event.stopImmediatePropagation();
                        log(`requestSubtitle: Responding with cached VTT (${cachedText.length} bytes) to IT inject.`);
                        
                        // Send response matching IT's async message protocol
                        const replyMsg = {
                            eventType: IM_BRIDGE_EVENT,
                            to: 'inject',
                            from: 'content-script',
                            type: 'requestSubtitle',
                            data: cachedText,
                            id: msg.id,
                            isAsync: true
                        };
                        unsafeWindow.postMessage(replyMsg, '*');
                        return;
                    }
                }

                // Also intercept startRequestSubtitle (xhr_response mode)
                if (msgType === 'startRequestSubtitle' && msg.from === 'inject' && msg.to === 'content-script') {
                    const reqData = msg.data || {};
                    const reqUrl = normalizeUrl(reqData.url || '');
                    log(`startRequestSubtitle intercepted: url=${reqUrl?.substring(0, 80)}`);
                }

                if (msgType === 'requestSubtitle' && msg.from === 'content-script' && msg.to === 'inject') {
                    log(`requestSubtitle response (cs→inject): data type=${typeof msg.data}, length=${typeof msg.data === 'string' ? msg.data.length : 'N/A'}`);
                }

                if (msgType === 'subtitleResponse' && !itTranslationDetected) {
                    tryExtractSubtitleResponse(msg);
                }

                const data = msg.data;
                const extractedUrl = extractVttUrl(data);
                if (extractedUrl && vttCache.has(extractedUrl)) {
                    event.stopImmediatePropagation();
                    const vttTextCached = vttCache.get(extractedUrl);
                    const dataUri = toDataUri(vttTextCached);
                    _pmInterceptCount++;
                    log(`postMessage #${_pmInterceptCount}: VTT URL → data:URI (~${(dataUri.length / 1024).toFixed(0)}KB)`);

                    let cleanMsg = buildReplacedMsg(msg, extractedUrl, dataUri);
                    cleanMsg._patched = true;

                    if (typeof cloneInto === 'function') {
                        try {
                            cleanMsg = cloneInto(cleanMsg, unsafeWindow);
                        } catch (e) { log(`cloneInto failed: ${e.message}`); }
                    }

                    unsafeWindow.postMessage(cleanMsg, '*');
                }
            } catch (e) {
                log(`postMessage intercept error: ${e.message}`);
            }
        } else if (msg && typeof msg === 'object' && msg.eventType === '[frame-bridge]') {
            try {
                if (msg.body && msg.body.payload && msg.body.payload.data && msg.body.payload.data.ctx) {
                    log('Sanitizing [frame-bridge] payload ctx to prevent XrayWrapper crash.');
                    msg.body.payload.data.ctx = null;
                }
            } catch (e) {
                log(`[frame-bridge] sanitization error: ${e.message}`);
            }
        }
    }, true);

    const tryExtractAttachSubtitle = (msg) => {
        try {
            const data = msg.data;
            if (!data) return;
            const items = Array.isArray(data) ? data[0] :
                data.subtitles || (Array.isArray(data) ? data : null);
            if (!items || !Array.isArray(items) || items.length === 0) return;

            const bilingual = items
                .filter(s => s.translation && s.translation !== s.text && s.translation.trim())
                .map(s => ({
                    start: s.start || s.startTime || 0,
                    end: s.end || s.endTime || 0,
                    text: s.text || s.originText || '',
                    translation: s.translation || ''
                }));

            if (bilingual.length > 0) {
                log(`Extracted ${bilingual.length} translated cues from blocked attachSubtitle.`);
                if (translatedCues.length > 0) {
                    log(`Merging with existing ${translatedCues.length} cues.`);
                    if (bilingual.length >= translatedCues.length) {
                        translatedCues = bilingual;
                    }
                } else {
                    translatedCues = bilingual;
                }
                itTranslationDetected = true;
                hideJWPlayerCaptions();
                log('IT translation detected via attachSubtitle.');
                if (isFirefox) startRender();
            }
        } catch (e) {
            log(`attachSubtitle extract error: ${e.message}`);
        }
    };

    const tryExtractSubtitleResponse = (msg) => {
        try {
            const data = msg.data;
            if (!data) return;
            if (typeof data === 'string' && data.includes('\n') && data.length > 100) {
                const hasTimestamps = /^\d{2}:\d{2}/m.test(data);
                const hasMultipleLines = data.split('\n').length > 5;
                if (hasTimestamps && hasMultipleLines) {
                    log(`subtitleResponse contains VTT data (${data.length} bytes). Checking for translations...`);
                    const parsedCues = parseVTT(data);
                    const bilingual = [];
                    for (const cue of parsedCues) {
                        const parts = cue.text.split(/\n|<br\s*\/?>/i);
                        if (parts.length >= 2) {
                            const source = parts[0].trim();
                            const translation = parts.slice(1).join(' ').trim();
                            if (translation && translation !== source && source.length > 0) {
                                bilingual.push({ ...cue, translation });
                            }
                        }
                    }
                    if (bilingual.length > 0) {
                        log(`IT translations found in subtitleResponse! ${bilingual.length} cues.`);
                        translatedCues = bilingual;
                        itTranslationDetected = true;
                        hideJWPlayerCaptions();
                        log('IT translations active.');
                        if (isFirefox) startRender();
                    } else {
                        log(`subtitleResponse VTT parsed (${parsedCues.length} cues), but no translations detected yet.`);
                    }
                }
            }
            if (typeof data === 'object' && data !== null) {
                if (data.subtitles && Array.isArray(data.subtitles)) {
                    const bilingual = data.subtitles
                        .filter(s => s.translation && s.translation !== s.text)
                        .map(s => ({
                            start: s.start || s.startTime || 0,
                            end: s.end || s.endTime || 0,
                            text: s.text || s.originText || '',
                            translation: s.translation || ''
                        }));
                    if (bilingual.length > 0) {
                        log(`IT translations found in subtitleResponse (object)! ${bilingual.length} cues.`);
                        translatedCues = bilingual;
                        itTranslationDetected = true;
                        hideJWPlayerCaptions();
                        log('IT translations active.');
                        if (isFirefox) startRender();
                    }
                }
            }
        } catch (e) { }
    };

    log('Bridge postMessage interceptor active.');

    // ── 7. IT Translation Monitor (TextTrack-based) ──────────────────
    const startITTranslationMonitor = () => {
        if (textTrackMonitorInterval) clearInterval(textTrackMonitorInterval);

        log('Starting TextTrack monitor for IT translations...');

        textTrackMonitorInterval = setInterval(() => {
            if (itTranslationDetected) return;

            const video = document.querySelector('video');
            if (!video || !video.textTracks) return;

            for (let i = 0; i < video.textTracks.length; i++) {
                const track = video.textTracks[i];
                if (!track.cues || track.cues.length === 0) continue;

                const viPattern = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;
                const bilingualCues = [];
                const rawCueSamples = [];
                for (let j = 0; j < track.cues.length; j++) {
                    const cue = track.cues[j];
                    const text = cue.text || '';
                    if (rawCueSamples.length < 5 && text.includes('\n')) {
                        rawCueSamples.push(`[cue ${j}] ${text.substring(0, 150)}`);
                    }
                    if (!text.includes('\n')) continue;

                    const parts = text.split('\n');
                    const lastPart = parts[parts.length - 1].trim();
                    if (viPattern.test(lastPart)) {
                        const source = parts.slice(0, -1).join('\n').trim();
                        if (source && lastPart !== source) {
                            bilingualCues.push({
                                start: cue.startTime,
                                end: cue.endTime,
                                text: source,
                                translation: lastPart
                            });
                        }
                    }
                }

                if (rawCueSamples.length > 0) {
                    log(`TextTrack raw cue samples (track ${i}, ${track.cues.length} cues):`);
                    rawCueSamples.forEach(s => log(`  ${s}`));
                }

                if (bilingualCues.length > 0) {
                    log(`IT translations detected! ${bilingualCues.length} bilingual cues on track ${i}.`);
                    translatedCues = bilingualCues;
                    itTranslationDetected = true;
                    hideJWPlayerCaptions();
                    log('IT translations active.');
                    if (isFirefox) startRender();
                    return;
                }
            }
        }, 2000);
    };

    // ── 7.5 Custom Bilingual Overlay Render ───────────────────────────
    let overlayContainer = null;
    let currentDisplay = { en: '', vi: '' };

    const ensureOverlay = () => {
        if (overlayContainer && overlayContainer.parentNode) return overlayContainer;

        const video = document.querySelector('video');
        if (!video) return null;

        const videoParent = video.parentNode;
        if (!videoParent) return null;

        let jwContainer = video.closest('.jw-wrapper, .jwplayer, [class*="jw"]');
        if (!jwContainer) jwContainer = videoParent;

        if (!overlayContainer) {
            overlayContainer = document.createElement('div');
            overlayContainer.id = 'it-custom-captions';
            overlayContainer.style.cssText = `
                position: absolute; bottom: 60px; left: 50%; transform: translateX(-50%);
                z-index: 100; pointer-events: none; text-align: center;
                max-width: 90%; width: auto;
            `;
            const ref = jwContainer.querySelector('.jw-captions, .jw-text-track-container') || video;
            if (ref && ref.parentNode) {
                ref.parentNode.insertBefore(overlayContainer, ref.nextSibling || ref);
            } else {
                jwContainer.appendChild(overlayContainer);
            }
            log('Caption overlay created.');
        }
        return overlayContainer;
    };

    const renderCue = (cue) => {
        const container = ensureOverlay();
        if (!container) return;

        if (!cue) {
            container.style.display = 'none';
            return;
        }

        container.style.display = 'block';
        container.innerHTML = `
            <div style="color:#fff;font-size:18px;font-weight:500;text-shadow:1px 1px 3px #000,-1px -1px 3px #000;line-height:1.4;margin-bottom:4px;">
                ${cue.text.replace(/</g, '&lt;').replace(/>/g, '&gt;')}
            </div>
            <div style="color:#ffeb3b;font-size:16px;font-weight:400;text-shadow:1px 1px 3px #000,-1px -1px 3px #000;line-height:1.4;">
                ${cue.translation.replace(/</g, '&lt;').replace(/>/g, '&gt;')}
            </div>
        `;
    };

    const startRender = () => {
        if (renderInterval) clearInterval(renderInterval);

        let lastCueIdx = -1;
        renderInterval = setInterval(() => {
            const video = document.querySelector('video');
            if (!video) {
                renderCue(null);
                return;
            }

            const currTime = video.currentTime;
            let active = null;
            for (let i = 0; i < translatedCues.length; i++) {
                const c = translatedCues[i];
                if (currTime >= c.start && currTime <= c.end) {
                    active = c;
                    break;
                }
            }

            if (active) {
                if (active.text !== currentDisplay.en || active.translation !== currentDisplay.vi) {
                    currentDisplay.en = active.text;
                    currentDisplay.vi = active.translation;
                    renderCue(active);
                }
            } else {
                if (currentDisplay.en !== '' || currentDisplay.vi !== '') {
                    currentDisplay.en = '';
                    currentDisplay.vi = '';
                    renderCue(null);
                }
            }
        }, 100);
        log('Render engine started.');
    };

    const hideJWPlayerCaptions = () => {
        const container = document.querySelector('.jw-captions');
        if (container) {
            container.style.setProperty('display', 'none', 'important');
            log('JWPlayer captions hidden.');
        }
    };

    // ── 8. Boot ──────────────────────────────────────────────────────
    findVtt();

    const vttBootWatcher = setInterval(() => {
        if (vttUrl && !vttText && !fetchInProgress) {
            fetchAndCacheVtt();
        }
        if (vttText && cues.length > 0) {
            clearInterval(vttBootWatcher);
        }
    }, 1000);

    log('v10.5 ready. Pure IT engine fix — no Google fallback.');

    // ── 9. Diagnostic monitors ─────────────────────────────────────────
    // Bridge message summary
    setInterval(() => {
        const types = Object.entries(_bridgeMsgTypes);
        if (types.length === 0 && _bridgeBlockedCount === 0) return;
        const summary = types.map(([k, v]) => `${k}:${v}`).join(', ');
        const blockedInfo = _bridgeBlockedCount > 0 ? ` [BLOCKED: ${_bridgeBlockedCount}]` : '';
        if ((summary + blockedInfo) !== _bridgeLastSummary) {
            _bridgeLastSummary = summary + blockedInfo;
            log(`Bridge messages seen: ${summary}${blockedInfo}`);
        }
    }, 10000);

    // Bridge inactivity detection
    setInterval(() => {
        const total = Object.values(_bridgeMsgTypes).reduce((a, b) => a + b, 0);
        if (total === _bridgeLastCount) {
            log(`BRIDGE INACTIVE - No new bridge messages in last 15s.`);
        }
        _bridgeLastCount = total;
    }, 15000);

    // Icon visibility fix
    setInterval(() => {
        const icon = document.querySelector('.immersive-translate-quick-button-container');
        if (icon) {
            icon.style.setProperty('display', 'inline-flex', 'important');
            icon.style.setProperty('opacity', '1', 'important');
            icon.style.setProperty('visibility', 'visible', 'important');
        }
    }, 5000);

    // Diagnostics: check for IT globals
    setTimeout(() => {
        const itGlobals = [];
        for (let key in unsafeWindow) {
            try {
                const val = unsafeWindow[key];
                if (key.toLowerCase().includes('translate') || key.toLowerCase().includes('imt') || key.toLowerCase().includes('immersive')) {
                    itGlobals.push(`${key}: ${typeof val}`);
                }
            } catch (e) { }
        }
        if (itGlobals.length > 0) {
            log(`IT extension globals found: ${itGlobals.join(', ')}`);
        } else {
            log('No IT extension globals found on window.');
        }
    }, 5000);

    // ── 10. Frame-aware diagnostics & relay ──────────────────────────────
    if (!isInIframe) {
        // TOP FRAME: Listen for log relay from iframes
        window.addEventListener('message', (event) => {
            const data = event.data;
            if (data && data.type === 'it-fix-log') {
                console.log(`[IT-Fix][relay:${data.frameId}] ${data.msg}`);
            }
            // Receive VTT relay from iframe
            if (data && data.type === 'it-fix-vtt-relay') {
                log(`VTT relayed from iframe: ${data.vttUrl?.substring(0, 80)}... (${data.vttText?.length || 0} bytes, ${data.cueCount} cues)`);
                if (data.vttUrl && !vttUrl) {
                    vttUrl = data.vttUrl;
                    vttText = data.vttText;
                    vttCache.set(vttUrl, vttText);
                    cues = parseVTT(vttText);
                    log(`VTT from iframe cached: ${cues.length} cues.`);
                    startITTranslationMonitor();
                }
            }
        });

        // TOP FRAME: Discover iframes
        const discoverIframes = () => {
            const frames = document.querySelectorAll('iframe');
            if (frames.length > 0) {
                log(`Found ${frames.length} iframe(s):`);
                frames.forEach((f, i) => {
                    log(`  iframe[${i}]: src=${f.src?.substring(0, 120) || '(empty)'}, id=${f.id || '(none)'}`);
                });
            } else {
                log('No iframes found on page yet.');
            }

            // Check for player container
            const playerDiv = document.querySelector('#player');
            if (playerDiv) {
                const playerIframe = playerDiv.querySelector('iframe');
                log(`#player div found. Has iframe: ${!!playerIframe}${playerIframe ? ', src=' + playerIframe.src?.substring(0, 120) : ''}`);
            }

            // Check for video element in main frame
            const videos = document.querySelectorAll('video');
            log(`Video elements in TOP frame: ${videos.length}`);

            // Check for JW player elements
            const jwWrapper = document.querySelector('.jw-wrapper');
            const jwButtonContainer = document.querySelector('.jw-button-container');
            log(`JW elements in TOP: .jw-wrapper=${!!jwWrapper}, .jw-button-container=${!!jwButtonContainer}`);

            // Check IT quick button
            const itQuickBtn = document.querySelector('.immersive-translate-quick-button-container');
            log(`IT quick button in TOP: ${!!itQuickBtn}`);
        };

        // Run discovery multiple times to catch dynamically loaded iframes
        setTimeout(discoverIframes, 3000);
        setTimeout(discoverIframes, 8000);
        setTimeout(discoverIframes, 15000);

        // Watch for new iframes being added
        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.tagName === 'IFRAME') {
                        log(`New IFRAME added: src=${node.src?.substring(0, 120)}`);
                    }
                    if (node.querySelector) {
                        const nestedIframes = node.querySelectorAll('iframe');
                        nestedIframes.forEach(f => {
                            log(`New nested IFRAME added: src=${f.src?.substring(0, 120)}`);
                        });
                    }
                }
            }
        });
        try {
            observer.observe(document.documentElement || document, { childList: true, subtree: true });
        } catch(e) {
            document.addEventListener('DOMContentLoaded', () => {
                observer.observe(document.documentElement, { childList: true, subtree: true });
            });
        }

    } else {
        // IFRAME: Enhanced diagnostics
        log(`Running inside IFRAME. Origin: ${location.origin}, Path: ${location.pathname}`);

        // Check for JW player elements after load
        const iframePlayerCheck = () => {
            const jwWrapper = document.querySelector('.jw-wrapper');
            const jwButtonContainer = document.querySelector('.jw-button-container');
            const videos = document.querySelectorAll('video');
            const tracks = [];
            videos.forEach(v => {
                for (let i = 0; i < v.textTracks.length; i++) {
                    tracks.push({ kind: v.textTracks[i].kind, label: v.textTracks[i].label, cues: v.textTracks[i].cues?.length || 0 });
                }
            });
            log(`IFRAME player check: videos=${videos.length}, .jw-wrapper=${!!jwWrapper}, .jw-button-container=${!!jwButtonContainer}, textTracks=${JSON.stringify(tracks)}`);

            // IT quick button in iframe
            const itQuickBtn = document.querySelector('.immersive-translate-quick-button-container');
            log(`IT quick button in IFRAME: ${!!itQuickBtn}`);

            // Check if jwplayer global exists
            log(`IFRAME globals: jwplayer=${typeof unsafeWindow.jwplayer}, Hls=${typeof unsafeWindow.Hls}`);

            // Relay VTT to parent if found
            if (vttUrl && vttText) {
                log(`Relaying VTT to parent: ${vttUrl.substring(0, 80)}`);
                try {
                    window.parent.postMessage({
                        type: 'it-fix-vtt-relay',
                        vttUrl: vttUrl,
                        vttText: vttText,
                        cueCount: cues.length
                    }, '*');
                } catch(e) {
                    log(`VTT relay failed: ${e.message}`);
                }
            }
        };

        setTimeout(iframePlayerCheck, 3000);
        setTimeout(iframePlayerCheck, 8000);
        setTimeout(iframePlayerCheck, 15000);
    }

    log(`v10.5 initialization complete. isInIframe=${isInIframe}`);
})();