// ==UserScript==
// @name         Megaplay.buzz Ultra-Patch (Anti-Debug & Subtitle)
// @namespace    http://tampermonkey.net/
// @version      3.6
// @description  Fixes Immersive Translate bilingual subtitles on anisuge.tv/megaplay.buzz via bridge postMessage intercept + data:URI injection
// @author       Antigravity
// @match        *://anisuge.tv/*
// @match        *://megaplay.buzz/*
// @match        *://1anime.site/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @run-at       document-start
// @connect      1oe.lostproject.club
// @connect      *
// ==/UserScript==

(function () {
    'use strict';

    // VTT content cache: normalized URL → text content
    const vttCache = new Map();
    let vttUrl = null;
    let vttContent = null;

    const log = (msg) => {
        const fullMsg = `[Ultra-Patch] ${msg}`;
        console.log(fullMsg);
    };

    // Normalize URL to full absolute form (matches inject.js's g() function logic)
    const normalizeUrl = (url) => {
        if (!url || typeof url !== 'string') return url;
        try {
            let t = url;
            if (url.startsWith('//')) t = globalThis.location.protocol + url;
            else if (url.startsWith('/')) t = location.origin + url;
            else if (!url.startsWith('http')) t = location.protocol + '//' + url;
            return new URL(t).href; // Normalizes trailing slashes, removes default ports, etc.
        } catch (e) {
            return url; // Return as-is if not a valid URL
        }
    };

    // Data URI encoder for VTT content (UTF-8 safe via base64)
    const toDataUri = (text) => {
        const b64 = btoa(encodeURIComponent(text).replace(/%([0-9A-F]{2})/g, (_, p1) =>
            String.fromCharCode(parseInt(p1, 16))));
        return 'data:text/vtt;charset=utf-8;base64,' + b64;
    };

    // --- ★ CORE FIX: Intercept bridge postMessage → swap VTT URL with data: URI ---
    // Immersive Translate injects a bridge script (imt-subtitles-inject) that hooks page-level
    // fetch/XHR and sends VTT URLs to the extension content script via postMessage.
    // The content script receives the URL and calls _fetchSubtitle(url) using its OWN fetch
    // (moz-extension:// origin), which fails CORS for cross-origin VTT files.
    //
    // We intercept the postMessage bridge call and swap the VTT URL with a data: URI
    // containing cached VTT content. data: URIs are fetchable from any JS context
    // (including moz-extension://) without triggering CORS preflight.
    //
    // The bridge sends VTT URLs in TWO formats:
    //   Format A (XHR path):  data.url = "https://.../....vtt"
    //   Format B (fetch path): data.fetchInfo = '{"input":{"url":"https://.../....vtt"},"options":{}}'
    // Both must be intercepted and the URL replaced with a data: URI.
    //
    // CRITICAL: We must preserve exact postMessage argument count to avoid breaking
    // other page postMessage usage (recaptcha, etc.).
    const _origPostMessage = unsafeWindow.postMessage.bind(unsafeWindow);
    const IM_BRIDGE_EVENT = 'imt-subtitle-inject';
    let _pmInterceptCount = 0;

    // Extract VTT URL from bridge message data (handles both formats A and B)
    const extractVttUrl = (data) => {
        if (!data || typeof data !== 'object') return null;
        // Format A: data.url directly
        if (data.url && typeof data.url === 'string' && data.url.includes('.vtt'))
            return normalizeUrl(data.url);
        // Format B: data.fetchInfo contains JSON with input.url
        if (data.fetchInfo && typeof data.fetchInfo === 'string') {
            try {
                const fi = JSON.parse(data.fetchInfo);
                if (fi.input && fi.input.url && typeof fi.input.url === 'string' && fi.input.url.includes('.vtt'))
                    return normalizeUrl(fi.input.url);
            } catch (e) { /* not valid JSON or no url */ }
        }
        return null;
    };

    // Build a cleaned message with the URL replaced in the appropriate location
    const buildReplacedMsg = (msg, vttUrl, dataUri) => {
        const cleanMsg = {};
        for (const k of Object.keys(msg)) {
            if (k === 'data' && typeof msg[k] === 'object' && msg[k] !== null) {
                const srcData = msg[k];
                const cleanData = {};
                for (const dk of Object.keys(srcData)) {
                    const val = srcData[dk];
                    if (dk === 'url' && typeof val === 'string' && normalizeUrl(val) === vttUrl) {
                        cleanData[dk] = dataUri; // Format A replacement
                    } else if (dk === 'fetchInfo' && typeof srcData[dk] === 'string') {
                        // Format B replacement — patch inside JSON string
                        try {
                            const fi = JSON.parse(srcData[dk]);
                            if (fi.input && typeof fi.input.url === 'string' && normalizeUrl(fi.input.url) === vttUrl) {
                                fi.input.url = dataUri;
                                cleanData[dk] = JSON.stringify(fi);
                            } else {
                                cleanData[dk] = srcData[dk];
                            }
                        } catch (e) {
                            cleanData[dk] = srcData[dk]; // keep original if parsing fails
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

    unsafeWindow.postMessage = function (msg) {
        // Only intercept bridge messages
        if (msg && typeof msg === 'object' && msg.eventType === IM_BRIDGE_EVENT) {
            try {
                const data = msg.data;
                const extractedUrl = extractVttUrl(data);
                if (extractedUrl && vttCache.has(extractedUrl)) {
                    const vttText = vttCache.get(extractedUrl);
                    const dataUri = toDataUri(vttText);
                    _pmInterceptCount++;
                    log(`postMessage #${_pmInterceptCount}: swapping VTT URL → data: URI (~${(dataUri.length / 1024).toFixed(0)}KB)`);
                    log(`  original URL: ${extractedUrl.substring(0, 80)}...`);
                    const cleanMsg = buildReplacedMsg(msg, extractedUrl, dataUri);

                    // Preserve exact argument count
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
    log('Bridge postMessage interceptor active (arguments.length-safe, dual-format A+B, data: URI mode).');

    // --- 1. Anti-Debug ---
    const silenceDebugger = () => {
        const _Function = unsafeWindow.Function;
        const hook = function (...args) {
            const body = args[args.length - 1];
            if (typeof body === 'string' && /debugger/i.test(body)) return function () { };
            return _Function.apply(this, args);
        };
        hook.prototype = _Function.prototype;
        unsafeWindow.Function = hook;
        unsafeWindow.Function.prototype.constructor = hook;

        const _eval = unsafeWindow.eval;
        unsafeWindow.eval = function (code) {
            if (typeof code === 'string' && /debugger/i.test(code)) return;
            return _eval.apply(this, arguments);
        };

        const _setInterval = unsafeWindow.setInterval;
        unsafeWindow.setInterval = function (fn, delay, ...args) {
            if (typeof fn === 'function' && fn.toString().includes('debugger')) return 0;
            if (typeof fn === 'string' && fn.includes('debugger')) return 0;
            return _setInterval.apply(this, arguments);
        };

        unsafeWindow.console.clear = () => { };
        log('Anti-debug deployed.');
    };
    silenceDebugger();

    // --- 2. VTT Scanner ---
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
                    if (typeof val === 'string' && val.includes('.vtt') && val.startsWith('http')) { raw = val; log(`VTT from ${key}: ${raw}`); break; }
                } catch (e) { }
            }
        }
        if (raw) vttUrl = normalizeUrl(raw);
    };

    // --- XHR interceptor: detect VTT URLs ---
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
        if (typeof url === 'string' && url.includes('.vtt')) {
            vttUrl = normalizeUrl(url);
            log(`VTT via XHR: ${vttUrl}`);
        }
        return origOpen.apply(this, arguments);
    };

    // --- Page fetch interceptor: serve cached VTT to page fetches ---
    if (unsafeWindow.fetch) {
        const _pageOrigFetch = unsafeWindow.fetch.bind(unsafeWindow);
        unsafeWindow.fetch = function (...args) {
            const rawUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url;
            if (typeof rawUrl === 'string' && rawUrl.includes('.vtt')) {
                const url = normalizeUrl(rawUrl);
                vttUrl = url;
                if (vttCache.has(url)) {
                    log(`page fetch: serving cached VTT (${vttCache.get(url).length} bytes)`);
                    return Promise.resolve(new Response(vttCache.get(url), {
                        status: 200, statusText: 'OK',
                        headers: { 'Content-Type': 'text/vtt; charset=utf-8' }
                    }));
                }
            }
            return _pageOrigFetch(...args);
        };
    }

    // Run findVtt immediately
    findVtt();

    // --- 3. Parse VTT ---
    function parseVTT(text) {
        if (!text) return [];
        const lines = text.replace(/\r\n/g, '\n').split('\n');
        const cues = [];
        let currentStart = null, currentEnd = null, currentText = [];
        for (const line of lines) {
            const timeMatch = line.match(/^(\d{2}:\d{2}(?::\d{2})?\.\d{3})\s*-->\s*(\d{2}:\d{2}(?::\d{2})?\.\d{3})/);
            if (timeMatch) {
                if (currentStart !== null) cues.push({ start: timeToSeconds(currentStart), end: timeToSeconds(currentEnd), text: currentText.join('\n') });
                currentStart = timeMatch[1]; currentEnd = timeMatch[2]; currentText = [];
            } else if (line.trim() && !line.startsWith('WEBVTT') && !line.startsWith('NOTE') && !line.startsWith('STYLE') && currentStart !== null) {
                currentText.push(line.trim());
            }
        }
        if (currentStart !== null) cues.push({ start: timeToSeconds(currentStart), end: timeToSeconds(currentEnd), text: currentText.join('\n') });
        return cues;
    }

    function timeToSeconds(t) {
        const parts = t.split(':');
        if (parts.length === 3) return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
        if (parts.length === 2) return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
        return parseFloat(parts[0]);
    }

    // --- 4. Inject tracks ---
    async function injectTracks() {
        if (!vttUrl) { findVtt(); if (!vttUrl) return; }
        const video = document.querySelector('video');
        if (!video) return;

        if (!video.dataset.itPatched) {
            video.dataset.itPatched = '1';
            video.dataset.immersiveTranslateVideoId = 'anisuge-' + Date.now();
        }

        if (video.dataset.itPatched && video.dataset.itVttUrl && video.dataset.itVttUrl !== vttUrl) {
            log(`VTT URL changed, re-injecting`);
            video.querySelectorAll('track[data-it-patch="true"]').forEach(t => t.remove());
            delete video.dataset.itPatched;
        }

        if (video.querySelector('track[data-it-patch="true"]')) {
            const tracks = video.querySelectorAll('track[data-it-patch="true"]');
            let needRefresh = false;
            tracks.forEach(t => { if (!t.track || !t.track.cues || t.track.cues.length === 0) needRefresh = true; });
            if (!needRefresh) {
                const poke = () => {
                    ['loadedmetadata', 'loadeddata', 'canplay', 'play', 'timeupdate', 'seeked']
                        .forEach(ev => video.dispatchEvent(new Event(ev, { bubbles: true })));
                };
                poke(); return;
            }
            tracks.forEach(t => t.remove());
            delete video.dataset.itPatched; delete video.dataset.itVttUrl;
        }

        video.dataset.itVttUrl = vttUrl;
        if (video.crossOrigin !== 'anonymous') video.crossOrigin = 'anonymous';

        GM_xmlhttpRequest({
            method: "GET", url: vttUrl,
            headers: { "Referer": location.origin, "Origin": location.origin },
            onload: function (response) {
                try {
                    if (response.status !== 200) { log(`VTT fetch failed: ${response.status}`); return; }
                    vttContent = response.responseText;

                    // ★ Cache VTT content for postMessage interception
                    vttCache.set(vttUrl, vttContent);
                    log(`VTT cached (${vttContent.length} bytes). Bridge messages using this URL will get data: URI.`);

                    const cues = parseVTT(vttContent);
                    log(`Parsed ${cues.length} VTT cues`);
                    if (cues.length === 0) { log('No cues found!'); return; }

                    startSubtitleEngine(cues);

                    // Inject track elements
                    const langs = [{ id: 'en', label: 'English' }, { id: 'ja', label: 'Japanese' }];
                    langs.forEach((lang, idx) => {
                        const track = document.createElement('track');
                        track.kind = 'subtitles'; track.label = lang.label;
                        track.srclang = lang.id; track.default = (idx === 0);
                        track.setAttribute('data-it-patch', 'true');
                        track.src = toDataUri(vttContent);
                        video.appendChild(track);
                        setTimeout(() => {
                            if (track.track) { track.track.mode = 'hidden'; }
                        }, 500);
                    });

                    // Re-trigger the bridge's fetch/XHR hook via fake XHR to VTT URL.
                    // This causes the bridge to detect the subtitle request and postMessage
                    // the extension. Our postMessage interceptor swaps the URL to data: URI.
                    setTimeout(() => {
                        log('Triggering bridge re-scan via page fetch...');
                        try {
                            // Make the bridge detect this as a subtitle request again
                            const fakeReq = new XMLHttpRequest();
                            fakeReq.open('GET', vttUrl, true);
                            fakeReq.send();
                        } catch (e) { /* ignore */ }
                        // Also dispatch events to trigger extension re-scan
                        ['loadedmetadata', 'loadeddata', 'canplay', 'play', 'durationchange', 'timeupdate', 'seeked']
                            .forEach(ev => video.dispatchEvent(new Event(ev, { bubbles: true })));
                    }, 500);

                    log(`Tracks injected (${cues.length} cues). postMessage interceptor will serve cached VTT to extension.`);
                } catch (e) { log(`Error: ${e.message}`); }
            },
            onerror: () => log('GM_xmlhttpRequest failed')
        });
    }

    // --- 5. Listeners ---
    const setupListeners = () => {
        const video = document.querySelector('video');
        if (!video || video._itListenersSet) return;
        video._itListenersSet = true;
        video.textTracks.addEventListener('addtrack', () => setTimeout(() => {
            ['loadedmetadata', 'loadeddata'].forEach(ev => video.dispatchEvent(new Event(ev, { bubbles: true })));
        }, 800));
        log('Track listeners active.');
    };

    // --- 6. DOM monitor ---
    let domMonitorStarted = false;
    const startDomMonitor = () => {
        if (domMonitorStarted) return;
        const target = document.querySelector('.art-subtitle, .art-subtitles, .jw-captions');
        if (target) {
            new MutationObserver(() => {
                setTimeout(() => { }, 200);
            }).observe(target, { childList: true, subtree: true, characterData: true });
            domMonitorStarted = true;
        }
    };

    // --- 7. Subtitle engine ---
    let subtitleEngine = null, currentCues = [], lastRenderedText = '';

    function startSubtitleEngine(cues) {
        const video = document.querySelector('video');
        if (!video) return;
        const container = document.querySelector('.jw-captions, .art-subtitle, .art-subtitles');
        if (!container) return;
        if (subtitleEngine) clearInterval(subtitleEngine);
        currentCues = cues; lastRenderedText = '';
        log(`Subtitle engine: ${cues.length} cues`);
        subtitleEngine = setInterval(() => {
            const ct = video.currentTime;
            if (ct === undefined) return;
            const active = currentCues.filter(c => c.start <= ct && c.end >= ct);
            const text = active.map(c => c.text).join('\n');
            if (text !== lastRenderedText) {
                container.innerHTML = '';
                active.forEach(c => {
                    const span = document.createElement('span');
                    span.textContent = c.text; span.style.display = 'block';
                    container.appendChild(span);
                });
                lastRenderedText = text;
            }
        }, 250);
    }

    // --- 8. Main loop ---
    setInterval(() => { injectTracks(); setupListeners(); startDomMonitor(); }, 3000);

    // --- 9. Icon visibility fix ---
    setInterval(() => {
        const icon = document.querySelector('.immersive-translate-quick-button-container');
        if (icon) {
            icon.style.setProperty('display', 'inline-flex', 'important');
            icon.style.setProperty('opacity', '1', 'important');
            icon.style.setProperty('visibility', 'visible', 'important');
        }
    }, 5000);
})();