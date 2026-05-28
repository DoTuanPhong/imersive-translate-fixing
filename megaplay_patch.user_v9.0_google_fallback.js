// ==UserScript==
// @name         Megaplay.buzz Immersive Translate Fix v9.0
// @namespace    http://tampermonkey.net/
// @version      9.0
// @description  Early fetch override injects Referer for lostproject.club VTT. Works with built-in common-vtt-jw rule (extended via user_rules.json). Google fallback if IT fails.
// @author       Antigravity
// @match        *://anisuge.tv/*
// @match        *://megaplay.buzz/*
// @match        *://1anime.site/*
// @grant        GM_xmlhttpRequest
// @grant        GM_webRequest
// @grant        unsafeWindow
// @run-at       document-start
// @connect      1oe.lostproject.club
// @connect      translate.googleapis.com
// @connect      *
// ==/UserScript==

(function () {
    'use strict';

    const log = (msg) => console.log(`[IT-Fix] ${msg}`);

    // ── 0. Safe Anti-Debug ────────────────────────────────────────────
    {
        const _Function = unsafeWindow.Function, _eval = unsafeWindow.eval;
        const _setInterval = unsafeWindow.setInterval;

        const hookFn = function (...args) {
            const body = args[args.length - 1];
            if (typeof body === 'string' && /debugger/i.test(body)) return function () { };
            return _Function.apply(this, args);
        };
        hookFn.prototype = _Function.prototype;
        unsafeWindow.Function = hookFn;
        unsafeWindow.Function.prototype.constructor = hookFn;

        unsafeWindow.eval = function (code) {
            if (typeof code === 'string' && /debugger/i.test(code)) return;
            return _eval.apply(this, arguments);
        };

        unsafeWindow.setInterval = function (fn, delay, ...args) {
            if (typeof fn === 'function' && fn.toString().includes('debugger')) return 0;
            if (typeof fn === 'string' && fn.includes('debugger')) return 0;
            return _setInterval.apply(this, arguments);
        };

        try {
            Object.defineProperty(unsafeWindow.console, 'clear', {
                value: function () { }, writable: false, configurable: false
            });
        } catch (e) {
            try { unsafeWindow.console.clear = function () { }; } catch (e2) { }
        }
    }
    log('Anti-debug active.');

    // ── 0.5 ★ CRITICAL: Preact XrayWrapper Fix ────────────────────────
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

    // ── 0.6 ★ CRITICAL: Monkey-patch TextTrackCue.prototype.innerHTML ──
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
    let itTranslationTimeout = null;
    const vttCache = new Map();

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

    // ── 3.5 ★ CRITICAL: Early window.fetch Override ───────────────────
    // Installed at document-start BEFORE extension inject script saves
    // globalThis.__originalFetch. Intercepts ALL VTT fetches to:
    // 1. Inject Referer/Origin headers for lostproject.club VTTs (GM_xmlhttpRequest)
    // 2. Serve cached VTTs from vttCache (for re-fetch scenarios)
    // 3. Discover VTT URLs (detection pass-through)
    // Extension's _fetchSubtitle and content-script hooks inherit this override,
    // so they too get Referer-injected VTT responses.
    const VTT_FETCH_REGEX = /lostproject\.club\/.+\.vtt/i;
    const _origFetch = unsafeWindow.fetch;

    unsafeWindow.fetch = function (input, init) {
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

        // lostproject.club VTT: inject Referer via GM_xmlhttpRequest
        if (VTT_FETCH_REGEX.test(urlStr)) {
            const normUrl = normalizeUrl(urlStr);

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

    // XHR interceptor: detect VTT URLs (separate from fetch path)
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
        if (typeof url === 'string' && url.includes('.vtt') && !vttUrl) {
            vttUrl = normalizeUrl(url);
            log(`VTT via XHR: ${vttUrl}`);
        }
        return origOpen.apply(this, arguments);
    };

    // ── 5. Fetch & Cache VTT (for our fallback + IT monitor) ──────────
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

                // Set video metadata
                const video = document.querySelector('video');
                if (video) {
                    video.dataset.itVttUrl = vttUrl;
                    video.dataset.immersiveTranslateVideoId = 'anisuge-' + Date.now();
                    if (video.crossOrigin !== 'anonymous') video.crossOrigin = 'anonymous';
                }

                startITTranslationMonitor();

                if (itTranslationTimeout) clearTimeout(itTranslationTimeout);
                itTranslationTimeout = setTimeout(() => {
                    if (!itTranslationDetected) {
                        log('IT extension did not translate within timeout. Starting Google fallback.');
                        translateAllCuesViaGoogle();
                    }
                }, 15000);
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

    let _bridgeMsgTypes = {};
    let _bridgeBlockedCount = 0;

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

    window.addEventListener('message', function (event) {
        const msg = event.data;
        if (msg && typeof msg === 'object' && msg.eventType === IM_BRIDGE_EVENT) {
            if (msg._patched) return;

            try {
                const msgType = msg.type || 'unknown';
                if (!_bridgeMsgTypes[msgType]) {
                    _bridgeMsgTypes[msgType] = 0;
                    log(`Bridge msg "${msgType}" (from=${msg.from}, to=${msg.to}) payload=${previewPayload(msg.data)}`);
                }
                _bridgeMsgTypes[msgType]++;

                if (PREACT_CRASH_MSG_TYPES.has(msgType)
                    && msg.from === 'content-script' && msg.to === 'inject') {
                    event.stopImmediatePropagation();
                    _bridgeBlockedCount++;
                    log(`Blocked "${msgType}" message to prevent XrayWrapper crash.`);
                    if (!itTranslationDetected) tryExtractAttachSubtitle(msg);
                    return;
                }

                if (msgType === 'requestSubtitle' && msg.from === 'content-script' && msg.to === 'inject') {
                    log(`requestSubtitle seen: data keys=${Object.keys(msg.data || {}).join(',')}`);
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
                if (itTranslationTimeout) clearTimeout(itTranslationTimeout);
                hideJWPlayerCaptions();
                startRender();
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
                        if (itTranslationTimeout) clearTimeout(itTranslationTimeout);
                        hideJWPlayerCaptions();
                        startRender();
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
                        if (itTranslationTimeout) clearTimeout(itTranslationTimeout);
                        hideJWPlayerCaptions();
                        startRender();
                    }
                }
            }
        } catch (e) { }
    };

    log('Bridge postMessage interceptor active.');

    // ── 7. IT Translation Monitor (TextTrack-based) ──────────────────
    let textTrackMonitorInterval = null;

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
                    if (itTranslationTimeout) clearTimeout(itTranslationTimeout);
                    hideJWPlayerCaptions();
                    startRender();
                    return;
                }
            }
        }, 2000);
    };

    const hideJWPlayerCaptions = () => {
        const container = document.querySelector('.jw-captions');
        if (container) {
            container.style.setProperty('display', 'none', 'important');
            log('JWPlayer captions hidden.');
        }
    };

    // ── 8. Google Translate Fallback ─────────────────────────────────
    const translateViaGoogle = async (text) => {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=vi&dt=t&q=${encodeURIComponent(text)}`;
        try {
            const resp = await fetch(url);
            const json = await resp.json();
            if (json && json[0]) {
                return json[0].map(part => part[0]).join('');
            }
            return text;
        } catch (e) {
            return `[ERR: ${e.message}]`;
        }
    };

    const translateAllCuesViaGoogle = async () => {
        if (!cues.length) return;
        if (itTranslationDetected) return;

        const batchSize = 30;
        const batches = [];
        for (let i = 0; i < cues.length; i += batchSize) {
            batches.push(cues.slice(i, i + batchSize));
        }

        let translated = [];
        for (let b = 0; b < batches.length; b++) {
            const batch = batches[b];
            const combined = batch.map(c => c.text).join('\n|||\n');
            const translatedCombined = await translateViaGoogle(combined);
            const translatedParts = translatedCombined.split(/\s*\|\|\|\s*/);
            for (let j = 0; j < batch.length; j++) {
                translated.push({
                    ...batch[j],
                    translation: translatedParts[j] || batch[j].text
                });
            }
            log(`Google batch ${b + 1}/${batches.length} (${translated.length}/${cues.length} cues)`);
        }

        translatedCues = translated;
        itTranslationDetected = true;
        hideJWPlayerCaptions();
        log(`Google translation complete: ${translatedCues.length} cues.`);
        startRender();
    };

    // ── 9. Custom Bilingual Overlay Render ────────────────────────────
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
            if (!video || !translatedCues.length) return;

            const ct = video.currentTime;
            if (isNaN(ct)) return;

            let lo = 0, hi = translatedCues.length - 1, activeIdx = -1;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                const c = translatedCues[mid];
                if (c.start <= ct && c.end >= ct) { activeIdx = mid; break; }
                if (ct < c.start) hi = mid - 1;
                else lo = mid + 1;
            }

            if (activeIdx >= 0) {
                const active = translatedCues[activeIdx];
                if (activeIdx !== lastCueIdx) {
                    lastCueIdx = activeIdx;
                    if (currentDisplay.en !== active.text || currentDisplay.vi !== active.translation) {
                        currentDisplay = { en: active.text, vi: active.translation };
                        renderCue(active);
                    }
                }
            } else if (lastCueIdx !== -1) {
                lastCueIdx = -1;
                if (currentDisplay.en !== '') {
                    currentDisplay = { en: '', vi: '' };
                    renderCue(null);
                }
            }
        }, 100);
        log('Render engine started.');
    };

    // ── 10. Bridge message diagnostics ────────────────────────────────
    let _bridgeLastSummary = '';
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

    // ── 11. Icon visibility fix ──────────────────────────────────────
    setInterval(() => {
        const icon = document.querySelector('.immersive-translate-quick-button-container');
        if (icon) {
            icon.style.setProperty('display', 'inline-flex', 'important');
            icon.style.setProperty('opacity', '1', 'important');
            icon.style.setProperty('visibility', 'visible', 'important');
        }
    }, 5000);

    // ── 12. Boot ──────────────────────────────────────────────────────
    findVtt();

    const vttBootWatcher = setInterval(() => {
        if (vttUrl && !vttText && !fetchInProgress) {
            fetchAndCacheVtt();
        }
        if (vttText && cues.length > 0) {
            clearInterval(vttBootWatcher);
        }
    }, 1000);

    log('v9.0 ready. Early fetch override + common-vtt-jw integration + Google fallback.');

    // ── 13. Diagnostics ──────────────────────────────────────────────
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

    let _bridgeLastCount = 0;
    setInterval(() => {
        const total = Object.values(_bridgeMsgTypes).reduce((a, b) => a + b, 0);
        if (total === _bridgeLastCount) {
            log(`BRIDGE INACTIVE - No new bridge messages in last 15s.`);
        }
        _bridgeLastCount = total;
    }, 15000);
})();