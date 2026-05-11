// ==UserScript==
// @name         Megaplay.buzz Immersive Translate Fix v8.0
// @namespace    http://tampermonkey.net/
// @version      8.0
// @description  Feeds VTT to IT extension via data:URI, monitors TextTrack for IT's translations, renders bilingual overlay. Google fallback if IT fails.
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

    // ── 1. GM_webRequest for VTT (fixes 403 CORS) ─────────────────────
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
    let itTranslationDetected = false;  // set when IT extension's translations appear
    let itTranslationTimeout = null;

    // VTT cache for postMessage interception
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

    // ── 4. VTT Discovery ──────────────────────────────────────────────
    // ★ Active VTT scanner (checks JWPlayer, ArtPlayer, window properties)
    const findVtt = () => {
        let raw = null;
        // ArtPlayer check
        const art = unsafeWindow.artplayer || (unsafeWindow.art && unsafeWindow.art.instances && unsafeWindow.art.instances[0]);
        if (art && art.option && art.option.subtitle && art.option.subtitle.url && art.option.subtitle.url.includes('.vtt')) {
            raw = art.option.subtitle.url;
            log(`VTT from ArtPlayer: ${raw}`);
        }
        // JWPlayer check
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
        // Window properties scan
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

    // Intercept page fetch for VTT detection + cache serving
    const origPageFetch = unsafeWindow.fetch;
    if (origPageFetch) {
        unsafeWindow.fetch = function (...args) {
            const rawUrl = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
            if (typeof rawUrl === 'string' && rawUrl.includes('.vtt') && !vttUrl) {
                vttUrl = normalizeUrl(rawUrl);
                log(`VTT detected via fetch: ${vttUrl}`);
            }
            if (typeof rawUrl === 'string' && rawUrl.includes('.vtt')) {
                const normUrl = normalizeUrl(rawUrl);
                if (vttCache.has(normUrl)) {
                    return Promise.resolve(new Response(vttCache.get(normUrl), {
                        status: 200, statusText: 'OK',
                        headers: { 'Content-Type': 'text/vtt; charset=utf-8' }
                    }));
                }
            }
            return origPageFetch.apply(this, args);
        };
    }

    // XHR interceptor: detect VTT URLs
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
        if (typeof url === 'string' && url.includes('.vtt') && !vttUrl) {
            vttUrl = normalizeUrl(url);
            log(`VTT via XHR: ${vttUrl}`);
        }
        return origOpen.apply(this, arguments);
    };

    // Run findVtt immediately at startup
    findVtt();

    // ── 5. Fetch & Cache VTT ─────────────────────────────────────────
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

                // Inject track elements to trigger IT extension
                injectSubtitleTracks();

                // Start IT translation monitoring
                startITTranslationMonitor();

                // Fallback timer: if IT doesn't translate in 15s, use Google
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

    // ── 6. Inject subtitle tracks (v3.6-style, triggers IT extension) ─
    const injectSubtitleTracks = () => {
        const video = document.querySelector('video');
        if (!video || !vttUrl || !vttText) return;

        video.dataset.itPatched = '1';
        video.dataset.itVttUrl = vttUrl;
        video.dataset.immersiveTranslateVideoId = 'anisuge-' + Date.now();
        if (video.crossOrigin !== 'anonymous') video.crossOrigin = 'anonymous';

        const dataUri = toDataUri(vttText);

        const track = document.createElement('track');
        track.kind = 'subtitles';
        track.label = 'English';
        track.srclang = 'en';
        track.default = true;
        track.setAttribute('data-it-patch', 'true');
        track.src = dataUri;
        video.appendChild(track);

        setTimeout(() => {
            if (track.track) { track.track.mode = 'hidden'; }
        }, 500);

        log('Track element injected. Triggering extension re-scan...');

        // Trigger bridge re-scan: fake XHR + video events
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

    // ── 7. PostMessage Interception (v3.6 data:URI swap) ─────────────
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

    // ★ Diagnostic: log all bridge message types for debugging
    let _bridgeMsgTypes = {};

    unsafeWindow.postMessage = function (msg) {
        if (msg && typeof msg === 'object' && msg.eventType === IM_BRIDGE_EVENT) {
            try {
                const msgType = msg.type || 'unknown';
                if (!_bridgeMsgTypes[msgType]) {
                    _bridgeMsgTypes[msgType] = 0;
                    log(`Bridge message type seen: "${msgType}" (from=${msg.from}, to=${msg.to})`);
                }
                _bridgeMsgTypes[msgType]++;

                // ★ BLOCK: Prevent attachSubtitle from reaching inject → prevents XrayWrapper crash
                // The React renderer (te at line 6236) runs when inject handles attachSubtitle.
                // By blocking this message, the inject never renders React → no cross-origin DOM access.
                // ALWAYS block, even after translations detected (prevents delayed crash).
                if ((msgType === 'attachSubtitle' || msgType === 'imt-attach-subtitle-update')
                    && msg.from === 'content-script' && msg.to === 'inject') {
                    log(`Blocked "${msgType}" message to prevent XrayWrapper crash.`);
                    if (!itTranslationDetected) tryExtractAttachSubtitle(msg);
                    return undefined;
                }

                // ★ Intercept subtitleResponse: may contain translated data
                if (msgType === 'subtitleResponse' && !itTranslationDetected) {
                    tryExtractSubtitleResponse(msg);
                }

                // VTT URL interception (data:URI swap)
                const data = msg.data;
                const extractedUrl = extractVttUrl(data);
                if (extractedUrl && vttCache.has(extractedUrl)) {
                    const vttTextCached = vttCache.get(extractedUrl);
                    const dataUri = toDataUri(vttTextCached);
                    _pmInterceptCount++;
                    log(`postMessage #${_pmInterceptCount}: VTT URL → data:URI (~${(dataUri.length / 1024).toFixed(0)}KB)`);
                    const cleanMsg = buildReplacedMsg(msg, extractedUrl, dataUri);
                    if (arguments.length <= 1) return _origPostMessage(cleanMsg);
                    if (arguments.length === 2) return _origPostMessage(cleanMsg, arguments[1]);
                    return _origPostMessage(cleanMsg, arguments[1], arguments[2]);
                }
            } catch (e) {
                log(`postMessage intercept error: ${e.message}`);
            }
        }
        if (arguments.length <= 1) return _origPostMessage(msg);
        if (arguments.length === 2) return _origPostMessage(msg, arguments[1]);
        return _origPostMessage(msg, arguments[1], arguments[2]);
    };

    // Extract translated cues from blocked attachSubtitle message
    const tryExtractAttachSubtitle = (msg) => {
        try {
            const data = msg.data;
            if (!data) return;
            // Format: data may be [subtitleItems, lang] or {subtitles: [...]}
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
                // Merge with existing if we already have partial data
                if (translatedCues.length > 0) {
                    log(`Merging with existing ${translatedCues.length} cues.`);
                    // Replace cues from same time range
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

    // Try to extract translated cues from subtitleResponse messages
    const tryExtractSubtitleResponse = (msg) => {
        try {
            const data = msg.data;
            if (!data) return;
            // Data could be a VTT string with translated cue text
            // IT extension appends translations with \n separator
            if (typeof data === 'string' && data.includes('\n') && data.length > 100) {
                // Check if it looks like translated VTT content (contains timestamps + translated lines)
                const hasTimestamps = /^\d{2}:\d{2}/m.test(data);
                const hasMultipleLines = data.split('\n').length > 5;
                if (hasTimestamps && hasMultipleLines) {
                    log(`subtitleResponse contains VTT data (${data.length} bytes). Checking for translations...`);
                    // Parse and check for bilingual cues
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
            // Also try extracting from object format
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
        } catch (e) {
            // Silently fail - this is best-effort
        }
    };

    log('Bridge postMessage interceptor active.');

    // ── 8. IT Translation Monitor (TextTrack-based) ──────────────────
    // Strategy: The extension translates subtitles by modifying TextTrack cues.
    // We detect bilingual cues (original\n+translation) and extract the translation.
    // This avoids the React attach path (XrayWrapper crash).
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

                // Check if cues contain bilingual text (IT extension added translations)
                // The extension appends translations with \n separator
                const bilingualCues = [];
                for (let j = 0; j < track.cues.length; j++) {
                    const cue = track.cues[j];
                    const text = cue.text || '';
                    // IT extension uses \n or <br/> separator between source and translation
                    const parts = text.split(/\n|<br\s*\/?>/i);
                    if (parts.length >= 2) {
                        const source = parts[0].trim();
                        const translation = parts.slice(1).join(' ').trim();
                        // Translation should differ from source and not be empty
                        if (translation && translation !== source && source.length > 0) {
                            bilingualCues.push({
                                start: cue.startTime,
                                end: cue.endTime,
                                text: source,
                                translation: translation
                            });
                        }
                    }
                }

                if (bilingualCues.length > 0) {
                    log(`IT translations detected! ${bilingualCues.length} bilingual cues on track ${i}.`);
                    translatedCues = bilingualCues;
                    itTranslationDetected = true;
                    if (itTranslationTimeout) clearTimeout(itTranslationTimeout);

                    // Hide JWPlayer's native captions since we render our own
                    hideJWPlayerCaptions();

                    startRender();
                    return;
                }
            }
        }, 2000); // Check every 2 seconds
    };

    const hideJWPlayerCaptions = () => {
        // Hide JWPlayer's native CC container
        const container = document.querySelector('.jw-captions');
        if (container) {
            container.style.setProperty('display', 'none', 'important');
            log('JWPlayer captions hidden.');
        }
    };

    // ── 9. Google Translate Fallback ──────────────────────────────────
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

    // ── 10. Custom Bilingual Overlay Render ───────────────────────────
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

    // ── 11. 3-Second Polling Loop (v3.6 proven pattern) ────────────
    // This is the critical engine: continuously discovers VTT URLs,
    // injects track elements, triggers extension re-scan.
    let pollingStarted = false;
    const startPolling = () => {
        if (pollingStarted) return;
        pollingStarted = true;
        log('Polling engine started (3s interval).');

        setInterval(() => {
            // Step 1: Discover VTT URL if not yet known
            if (!vttUrl) {
                findVtt();
                if (!vttUrl) return; // still no VTT found, try next cycle
            }

            // Step 2: If VTT URL known but not fetched yet, fetch now
            if (!vttText) {
                fetchAndCacheVtt();
                return;
            }

            // Step 3: Ensure video has track elements injected
            const video = document.querySelector('video');
            if (!video) return;

            // Set video metadata (once)
            if (!video.dataset.itV8Init) {
                video.dataset.itV8Init = '1';
                video.dataset.itVttUrl = vttUrl;
                video.dataset.immersiveTranslateVideoId = 'anisuge-' + Date.now();
                if (video.crossOrigin !== 'anonymous') video.crossOrigin = 'anonymous';
                log('Video element detected.');
            }

            // Handle VTT URL change (re-inject if needed)
            if (video.dataset.itVttUrl && video.dataset.itVttUrl !== vttUrl) {
                log('VTT URL changed, re-injecting tracks.');
                video.querySelectorAll('track[data-it-patch="true"]').forEach(t => t.remove());
                delete video.dataset.itPatched;
                delete video.dataset.itVttUrl;
            }

            // Skip if already injected and cues are loaded
            if (video.querySelector('track[data-it-patch="true"]')) {
                const tracks = video.querySelectorAll('track[data-it-patch="true"]');
                let allLoaded = true;
                tracks.forEach(t => {
                    if (!t.track || !t.track.cues || t.track.cues.length === 0) allLoaded = false;
                });
                if (allLoaded) {
                    // Already good — just poke video events to trigger extension
                    ['loadedmetadata', 'loadeddata', 'canplay', 'play', 'timeupdate', 'seeked']
                        .forEach(ev => video.dispatchEvent(new Event(ev, { bubbles: true })));
                    return;
                }
                // Tracks exist but not loaded — remove and re-inject
                tracks.forEach(t => t.remove());
                delete video.dataset.itPatched;
            }

            // Step 4: Inject track elements
            injectSubtitleTracks();

            // Step 5: Set up TextTrack listeners (once)
            if (!video._itListenersSet) {
                video._itListenersSet = true;
                try {
                    video.textTracks.addEventListener('addtrack', () => {
                        setTimeout(() => {
                            ['loadedmetadata', 'loadeddata'].forEach(ev =>
                                video.dispatchEvent(new Event(ev, { bubbles: true })));
                        }, 800);
                    });
                } catch (e) { /* textTracks might not be available yet */ }
            }
        }, 3000);
    };

    // ── 12. Bridge message type diagnostics ─────────────────────────
    let _bridgeLastSummary = '';
    setInterval(() => {
        const types = Object.entries(_bridgeMsgTypes);
        if (types.length === 0) return;
        const summary = types.map(([k, v]) => `${k}:${v}`).join(', ');
        if (summary !== _bridgeLastSummary) {
            _bridgeLastSummary = summary;
            log(`Bridge messages seen: ${summary}`);
        }
    }, 10000);

    // ── 13. Icon visibility fix ──────────────────────────────────────
    setInterval(() => {
        const icon = document.querySelector('.immersive-translate-quick-button-container');
        if (icon) {
            icon.style.setProperty('display', 'inline-flex', 'important');
            icon.style.setProperty('opacity', '1', 'important');
            icon.style.setProperty('visibility', 'visible', 'important');
        }
    }, 5000);

    // ── 14. Boot ─────────────────────────────────────────────────────
    startPolling();
    log('v8.0 ready. Polling engine + TextTrack monitor + data:URI bridge + Google fallback.');
})();