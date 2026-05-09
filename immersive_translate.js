// ==UserScript==
// @name         Megaplay.buzz Ultra-Patch (Anti-Debug & Subtitle)
// @namespace    http://tampermonkey.net/
// @version      3.5
// @description  Intercepts Immersive Translate bridge postMessage to inject cached VTT
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

    // VTT content cache: URL → text content
    const vttCache = new Map();
    // Blob URL → cleanup tracking
    const blobUrls = new Set();
    let vttUrl = null;
    let vttContent = null;

    const log = (msg) => {
        const fullMsg = `[Ultra-Patch] ${msg}`;
        console.log(fullMsg);
    };

    // --- ★ CORE FIX: Intercept bridge postMessage to swap VTT URLs with blob URLs ---
    // Immersive Translate injects a bridge script (imt-subtitles-inject) that hooks fetch/XHR
    // and sends VTT URLs to the extension content script via postMessage.
    // The extension's _fetchSubtitle then fetches the URL — but from the isolated content
    // script world, external URLs fail CORS. We swap the URL for a same-origin blob: URL.
    const _origPostMessage = unsafeWindow.postMessage.bind(unsafeWindow);
    const IM_BRIDGE_EVENT = 'imt-subtitle-inject';

    // Also intercept addEventListener('message') to catch incoming bridge messages
    // that the extension content script might send to trigger fetching
    const _origAddEventListener = unsafeWindow.EventTarget.prototype.addEventListener;
    unsafeWindow.EventTarget.prototype.addEventListener = function (type, listener, options) {
        if (type === 'message') {
            const origListener = listener;
            listener = function (event) {
                try {
                    const msg = event.data;
                    if (msg && typeof msg === 'object' && msg.eventType === IM_BRIDGE_EVENT) {
                        // Check for VTT URLs in bridge messages received by page listeners
                        const checkAndSwap = (obj) => {
                            if (!obj || typeof obj !== 'object') return;
                            for (const key of Object.keys(obj)) {
                                const val = obj[key];
                                if (typeof val === 'string' && val.includes('.vtt') && val.startsWith('http') && vttCache.has(val)) {
                                    const blob = new Blob([vttCache.get(val)], { type: 'text/vtt; charset=utf-8' });
                                    const blobUrl = URL.createObjectURL(blob);
                                    blobUrls.add(blobUrl);
                                    obj[key] = blobUrl;
                                    log(`addEventListener/message: swapped VTT URL → blob`);
                                    return;
                                }
                            }
                        };
                        checkAndSwap(msg.data);
                    }
                } catch (e) { /* silent */ }
                return origListener.call(this, event);
            };
        }
        return _origAddEventListener.call(this, type, listener, options);
    };
    log('Bridge message interceptor active.');

    // --- Safe postMessage hook for OUTGOING bridge messages ---
    // The bridge script uses globalThis.postMessage() to send messages to the
    // extension content script. We intercept only bridge messages and swap VTT URLs.
    // Using shallow clone + known-field-only checks to avoid corrupting messages.
    unsafeWindow.postMessage = function (msg, targetOrigin, transfer) {
        try {
            if (msg && typeof msg === 'object' && msg.eventType === IM_BRIDGE_EVENT) {
                const data = msg.data;
                if (data && data.url && typeof data.url === 'string' &&
                    data.url.includes('.vtt') && data.url.startsWith('http') &&
                    vttCache.has(data.url)) {
                    const blob = new Blob([vttCache.get(data.url)], { type: 'text/vtt; charset=utf-8' });
                    const blobUrl = URL.createObjectURL(blob);
                    // Shallow clone to avoid mutating original
                    msg = { ...msg, data: { ...data, url: blobUrl } };
                    log(`postMessage OUT: swapped VTT URL → blob:${blobUrl.substring(blobUrl.lastIndexOf('/'))}`);
                }
            }
        } catch (e) { /* pass through silently on any error */ }
        return _origPostMessage(msg, targetOrigin || '*', transfer);
    };

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
        const art = unsafeWindow.artplayer || (unsafeWindow.art && unsafeWindow.art.instances && unsafeWindow.art.instances[0]);
        if (art && art.option && art.option.subtitle && art.option.subtitle.url && art.option.subtitle.url.includes('.vtt')) {
            vttUrl = art.option.subtitle.url;
            log(`VTT from ArtPlayer: ${vttUrl}`);
            return;
        }
        const jw = unsafeWindow.jwplayer || window.jwplayer;
        if (typeof jw === 'function') {
            try {
                const inst = jw();
                if (inst && inst.getPlaylist && inst.getPlaylist()[0] && inst.getPlaylist()[0].tracks) {
                    inst.getPlaylist()[0].tracks.forEach(t => { if (t.file && t.file.includes('.vtt')) vttUrl = t.file; });
                    if (vttUrl) { log(`VTT from JW: ${vttUrl}`); return; }
                }
            } catch (e) { }
        }
        if (!vttUrl) {
            for (let key in unsafeWindow) {
                try {
                    const val = unsafeWindow[key];
                    if (typeof val === 'string' && val.includes('.vtt') && val.startsWith('http')) { vttUrl = val; log(`VTT from ${key}: ${vttUrl}`); break; }
                } catch (e) { }
            }
        }
    };

    // --- XHR interceptor: detect VTT URLs ---
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
        if (typeof url === 'string' && url.includes('.vtt')) { vttUrl = url; log(`VTT via XHR: ${vttUrl}`); }
        return origOpen.apply(this, arguments);
    };

    // --- Page fetch interceptor: serve cached VTT to page fetches ---
    if (unsafeWindow.fetch) {
        const _pageOrigFetch = unsafeWindow.fetch.bind(unsafeWindow);
        unsafeWindow.fetch = function (...args) {
            const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
            if (typeof url === 'string' && url.includes('.vtt')) {
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
    const utf8Base64 = (str) => btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (_, p1) => String.fromCharCode(parseInt(p1, 16))));

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
                    log(`VTT cached (${vttContent.length} bytes). postMessage will swap URLs to blob.`);

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
                        track.src = 'data:text/vtt;charset=utf-8;base64,' + utf8Base64(vttContent);
                        video.appendChild(track);
                        setTimeout(() => {
                            if (track.track) { track.track.mode = 'hidden'; }
                        }, 500);
                    });

                    // Re-trigger the bridge's fetch/XHR hook by making a "page fetch" to VTT URL
                    // This will cause the bridge to detect the VTT URL and send postMessage to extension
                    // Our postMessage interceptor will swap the URL to a blob URL
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

    // --- 10. Blob URL cleanup ---
    setInterval(() => {
        blobUrls.forEach(url => {
            try { URL.revokeObjectURL(url); blobUrls.delete(url); } catch (e) { }
        });
    }, 60000);
})();