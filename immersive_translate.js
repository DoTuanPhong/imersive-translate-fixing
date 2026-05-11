// ==UserScript==
// @name         Megaplay.buzz Immersive Translate Fix v7.1
// @namespace    http://tampermonkey.net/
// @version      7.1
// @description  Hybrid: feeds VTT to IT extension for translation, intercepts result, renders in custom overlay. Falls back to self-contained translation if extension fails.
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

    // ── 1. GM_webRequest for VTT (fixes 403) ──────────────────────────
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
            }], (info) => { if (info?.result === 'success') log(`webRequest OK: ${(info.url||'').substring(0, 80)}`); });
            log('GM_webRequest registered.');
        }
    } catch (e) { log(`GM_webRequest: ${e.message}`); }

    // ── 2. VTT Discovery & Cache ──────────────────────────────────────
    let vttUrl = null;
    let vttText = null;
    let cues = [];
    let translatedCues = [];
    let renderInterval = null;
    let extensionFoundSubtitles = false; // set when IT extension responds

    // VTT cache for postMessage interception
    const vttCache = new Map();

    // Normalize URL
    const normalizeUrl = (url) => {
        if (!url || typeof url !== 'string') return url;
        try {
            let t = url;
            if (url.startsWith('//')) t = globalThis.location.protocol + url;
            else if (url.startsWith('/')) t = location.origin + url;
            else if (!url.startsWith('http')) t = location.protocol + '//' + url;
            return new URL(t).href;
        } catch (e) {
            return url;
        }
    };

    // Data URI encoder
    const toDataUri = (text) => {
        const b64 = btoa(encodeURIComponent(text).replace(/%([0-9A-F]{2})/g, (_, p1) =>
            String.fromCharCode(parseInt(p1, 16))));
        return 'data:text/vtt;charset=utf-8;base64,' + b64;
    };

    // ★ Intercept page fetch() for VTT (JWPlayer may use fetch)
    const origPageFetch = unsafeWindow.fetch;
    if (origPageFetch) {
        unsafeWindow.fetch = function (...args) {
            const rawUrl = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
            if (typeof rawUrl === 'string' && rawUrl.includes('.vtt') && rawUrl.includes('lostproject.club') && !vttUrl) {
                vttUrl = rawUrl;
                log(`VTT detected via fetch: ${vttUrl}`);
                setTimeout(() => fetchAndProcessVtt(), 500);
            }
            // Serve cached VTT to page fetches
            if (typeof rawUrl === 'string' && rawUrl.includes('.vtt')) {
                const normUrl = normalizeUrl(rawUrl);
                if (vttCache.has(normUrl)) {
                    log(`page fetch: serving cached VTT (${vttCache.get(normUrl).length} bytes)`);
                    return Promise.resolve(new Response(vttCache.get(normUrl), {
                        status: 200, statusText: 'OK',
                        headers: { 'Content-Type': 'text/vtt; charset=utf-8' }
                    }));
                }
            }
            return origPageFetch.apply(this, args);
        };
    }

    // ★ XHR interceptor: detect VTT URLs
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
        if (typeof url === 'string' && url.includes('.vtt') && !vttUrl) {
            vttUrl = normalizeUrl(url);
            log(`VTT via XHR: ${vttUrl}`);
        }
        return origOpen.apply(this, arguments);
    };

    // ── 3. Fetch VTT via GM_xmlhttpRequest ────────────────────────────
    let fetchInProgress = false;

    const fetchAndProcessVtt = () => {
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
                // Cache for postMessage interception
                vttCache.set(vttUrl, vttText);
                cues = parseVTT(vttText);
                log(`VTT parsed: ${cues.length} cues. Cached for IT extension.`);

                // Inject track elements to trigger IT extension detection
                injectSubtitleTracks();

                // After a delay, if extension hasn't responded, fall back to self-translate
                setTimeout(() => {
                    if (!extensionFoundSubtitles) {
                        log('Extension did not respond in time. Starting self-contained translation.');
                        translateAllCues();
                    }
                }, 8000);
            },
            onerror: () => {
                log('VTT fetch network error');
                fetchInProgress = false;
            }
        });
    };

    // ── 4. Parse VTT ─────────────────────────────────────────────────
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

    // ── 5. Inject subtitle tracks (v3.6-style) ────────────────────────
    const injectSubtitleTracks = () => {
        const video = document.querySelector('video');
        if (!video || !vttUrl || !vttText) return;

        if (video.dataset.itPatched && video.querySelector('track[data-it-patch="true"]')) {
            return; // already injected
        }

        video.dataset.itPatched = '1';
        video.dataset.itVttUrl = vttUrl;
        video.dataset.immersiveTranslateVideoId = 'anisuge-' + Date.now();
        if (video.crossOrigin !== 'anonymous') video.crossOrigin = 'anonymous';

        const dataUri = toDataUri(vttText);

        // Inject track elements
        const lang = { id: 'en', label: 'English' };
        const track = document.createElement('track');
        track.kind = 'subtitles';
        track.label = lang.label;
        track.srclang = lang.id;
        track.default = true;
        track.setAttribute('data-it-patch', 'true');
        track.src = dataUri;
        video.appendChild(track);

        setTimeout(() => {
            if (track.track) { track.track.mode = 'hidden'; }
        }, 500);

        log('Track element injected. Triggering extension re-scan...');

        // Dispatch events and fake XHR to trigger extension re-scan
        setTimeout(() => {
            try {
                const fakeReq = new XMLHttpRequest();
                fakeReq.open('GET', vttUrl, true);
                fakeReq.send();
            } catch (e) { /* ignore */ }

            ['loadedmetadata', 'loadeddata', 'canplay', 'play', 'durationchange', 'timeupdate', 'seeked']
                .forEach(ev => video.dispatchEvent(new Event(ev, { bubbles: true })));
        }, 500);
    };

    // ── 6. PostMessage interception (v3.6-style) ──────────────────────
    // IT extension injects a bridge script that hooks page fetch/XHR and
    // sends VTT URLs to the extension via postMessage (eventType:"imt-subtitle-inject").
    // The extension then fetches from its own fetch (moz-extension:// origin),
    // which fails CORS. We intercept and swap the VTT URL with a data: URI.
    const _origPostMessage = unsafeWindow.postMessage.bind(unsafeWindow);
    const IM_BRIDGE_EVENT = 'imt-subtitle-inject';
    let _pmInterceptCount = 0;

    // Extract VTT URL from bridge message data
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

    // Build a cleaned message with the URL replaced
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
                        } catch (e) {
                            cleanData[dk] = srcData[dk];
                        }
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

    // Extract subtitle cue data from IT extension messages
    const extractITSubtitleData = (msg) => {
        try {
            const data = msg.data || msg;
            // IT extension sends subtitle data in various formats.
            // Format: data.subtitles = [{start, end, text, translation}, ...]
            if (data && data.subtitles && Array.isArray(data.subtitles) && data.subtitles.length > 0) {
                // Check if subtitles have translations
                const hasTranslation = data.subtitles.some(s => s.translation || s.displayText);
                if (hasTranslation) {
                    return data.subtitles.map(s => ({
                        start: s.start || s.startTime || 0,
                        end: s.end || s.endTime || 0,
                        text: s.originText || s.text || '',
                        translation: s.translation || ''
                    }));
                }
                // No translations yet, but we have subtitles
                return null;
            }
            return null;
        } catch (e) {
            return null;
        }
    };

    unsafeWindow.postMessage = function (msg) {
        // Handle bridge messages
        if (msg && typeof msg === 'object' && msg.eventType === IM_BRIDGE_EVENT) {
            try {
                // ★ Intercept IT extension's translation results
                // When attachSubtitle or similar messages arrive with translated data
                const type = msg.type || '';
                if (type === 'attachSubtitle' || type === 'imt-attach-subtitle-update') {
                    const itData = extractITSubtitleData(msg.data || msg);
                    if (itData && itData.length > 0) {
                        log(`IT translation intercepted! ${itData.length} cues from extension.`);
                        translatedCues = itData;
                        extensionFoundSubtitles = true;
                        startRender();
                        // Don't forward to extension → prevents XrayWrapper crash
                        return undefined;
                    }
                }

                // ★ VTT URL interception (v3.6-style)
                const data = msg.data;
                const extractedUrl = extractVttUrl(data);
                if (extractedUrl && vttCache.has(extractedUrl)) {
                    const vttTextCached = vttCache.get(extractedUrl);
                    const dataUri = toDataUri(vttTextCached);
                    _pmInterceptCount++;
                    log(`postMessage #${_pmInterceptCount}: swapping VTT URL → data: URI (~${(dataUri.length / 1024).toFixed(0)}KB)`);
                    const cleanMsg = buildReplacedMsg(msg, extractedUrl, dataUri);
                    if (arguments.length <= 1) return _origPostMessage(cleanMsg);
                    if (arguments.length === 2) return _origPostMessage(cleanMsg, arguments[1]);
                    return _origPostMessage(cleanMsg, arguments[1], arguments[2]);
                }
            } catch (e) {
                log(`postMessage intercept error (passing through): ${e.message}`);
            }
        }

        // Pass-through: preserve exact argument count
        if (arguments.length <= 1) return _origPostMessage(msg);
        if (arguments.length === 2) return _origPostMessage(msg, arguments[1]);
        return _origPostMessage(msg, arguments[1], arguments[2]);
    };

    // Also listen for IT's rendered subtitle data on DOM
    const observeITSubtitleDom = () => {
        const observer = new MutationObserver(() => {
            if (extensionFoundSubtitles) return;
            // Check if IT extension rendered something in .jw-captions
            const container = document.querySelector('.jw-captions');
            if (container) {
                const spans = container.querySelectorAll('span[data-imt-p]');
                // If IT rendered translated content, try to parse it
                if (spans.length > 0) {
                    log('IT extension rendered subtitles to DOM. Checking for data...');
                    // IT might have rendered before crashing - try to extract
                }
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    };

    log('Bridge postMessage interceptor active.');

    // ── 7. Self-contained Translation (fallback, uses Google Translate) ──
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

    const translateText = translateViaGoogle; // default to Google

    const translateAllCues = async () => {
        if (!cues.length) return;
        if (extensionFoundSubtitles) return; // already got IT translation

        const batchSize = 30;
        const batches = [];
        for (let i = 0; i < cues.length; i += batchSize) {
            batches.push(cues.slice(i, i + batchSize));
        }

        let translated = [];
        for (let b = 0; b < batches.length; b++) {
            const batch = batches[b];
            const combined = batch.map(c => c.text).join('\n|||\n');
            const translatedCombined = await translateText(combined);
            const translatedParts = translatedCombined.split(/\s*\|\|\|\s*/);
            for (let j = 0; j < batch.length; j++) {
                translated.push({
                    ...batch[j],
                    translation: translatedParts[j] || batch[j].text
                });
            }
            log(`Translated batch ${b + 1}/${batches.length} (${translated.length}/${cues.length} cues)`);
        }

        translatedCues = translated;
        log(`Translation complete: ${translatedCues.length} cues. Starting render.`);
        startRender();
    };

    // ── 8. Render in custom overlay ──────────────────────────────────
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
            <div style="color:#fff;font-size:18px;font-weight:500;text-shadow:1px 1px 3px #000, -1px -1px 3px #000;line-height:1.4;margin-bottom:4px;">
                ${cue.text.replace(/</g, '&lt;').replace(/>/g, '&gt;')}
            </div>
            <div style="color:#ffeb3b;font-size:16px;font-weight:400;text-shadow:1px 1px 3px #000, -1px -1px 3px #000;line-height:1.4;">
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

    // ── 9. DOM Monitor: detect JWPlayer ───────────────────────────────
    let domWatchStarted = false;
    const startDomWatch = () => {
        if (domWatchStarted) return;
        domWatchStarted = true;

        observeITSubtitleDom();

        const videoObserver = new MutationObserver(() => {
            const video = document.querySelector('video');
            if (video && !video.dataset.itV71Init) {
                video.dataset.itV71Init = '1';
                video.dataset.immersiveTranslateVideoId = 'anisuge-' + Date.now();
                if (video.crossOrigin !== 'anonymous') video.crossOrigin = 'anonymous';
                log('Video element detected. Waiting for VTT...');

                const jw = unsafeWindow.jwplayer;
                if (typeof jw === 'function') {
                    try {
                        const inst = jw();
                        if (inst && inst.getPlaylist) {
                            const playlist = inst.getPlaylist();
                            if (playlist && playlist[0] && playlist[0].tracks) {
                                playlist[0].tracks.forEach(t => {
                                    if (t.file && t.file.includes('.vtt') && !vttUrl) {
                                        vttUrl = t.file;
                                        log(`VTT from JWPlayer: ${vttUrl}`);
                                        fetchAndProcessVtt();
                                    }
                                });
                            }
                        }
                    } catch (e) { }
                }
            }

            // After VTT is cached, try injecting tracks if video exists
            if (video && vttText && !video.dataset.itPatched) {
                injectSubtitleTracks();
            }
        });

        videoObserver.observe(document, { childList: true, subtree: true });
    };

    // ── 10. Icon visibility ──────────────────────────────────────────
    setInterval(() => {
        const icon = document.querySelector('.immersive-translate-quick-button-container');
        if (icon) {
            icon.style.setProperty('display', 'inline-flex', 'important');
            icon.style.setProperty('opacity', '1', 'important');
            icon.style.setProperty('visibility', 'visible', 'important');
        }
    }, 5000);

    // ── 11. Boot ─────────────────────────────────────────────────────
    startDomWatch();
    log('v7.1 ready. Hybrid: IT extension translation + custom overlay render.');

    // Also set video metadata
    setInterval(() => {
        const video = document.querySelector('video');
        if (video && !video.dataset.itFixed) {
            video.dataset.itFixed = '1';
            video.dataset.immersiveTranslateVideoId = 'anisuge-' + Date.now();
            if (video.crossOrigin !== 'anonymous') video.crossOrigin = 'anonymous';
        }
    }, 3000);
})();