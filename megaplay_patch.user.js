// ==UserScript==
// @name         Megaplay.buzz Immersive Translate Fix v5.2
// @namespace    http://tampermonkey.net/
// @version      5.2
// @description  GM_webRequest adds Referer+CORS for VTT + safe anti-debug (NO Object.defineProperty hooks)
// @author       Antigravity
// @match        *://anisuge.tv/*
// @match        *://megaplay.buzz/*
// @match        *://1anime.site/*
// @grant        GM_webRequest
// @grant        unsafeWindow
// @run-at       document-start
// @connect      *
// ==/UserScript==

(function () {
    'use strict';

    const log = (msg) => console.log(`[IT-Fix] ${msg}`);

    // ── 0. Safe Anti-Debug (v3.6-style, proven working) ───────────────
    // Only hooks debugger traps. NO Object.defineProperty replacement,
    // NO page-side hooks, NO setTimeout/rAF hooks — all proven to crash
    // Immersive Translate when done aggressively.
    {
        const _Function = unsafeWindow.Function;
        const _eval = unsafeWindow.eval;
        const _setInterval = unsafeWindow.setInterval;

        // Hook Function constructor (blocks new Function("debugger"))
        const hookFn = function (...args) {
            const body = args[args.length - 1];
            if (typeof body === 'string' && /debugger/i.test(body)) return function () { };
            return _Function.apply(this, args);
        };
        hookFn.prototype = _Function.prototype;
        unsafeWindow.Function = hookFn;
        unsafeWindow.Function.prototype.constructor = hookFn;

        // Hook eval
        unsafeWindow.eval = function (code) {
            if (typeof code === 'string' && /debugger/i.test(code)) return;
            return _eval.apply(this, arguments);
        };

        // Hook setInterval (blocks setInterval with debugger in function body)
        unsafeWindow.setInterval = function (fn, delay, ...args) {
            if (typeof fn === 'function' && fn.toString().includes('debugger')) return 0;
            if (typeof fn === 'string' && fn.includes('debugger')) return 0;
            return _setInterval.apply(this, arguments);
        };

        // Lock console.clear (non-configurable prevents page from overriding)
        try {
            Object.defineProperty(unsafeWindow.console, 'clear', {
                value: function () { },
                writable: false,
                configurable: false
            });
        } catch (e) {
            try { unsafeWindow.console.clear = function () { }; } catch (e2) { }
        }
    }
    log('Anti-debug active.');

    // ── ★ CORE FIX: GM_webRequest for Referer + CORS ──────────────────
    try {
        if (typeof GM_webRequest === 'function') {
            GM_webRequest([
                {
                    selector: {
                        url: '*://1oe.lostproject.club/anime/*/*/subtitles/*.vtt*',
                        types: ['xmlhttprequest', 'fetch']
                    },
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
                }
            ], (info) => {
                if (info && info.result === 'success') {
                    log(`webRequest: Referer+CORS → ${(info.url||'').substring(0, 80)}...`);
                }
            });
            log('GM_webRequest registered.');
        } else {
            log('ERROR: GM_webRequest not available. Grant "webRequest" in Tampermonkey settings → this script → Settings.');
        }
    } catch (e) {
        log(`ERROR: ${e.message}`);
    }

    // ── Video metadata for quick button ───────────────────────────────
    setInterval(() => {
        const video = document.querySelector('video');
        if (video && !video.dataset.itFixed) {
            video.dataset.itFixed = '1';
            video.dataset.immersiveTranslateVideoId = 'anisuge-' + Date.now();
            if (video.crossOrigin !== 'anonymous') video.crossOrigin = 'anonymous';
            log('Video metadata set.');
        }
    }, 3000);

    // ── Icon visibility enforcement ───────────────────────────────────
    setInterval(() => {
        const icon = document.querySelector('.immersive-translate-quick-button-container');
        if (icon) {
            icon.style.setProperty('display', 'inline-flex', 'important');
            icon.style.setProperty('opacity', '1', 'important');
            icon.style.setProperty('visibility', 'visible', 'important');
        }
    }, 5000);

    log('v5.2 ready. GM_webRequest must be GRANTED in Tampermonkey settings.');
})();