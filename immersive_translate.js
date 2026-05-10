// ==UserScript==
// @name         Megaplay.buzz Immersive Translate CORS Fix
// @namespace    http://tampermonkey.net/
// @version      5.0
// @description  Fixes Immersive Translate bilingual subtitles on anisuge.tv/megaplay.buzz — uses webRequest to add CORS headers, falls back to proxy
// @author       Antigravity
// @match        *://anisuge.tv/*
// @match        *://megaplay.buzz/*
// @match        *://1anime.site/*
// @grant        GM_webRequest
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @webRequest   {"include":"webRequest","permissions":["webRequestBlocking"]}
// @run-at       document-start
// @connect      1oe.lostproject.club
// @connect      translate.googleapis.com
// @connect      api.allorigins.win
// @connect      corsproxy.io
// @connect      *
// ==/UserScript==

(function () {
    'use strict';

    const log = (msg) => console.log(`[CORS-Fix] ${msg}`);
    let webRequestOk = false;

    // ── 1. webRequest: Add CORS headers to VTT responses ──────────────
    // This intercepts network requests at the browser level and injects
    // Access-Control-Allow-Origin: * into VTT responses. When the Immersive
    // Translate extension's content script fetches the VTT, the browser sees
    // the CORS headers and allows the response to be read.
    //
    // Also handles preflight OPTIONS by adding Allow-Methods and Allow-Headers.

    try {
        if (typeof GM_webRequest === 'function') {
            GM_webRequest([
                {
                    selector: {
                        url: '*://1oe.lostproject.club/anime/*/*/subtitles/*.vtt*',
                        types: ['xmlhttprequest', 'fetch']
                    },
                    action: {
                        responseHeaders: [
                            { header: 'Access-Control-Allow-Origin', operation: 'set', value: '*' },
                            { header: 'Access-Control-Allow-Methods', operation: 'set', value: 'GET, HEAD, OPTIONS' },
                            { header: 'Access-Control-Allow-Headers', operation: 'set', value: '*' },
                            { header: 'Access-Control-Max-Age', operation: 'set', value: '86400' }
                        ]
                    }
                }
            ], (info) => {
                if (info && info.result === 'success') {
                    webRequestOk = true;
                    log(`CORS injected: ${(info.url || '').substring(0, 80)}...`);
                } else if (info && info.result === 'error') {
                    log(`webRequest error: ${info.message || 'unknown'} — falling back to CORS proxy`);
                }
            });
            log('webRequest CORS rules registered.');
        } else {
            log('GM_webRequest not available. Using CORS proxy fallback.');
        }
    } catch (e) {
        log(`webRequest failed: ${e.message}. Using CORS proxy fallback.`);
    }

    // ── 2. Fallback: CORS proxy URL rewriting ─────────────────────────
    // If webRequest doesn't work (GM_webRequest unavailable, permission
    // denied, or browser limitations), we rewrite JW Player's VTT URL to
    // go through a public CORS proxy. This makes the VTT CORS-accessible
    // to the extension's content script.
    //
    // Uses api.allorigins.win/raw which returns the raw content with
    // Access-Control-Allow-Origin: * headers.

    const CORS_PROXY = 'https://api.allorigins.win/raw?url=';

    const proxifyUrl = (url) => CORS_PROXY + encodeURIComponent(url);

    // Periodically check JW Player playlist and rewrite VTT URLs
    const patchPlaylist = () => {
        try {
            const jw = unsafeWindow.jwplayer || window.jwplayer;
            if (typeof jw !== 'function') return;
            const inst = jw();
            if (!inst || !inst.getPlaylist) return;
            const pl = inst.getPlaylist();
            if (!pl || !pl[0] || !pl[0].tracks) return;
            let patched = false;
            pl[0].tracks.forEach(t => {
                if (t.file && t.file.includes('.vtt') && t.file.startsWith('http') && !t.file.includes('allorigins.win') && !t.file.includes('corsproxy.io')) {
                    const proxied = proxifyUrl(t.file);
                    log(`Playlist patch: ${t.file.substring(0, 60)}... → proxy`);
                    t.file = proxied;
                    patched = true;
                }
            });
            if (patched) log('JW Player playlist patched with CORS proxy URLs.');
        } catch (e) { /* silently ignore */ }
    };

    // Try patching on startup and periodically (only if webRequest failed)
    let proxyFallbackActive = false;
    const startProxyFallback = () => {
        if (proxyFallbackActive) return;
        proxyFallbackActive = true;
        log('Activating CORS proxy fallback (playlist URL rewriting)...');
        patchPlaylist();
        setInterval(patchPlaylist, 5000);
    };

    // Start proxy fallback after a delay if webRequest hasn't confirmed
    setTimeout(() => {
        if (!webRequestOk) startProxyFallback();
    }, 8000);

    // ── 3. Anti-Debug ──────────────────────────────────────────────────
    {
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
    }

    // ── 4. Video metadata for extension detection ──────────────────────
    setInterval(() => {
        const video = document.querySelector('video');
        if (video && !video.dataset.corsPatched) {
            video.dataset.corsPatched = '1';
            video.dataset.immersiveTranslateVideoId = 'anisuge-' + Date.now();
            if (video.crossOrigin !== 'anonymous') video.crossOrigin = 'anonymous';
            log('Video metadata set for extension detection.');
        }
    }, 3000);

    // ── 5. Icon visibility ─────────────────────────────────────────────
    setInterval(() => {
        const icon = document.querySelector('.immersive-translate-quick-button-container');
        if (icon) {
            icon.style.setProperty('display', 'inline-flex', 'important');
            icon.style.setProperty('opacity', '1', 'important');
            icon.style.setProperty('visibility', 'visible', 'important');
        }
    }, 5000);

    log('CORS Fix v5.0 ready. Primary: webRequest header injection. Fallback: CORS proxy URL rewrite.');
})();