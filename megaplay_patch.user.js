// ==UserScript==
// @name         Megaplay.buzz Ultra-Patch (Anti-Debug & Subtitle)
// @namespace    http://tampermonkey.net/
// @version      2.1
// @description  Aggressive anti-debug bypass and VTT injection for Immersive Translate
// @author       Antigravity
// @match        *://megaplay.buzz/stream/*
// @match        *://1anime.site/megaplay/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @run-at       document-start
// @connect      1oe.lostproject.club
// @connect      *
// ==/UserScript==

(function () {
    'use strict';

    // --- 1. Ultra-Aggressive Anti-Debug ---
    const silenceDebugger = () => {
        const _Function = unsafeWindow.Function;
        const hook = function (...args) {
            const body = args[args.length - 1];
            if (typeof body === 'string' && /debugger/i.test(body)) {
                return function () { };
            }
            return _Function.apply(this, args);
        };
        hook.prototype = _Function.prototype;
        unsafeWindow.Function = hook;

        // Hook constructor on the prototype to catch more cases
        unsafeWindow.Function.prototype.constructor = hook;

        // Disable eval for debugger
        const _eval = unsafeWindow.eval;
        unsafeWindow.eval = function (code) {
            if (typeof code === 'string' && /debugger/i.test(code)) return;
            return _eval.apply(this, arguments);
        };

        // Block setInterval loops
        const _setInterval = unsafeWindow.setInterval;
        unsafeWindow.setInterval = function (fn, delay, ...args) {
            if (typeof fn === 'function' && fn.toString().includes('debugger')) return 0;
            if (typeof fn === 'string' && fn.includes('debugger')) return 0;
            return _setInterval.apply(this, arguments);
        };

        // Block console.clear from hiding logs
        unsafeWindow.console.clear = () => {
            console.log('[Ultra-Patch] Blocked attempt to clear console.');
        };

        unsafeWindow.IT_PATCH_LOG = [];
        const originalLog = console.log;
        console.log = (...args) => {
            if (args[0] && args[0].toString().includes('[Ultra-Patch]')) {
                unsafeWindow.IT_PATCH_LOG.push(args.join(' '));
            }
            originalLog.apply(console, args);
        };

        console.log('[Ultra-Patch] Anti-debug measures deployed.');
    };
    silenceDebugger();

    const log = (msg) => {
        const fullMsg = `[Ultra-Patch] ${msg}`;
        console.log(fullMsg);
        if (unsafeWindow.IT_PATCH_LOG) unsafeWindow.IT_PATCH_LOG.push(`${new Date().toLocaleTimeString()} - ${fullMsg}`);
    };

    // --- 2. Advanced VTT Scanner ---
    let vttUrl = null;
    const findVttInConfig = () => {
        // Method 1: Check Global jwplayer function
        const jw = unsafeWindow.jwplayer || window.jwplayer;
        if (typeof jw === 'function') {
            try {
                const inst = jw();
                if (inst && inst.getPlaylist) {
                    const playlist = inst.getPlaylist();
                    if (playlist && playlist[0] && playlist[0].tracks) {
                        playlist[0].tracks.forEach(track => {
                            if (track.file && track.file.includes('.vtt')) {
                                vttUrl = track.file;
                                log(`Found VTT in JW Playlist: ${vttUrl}`);
                            }
                        });
                    }
                }
            } catch (e) {
                log(`Error scanning JW Player: ${e.message}`);
            }
        }

        // Method 2: Check all window strings as a fallback
        if (!vttUrl) {
            for (let key in unsafeWindow) {
                try {
                    const val = unsafeWindow[key];
                    if (typeof val === 'string' && val.includes('.vtt') && val.startsWith('http')) {
                        vttUrl = val;
                        log(`Found VTT in Global Var [${key}]: ${vttUrl}`);
                    }
                } catch (e) { }
            }
        }
    };

    // Network interception
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
        if (typeof url === 'string' && url.includes('.vtt')) {
            vttUrl = url;
            log(`Found VTT via Network Intercept: ${vttUrl}`);
        }
        return originalOpen.apply(this, arguments);
    };

    async function injectTrack() {
        if (!vttUrl) {
            findVttInConfig();
            if (!vttUrl) return; // Keep waiting
        }

        const video = document.querySelector('video');
        if (!video) {
            // Check for video inside any sub-iframes (rare but possible)
            if (!unsafeWindow._lastVideoCheck || Date.now() - unsafeWindow._lastVideoCheck > 10000) {
                log("Waiting for <video> element to appear...");
                unsafeWindow._lastVideoCheck = Date.now();
            }
            return;
        }

        if (video.querySelector('track[label="IT-Patch"]')) return;

        log(`Attempting to inject track into video (CrossOrigin: ${video.crossOrigin || 'none'})`);

        // Fix CORS if needed
        if (!video.crossOrigin) video.crossOrigin = 'anonymous';

        GM_xmlhttpRequest({
            method: "GET",
            url: vttUrl,
            onload: function (response) {
                try {
                    if (response.status !== 200) {
                        log(`Failed to fetch VTT: HTTP ${response.status}`);
                        return;
                    }

                    const blob = new Blob([response.responseText], { type: 'text/vtt' });
                    const track = document.createElement('track');
                    track.kind = 'subtitles';
                    track.label = 'IT-Patch';
                    track.srclang = 'en';
                    track.src = URL.createObjectURL(blob);
                    track.default = true;

                    // Remove existing ones just in case
                    video.querySelectorAll('track[label="IT-Patch"]').forEach(t => t.remove());

                    video.appendChild(track);
                    log('SUCCESS: Track injected successfully!');

                    // Force browser to recognize the new track
                    track.mode = 'showing';
                    video.textTracks[video.textTracks.length - 1].mode = 'showing';
                } catch (e) {
                    log(`Injection Error: ${e.message}`);
                }
            },
            onerror: function(err) {
                log(`XHR Error fetching VTT: ${err}`);
            }
        });
    }

    setInterval(injectTrack, 2000);
})();

