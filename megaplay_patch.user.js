// ==UserScript==
// @name         Megaplay.buzz Ultra-Patch (Anti-Debug & Subtitle)
// @namespace    http://tampermonkey.net/
// @version      2.4
// @description  Aggressive anti-debug bypass and VTT injection for Immersive Translate
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

        unsafeWindow.IT_PATCH_LOG = [];
        const originalLog = console.log;
        console.log = (...args) => {
            if (args[0] && args[0].toString().includes('[Ultra-Patch]')) unsafeWindow.IT_PATCH_LOG.push(args.join(' '));
            originalLog.apply(console, args);
        };
        console.log('[Ultra-Patch] Anti-debug deployed.');
    };
    silenceDebugger();

    const log = (msg) => {
        const fullMsg = `[Ultra-Patch] ${msg}`;
        console.log(fullMsg);
        if (unsafeWindow.IT_PATCH_LOG) unsafeWindow.IT_PATCH_LOG.push(`${new Date().toLocaleTimeString()} - ${fullMsg}`);
    };

    // --- 2. VTT Scanner ---
    let vttUrl = null;
    let vttContent = null;

    const findVtt = () => {
        // Priority 1: ArtPlayer
        const art = unsafeWindow.artplayer || (unsafeWindow.art && unsafeWindow.art.instances && unsafeWindow.art.instances[0]);
        if (art && art.option && art.option.subtitle && art.option.subtitle.url && art.option.subtitle.url.includes('.vtt')) {
            vttUrl = art.option.subtitle.url;
            log(`VTT from ArtPlayer: ${vttUrl}`);
            return;
        }
        // Priority 2: JWPlayer
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
        // Priority 3: window property scan (only if vttUrl is null — don't overwrite fresh XHR URL)
        if (!vttUrl) {
            for (let key in unsafeWindow) {
                try {
                    const val = unsafeWindow[key];
                    if (typeof val === 'string' && val.includes('.vtt') && val.startsWith('http')) { vttUrl = val; log(`VTT from ${key}: ${vttUrl}`); break; }
                } catch (e) { }
            }
        }
    };

    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
        if (typeof url === 'string' && url.includes('.vtt')) { vttUrl = url; log(`VTT via XHR: ${vttUrl}`); }
        return origOpen.apply(this, arguments);
    };

    // Run findVtt immediately in case the VTT URL was already captured (page loaded faster than interval)
    findVtt();

    // --- 3. Parse VTT and inject cues directly ---
    function parseVTT(text) {
        if (!text) return [];
        const lines = text.replace(/\r\n/g, '\n').split('\n');
        const cues = [];
        let currentStart = null, currentEnd = null, currentText = [];

        for (const line of lines) {
            // Accept both HH:MM:SS.mmm and MM:SS.mmm formats
            const timeMatch = line.match(/^(\d{2}:\d{2}(?::\d{2})?\.\d{3})\s*-->\s*(\d{2}:\d{2}(?::\d{2})?\.\d{3})/);
            if (timeMatch) {
                if (currentStart !== null) {
                    cues.push({ start: timeToSeconds(currentStart), end: timeToSeconds(currentEnd), text: currentText.join('\n') });
                }
                currentStart = timeMatch[1];
                currentEnd = timeMatch[2];
                currentText = [];
            } else if (line.trim() && !line.startsWith('WEBVTT') && !line.startsWith('NOTE') && !line.startsWith('STYLE') && currentStart !== null) {
                currentText.push(line.trim());
            }
        }
        if (currentStart !== null) {
            cues.push({ start: timeToSeconds(currentStart), end: timeToSeconds(currentEnd), text: currentText.join('\n') });
        }
        return cues;
    }

    function timeToSeconds(t) {
        const parts = t.split(':');
        if (parts.length === 3) return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
        if (parts.length === 2) return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
        return parseFloat(parts[0]);
    }

    async function injectTracks() {
        if (!vttUrl) { findVtt(); if (!vttUrl) return; }

        const video = document.querySelector('video');
        if (!video) return;

        if (!video.dataset.itPatched) {
            video.dataset.itPatched = '1';
            video.dataset.immersiveTranslateVideoId = 'anisuge-' + Date.now();
        }

        // Already injected — but check if VTT URL changed (different episode)
        if (video.dataset.itPatched && video.dataset.itVttUrl && video.dataset.itVttUrl !== vttUrl) {
            log(`VTT URL changed (${video.dataset.itVttUrl} → ${vttUrl}), re-injecting`);
            video.querySelectorAll('track[data-it-patch="true"]').forEach(t => t.remove());
            delete video.dataset.itPatched;
        }

        if (video.querySelector('track[data-it-patch="true"]')) {
            const tracks = video.querySelectorAll('track[data-it-patch="true"]');
            let needRefresh = false;
            tracks.forEach(t => {
                if (!t.track || !t.track.cues || t.track.cues.length === 0) needRefresh = true;
            });
            if (!needRefresh) {
                // Still poke to trigger extension detection
                const poke = () => {
                    const events = ['loadedmetadata', 'loadeddata', 'canplay', 'play', 'timeupdate', 'seeked'];
                    events.forEach(ev => video.dispatchEvent(new Event(ev, { bubbles: true })));
                    window.dispatchEvent(new CustomEvent('immersive-translate-re-scan-subtitles', { bubbles: true }));
                };
                poke();
                return;
            }
            // Cues missing or empty — remove old tracks and force re-inject
            tracks.forEach(t => t.remove());
            delete video.dataset.itPatched;
            delete video.dataset.itVttUrl;
        }

        video.dataset.itVttUrl = vttUrl;
        log(`Injecting tracks from: ${vttUrl}`);

        if (video.crossOrigin !== 'anonymous') video.crossOrigin = 'anonymous';

        GM_xmlhttpRequest({
            method: "GET",
            url: vttUrl,
            headers: { "Referer": location.origin, "Origin": location.origin },
            onload: function (response) {
                try {
                    if (response.status !== 200) { log(`VTT fetch failed: ${response.status}`); return; }

                    vttContent = response.responseText;
                    const cues = parseVTT(vttContent);
                    log(`Parsed ${cues.length} VTT cues`);

                    if (cues.length === 0) { log('No cues found in VTT!'); return; }

                    const langs = [
                        { id: 'en', label: 'English' },
                        { id: 'ja', label: 'Japanese' }
                    ];

                    langs.forEach((lang, idx) => {
                        const track = document.createElement('track');
                        track.kind = 'subtitles';
                        track.label = lang.label;
                        track.srclang = lang.id;
                        track.default = (idx === 0);
                        track.setAttribute('data-it-patch', 'true');

                        // KEY FIX: Use data URI instead of blob URL
                        // Data URIs are accessible across JS contexts (unlike blob URLs)
                        // UTF-8 safe base64 encode (btoa fails on non-Latin1 characters)
                        const utf8Base64 = (str) => btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (_, p1) => String.fromCharCode(parseInt(p1, 16))));
                        track.src = 'data:text/vtt;charset=utf-8;base64,' + utf8Base64(vttContent);

                        video.appendChild(track);

                        // Track element needs a moment to process the src
                        setTimeout(() => {
                            if (track.track) {
                                track.track.mode = 'hidden';
                                log(`Track ${lang.id} ready: ${track.track.cues ? track.track.cues.length : 0} cues`);
                            }
                        }, 500);
                    });

                    // Enhanced poking with multiple attempts
                    const poke = () => {
                        const events = ['loadedmetadata', 'loadeddata', 'canplay', 'play', 'durationchange', 'timeupdate', 'seeked'];
                        events.forEach(ev => video.dispatchEvent(new Event(ev, { bubbles: true })));
                        window.dispatchEvent(new CustomEvent('immersive-translate-re-scan-subtitles', { bubbles: true }));
                    };

                    setTimeout(poke, 300);
                    setTimeout(poke, 800);
                    setTimeout(poke, 1500);
                    setTimeout(poke, 3000);

                    log(`Tracks injected with data URI (${cues.length} cues). Extension poked.`);
                } catch (e) { log(`Error: ${e.message}`); }
            },
            onerror: () => log('GM_xmlhttpRequest failed')
        });
    }

    // --- 4. textTracks listener ---
    const setupListeners = () => {
        const video = document.querySelector('video');
        if (!video || video._itListenersSet) return;
        video._itListenersSet = true;

        video.textTracks.addEventListener('addtrack', () => setTimeout(() => {
            const events = ['loadedmetadata', 'loadeddata'];
            events.forEach(ev => video.dispatchEvent(new Event(ev, { bubbles: true })));
            window.dispatchEvent(new CustomEvent('immersive-translate-re-scan-subtitles', { bubbles: true }));
        }, 800));

        video.textTracks.addEventListener('change', () => setTimeout(() => {
            window.dispatchEvent(new CustomEvent('immersive-translate-re-scan-subtitles', { bubbles: true }));
        }, 500));

        log('Track listeners active.');
    };

    // --- 5. DOM monitor (fallback for auto mode) ---
    let domMonitorStarted = false;
    const startDomMonitor = () => {
        if (domMonitorStarted) return;
        const target = document.querySelector('.art-subtitle, .art-subtitles, .jw-captions');
        if (target) {
            new MutationObserver(() => {
                setTimeout(() => window.dispatchEvent(new CustomEvent('immersive-translate-re-scan-subtitles', { bubbles: true })), 200);
            }).observe(target, { childList: true, subtree: true, characterData: true });
            domMonitorStarted = true;
            log('DOM monitor active.');
        }
    };

    // --- 6. Loop ---
    setInterval(() => { injectTracks(); setupListeners(); startDomMonitor(); }, 3000);

    // Fix icon visibility
    setInterval(() => {
        const icon = document.querySelector('.immersive-translate-quick-button-container');
        if (icon) {
            icon.style.setProperty('display', 'inline-flex', 'important');
            icon.style.setProperty('opacity', '1', 'important');
            icon.style.setProperty('visibility', 'visible', 'important');
        }
    }, 5000);
})();