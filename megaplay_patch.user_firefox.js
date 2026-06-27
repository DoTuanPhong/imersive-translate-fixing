// ==UserScript==
// @name         Megaplay.buzz Immersive Translate Fix v11.6+
// @namespace    http://tampermonkey.net/
// @version      11.6.4
// @description  Pure IT engine fix: fetch override + Referer injection + postMessage interception + shadow-aware translation sync guard + stale-loading & untranslated-cue recovery + iframe relay. Visual Console. No Google fallback.
// @author       Antigravity
// @match        *://anisuge.tv/*
// @match        *://anisuge.se/*
// @match        *://animesuge.re/*
// @match        *://animesuge.cz/*
// @match        *://animesugez.tv/*
// @match        *://megaplay.buzz/*
// @match        *://vidwish.live/*
// @match        *://1anime.site/*
// @match        *://*.mewcdn.online/*
// @match        *://*.mewstream.buzz/*
// @match        *://*.lostproject.club/*
// @match        *://*.watching.onl*
// @match        *://vidtube.site/*
// @match        *://*.vidtube.site/*
// @grant        GM_xmlhttpRequest
// @grant        GM_webRequest
// @grant        unsafeWindow
// @run-at       document-start
// @connect      1oe.lostproject.club
// @connect      watching.onl
// @connect      *.watching.onl
// @connect      mt.nekostream.site
// @connect      *.mt.nekostream.site
// @connect      *
// ==/UserScript==

(function () {
    'use strict';

    const isInIframe = (window !== window.top);
    const frameId = isInIframe ? `IFRAME:${location.hostname}` : 'TOP';
    const ENABLE_TEXTTRACK_MONITOR_DEBUG = false;
    const ENABLE_BRIDGE_DIAGNOSTICS = false;
    const ENABLE_TRANSLATION_SYNC_GUARD = true;
    const TRANSLATION_SYNC_POLL_MS = 80;
    const TRANSLATION_SYNC_PAUSE_DELAY_MS = 80;
    const TRANSLATION_SYNC_RESUME_DELAY_MS = 80;
    const TRANSLATION_SYNC_MAX_PAUSE_MS = 12000;
    const TRANSLATION_SYNC_STALE_LOADING_MS = 2500;
    const TRANSLATION_SYNC_REINJECT_COOLDOWN_MS = 12000;
    const TRANSLATION_SYNC_UNTRANSLATED_MS = 3500;
    const TRANSLATION_SYNC_PERSIST_REINJECT_COOLDOWN_MS = 10000;

    let visualConsoleContainer = null;
    let visualConsoleBody = null;

    const initVisualConsole = () => {
        if (isInIframe || visualConsoleContainer) return;
        if (!document.body) {
            window.addEventListener('DOMContentLoaded', () => initVisualConsole());
            return;
        }

        // Create container
        visualConsoleContainer = document.createElement('div');
        visualConsoleContainer.id = 'it-visual-console';
        visualConsoleContainer.style.cssText = `
            position: fixed;
            bottom: 10px;
            right: 10px;
            width: 380px;
            height: 250px;
            background: rgba(20, 20, 20, 0.85);
            backdrop-filter: blur(8px);
            -webkit-backdrop-filter: blur(8px);
            border: 1px solid rgba(255, 255, 255, 0.15);
            border-radius: 8px;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
            z-index: 2147483647;
            font-family: Consolas, Monaco, monospace;
            font-size: 11px;
            color: #e0e0e0;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            transition: all 0.3s ease;
        `;

        // Create header
        const header = document.createElement('div');
        header.style.cssText = `
            padding: 6px 10px;
            background: rgba(0, 0, 0, 0.4);
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-weight: bold;
            cursor: pointer;
            user-select: none;
        `;
        header.innerHTML = `
            <span style="color: #4caf50;">[IT-Fix] Visual Log Panel v11.6+</span>
            <div>
                <button id="it-btn-clear" style="background:none;border:none;color:#ff9800;cursor:pointer;margin-right:8px;font-size:10px;">Clear</button>
                <span id="it-btn-toggle" style="color:#aaa;">▼</span>
            </div>
        `;

        // Create body (log list)
        visualConsoleBody = document.createElement('div');
        visualConsoleBody.style.cssText = `
            flex: 1;
            padding: 8px;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            gap: 4px;
        `;

        visualConsoleContainer.appendChild(header);
        visualConsoleContainer.appendChild(visualConsoleBody);
        document.body.appendChild(visualConsoleContainer);

        // Toggle expand/collapse
        let collapsed = false;
        const toggle = () => {
            collapsed = !collapsed;
            if (collapsed) {
                visualConsoleContainer.style.height = '30px';
                visualConsoleContainer.style.width = '240px';
                header.querySelector('#it-btn-toggle').textContent = '▲';
                visualConsoleBody.style.display = 'none';
            } else {
                visualConsoleContainer.style.height = '250px';
                visualConsoleContainer.style.width = '380px';
                header.querySelector('#it-btn-toggle').textContent = '▼';
                visualConsoleBody.style.display = 'flex';
                visualConsoleBody.scrollTop = visualConsoleBody.scrollHeight;
            }
        };

        header.addEventListener('click', (e) => {
            if (e.target.id === 'it-btn-clear') {
                visualConsoleBody.innerHTML = '';
                return;
            }
            toggle();
        });
        
        // Add CSS to style scrollbars
        const style = document.createElement('style');
        style.textContent = `
            #it-visual-console ::-webkit-scrollbar { width: 6px; }
            #it-visual-console ::-webkit-scrollbar-track { background: transparent; }
            #it-visual-console ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 3px; }
            #it-visual-console ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.4); }
        `;
        document.head.appendChild(style);
    };

    const appendToVisualConsole = (msg, frameName) => {
        if (isInIframe) return;
        if (!visualConsoleContainer) {
            initVisualConsole();
        }
        if (!visualConsoleBody) return;

        const line = document.createElement('div');
        line.style.cssText = 'line-height: 1.3; border-bottom: 1px solid rgba(255,255,255,0.03); padding-bottom: 2px; word-break: break-all;';
        
        let color = '#fff';
        if (msg.includes('ERROR') || msg.includes('FAILED') || msg.includes('Failed') || msg.includes('error')) color = '#ff5252';
        else if (msg.includes('upgraded') || msg.includes('detected') || msg.includes('OK') || msg.includes('cached') || msg.includes('Active') || msg.includes('ACTIVE') || msg.includes('READY')) color = '#69f0ae';
        else if (msg.includes('Delaying') || msg.includes('Safety timeout') || msg.includes('inactivity') || msg.includes('INACTIVE') || msg.includes('Resetting')) color = '#ffd740';

        const prefix = frameName === 'TOP' ? '<span style="color:#00e5ff;">[TOP]</span>' : `<span style="color:#ff4081;">[${frameName}]</span>`;
        line.innerHTML = `${prefix} <span style="color: ${color};">${msg}</span>`;
        visualConsoleBody.appendChild(line);

        while (visualConsoleBody.children.length > 40) {
            visualConsoleBody.removeChild(visualConsoleBody.firstChild);
        }
        visualConsoleBody.scrollTop = visualConsoleBody.scrollHeight;
    };

    const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const _realConsoleLog = win.console ? win.console.log : null;

    const log = (msg) => {
        if (_realConsoleLog) {
            try {
                _realConsoleLog.call(win.console, `[IT-Fix][${frameId}] ${msg}`);
            } catch (e) { }
        }
        if (isInIframe) {
            try {
                window.parent.postMessage({ type: 'it-fix-log', frameId, msg }, '*');
            } catch (e) { }
        } else {
            try {
                appendToVisualConsole(msg, 'TOP');
            } catch (e) { }
        }
    };
    const isFirefox = navigator.userAgent.toLowerCase().includes('firefox');

    log(`Script loaded. URL: ${location.href.substring(0, 120)}`);

    // ── 0. Enhanced Anti-Debug (Chromium-optimized) ─────────────────
    // Chromium's V8 allows redefining Function.prototype.toString
    // to hide our hooks from detection by anti-debug scripts.
    {
        const _origFunction = win.Function;
        const _origEval = win.eval;
        const _origSetInterval = win.setInterval;
        const _origSetTimeout = win.setTimeout;
        const _origRAF = win.requestAnimationFrame;

        const mockedFunctions = new Set();

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
        mockedFunctions.add(safeFnFactory);
        mockedFunctions.add(win.Function);

        // Hook eval — blocks direct eval("debugger")
        if (!isFirefox) {
            const wrappedEval = function (code) {
                if (typeof code === 'string' && /\bdebugger\b/i.test(code)) return undefined;
                return _origEval.apply(this, arguments);
            };
            win.eval = wrappedEval;
            mockedFunctions.add(wrappedEval);
        }

        // Hook setInterval — blocks setInterval("debugger", ...)
        const wrappedSetInterval = function (fn, delay, ...args) {
            if (typeof fn === 'function' && fn.toString().includes('debugger')) return 0;
            if (typeof fn === 'string' && /\bdebugger\b/i.test(fn)) return 0;
            return _origSetInterval.apply(this, arguments);
        };
        win.setInterval = wrappedSetInterval;
        mockedFunctions.add(wrappedSetInterval);

        // Hook setTimeout — blocks setTimeout("debugger", ...)
        const wrappedSetTimeout = function (fn, delay, ...args) {
            if (typeof fn === 'function' && fn.toString().includes('debugger')) return 0;
            if (typeof fn === 'string' && /\bdebugger\b/i.test(fn)) return 0;
            return _origSetTimeout.apply(this, arguments);
        };
        win.setTimeout = wrappedSetTimeout;
        mockedFunctions.add(wrappedSetTimeout);

        // Hook requestAnimationFrame — blocks RAF-based debugger loops
        const wrappedRAF = function (fn) {
            if (typeof fn === 'function') {
                const str = fn.toString();
                if (str.includes('debugger')) return 0;
                if (/\b(?:Function|constructor)\b/.test(str) && /\bdebugger\b/.test(str)) return 0;
            }
            return _origRAF.call(this, fn);
        };
        win.requestAnimationFrame = wrappedRAF;
        mockedFunctions.add(wrappedRAF);

        // --- Mock window.close inside player iframe to prevent self-destruction loops ---
        if (isInIframe) {
            const noopClose = function () {
                log('window.close() call blocked');
            };
            mockedFunctions.add(noopClose);
            try {
                Object.defineProperty(win, 'close', {
                    value: noopClose,
                    writable: true,
                    configurable: true
                });
            } catch (e) {
                win.close = noopClose;
            }
        }

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
        const consoleMethods = [
            'log', 'warn', 'error', 'info', 'dir', 'table', 'trace', 
            'group', 'groupCollapsed', 'groupEnd', 'clear', 'assert', 
            'count', 'countReset', 'time', 'timeEnd', 'timeLog', 
            'timeStamp', 'profile', 'profileEnd'
        ];
        
        if (isInIframe && win.console) {
            // Inside player iframe: Neutralize all console calls completely to block timing/formatting detectors
            for (const method of consoleMethods) {
                if (typeof win.console[method] === 'function') {
                    const noop = function () { };
                    mockedFunctions.add(noop);
                    try {
                        Object.defineProperty(win.console, method, {
                            value: noop,
                            writable: true,
                            configurable: true
                        });
                    } catch (e) {
                        win.console[method] = noop;
                    }
                }
            }
        } else if (win.console) {
            // On top-level page: Sanitization mode so elements/getters are safely logged without triggers
            const _origConsole = {};
            for (const method of consoleMethods) {
                if (typeof win.console[method] === 'function') {
                    _origConsole[method] = win.console[method];
                    const sanitizedConsoleMethod = function (...args) {
                        const sanitizedArgs = args.map(arg => {
                            if (arg === null || arg === undefined) return arg;
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
                    mockedFunctions.add(sanitizedConsoleMethod);
                    try {
                        Object.defineProperty(win.console, method, {
                            value: sanitizedConsoleMethod,
                            writable: true,
                            configurable: true
                        });
                    } catch (e) {
                        win.console[method] = sanitizedConsoleMethod;
                    }
                }
            }
        }

        // --- Mask toString to hide all our hooks ---
        const _origToString = Function.prototype.toString;
        const NATIVE_STR = 'function () { [native code] }';
        Function.prototype.toString = function () {
            if (mockedFunctions.has(this)) {
                return NATIVE_STR;
            }
            return _origToString.apply(this, arguments);
        };
        mockedFunctions.add(Function.prototype.toString);

        // --- Block console.clear completely to preserve debugging trace ---
        if (win.console) {
            try {
                Object.defineProperty(win.console, 'clear', {
                    value: function () { },
                    writable: false,
                    configurable: false
                });
            } catch (e) {
                try { win.console.clear = function () { }; } catch (e2) { }
            }
        }

        // --- Block devtools detection via stack trace elements ---
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

        // --- Intercept SandboxDetector assignment to disable pointer lock checks ---
        let _sandboxDetector = null;
        try {
            Object.defineProperty(win, 'SandboxDetector', {
                get() {
                    return _sandboxDetector;
                },
                set(val) {
                    if (val && typeof val === 'object') {
                        val.detect = async () => false;
                        val.run = async (opts) => {
                            if (opts && opts.onAllowed) {
                                try { opts.onAllowed(); } catch(e) {}
                            }
                            if (opts && opts.onResult) {
                                try { opts.onResult(false); } catch(e) {}
                            }
                            return false;
                        };
                    }
                    _sandboxDetector = val;
                },
                configurable: true
            });
        } catch (e) {
            log(`Failed to define SandboxDetector property: ${e.message}`);
        }
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
    } catch (e) {
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
            GM_webRequest([
                {
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
                },
                {
                    selector: { url: '*://*.watching.onl/*.vtt*', types: ['xmlhttprequest', 'fetch'] },
                    action: {
                        requestHeaders: [
                            { header: 'Referer', operation: 'set', value: 'https://vidwish.live/' },
                            { header: 'Origin', operation: 'set', value: 'https://vidwish.live' }
                        ],
                        responseHeaders: [
                            { header: 'Access-Control-Allow-Origin', operation: 'set', value: '*' },
                            { header: 'Access-Control-Allow-Methods', operation: 'set', value: 'GET, HEAD, OPTIONS' },
                            { header: 'Access-Control-Allow-Headers', operation: 'set', value: '*' }
                        ]
                    }
                },
                {
                    selector: { url: '*://mt.nekostream.site/*/subtitles/*.vtt*', types: ['xmlhttprequest', 'fetch'] },
                    action: {
                        requestHeaders: [
                            { header: 'Referer', operation: 'set', value: 'https://vidtube.site/' },
                            { header: 'Origin', operation: 'set', value: 'https://vidtube.site' }
                        ],
                        responseHeaders: [
                            { header: 'Access-Control-Allow-Origin', operation: 'set', value: '*' },
                            { header: 'Access-Control-Allow-Methods', operation: 'set', value: 'GET, HEAD, OPTIONS' },
                            { header: 'Access-Control-Allow-Headers', operation: 'set', value: '*' }
                        ]
                    }
                }
            ], (info) => { if (info?.result === 'success') log(`webRequest OK: ${(info.url || '').substring(0, 80)}`); });
            log('GM_webRequest registered.');
        }
    } catch (e) { log(`GM_webRequest: ${e.message}`); }

    // ── 2. State ──────────────────────────────────────────────────────
    let vttUrl = null;
    let vttUrlIsEnglish = false;
    let vttText = null;
    let cues = [];
    let translatedCues = [];
    let renderInterval = null;
    let itTranslationDetected = false;
    let textTrackMonitorInterval = null;
    let translationSyncInterval = null;
    let translationSyncResumeTimer = null;
    let translationSyncLoadingSince = 0;
    let translationSyncPausedSince = 0;
    let translationSyncPausedVideo = null;
    let translationSyncLoadingKey = '';
    let translationSyncLastRecoveryAt = 0;
    let translationSyncUntranslatedSince = 0;
    let _bridgeLastSummary = '';
    let _bridgeMsgTypes = {};
    let _bridgeBlockedCount = 0;
    let _bridgeLastCount = 0;
    const vttCache = new Map();
 
    let itHookReady = false;
    let itHookResolve = null;
    let itHookPromise = new Promise(resolve => {
        itHookResolve = resolve;
    });

    let vttBootWatcherInterval = null;

    const resetItHookGate = () => {
        itHookReady = false;
        itHookPromise = new Promise(resolve => {
            itHookResolve = resolve;
        });
        log('IT hook gate reset for new episode.');
    };

    const startVttBootWatcher = () => {
        if (vttBootWatcherInterval) clearInterval(vttBootWatcherInterval);
        vttBootWatcherInterval = setInterval(() => {
            findVtt();
            // Also aggressively poll JWPlayer for English VTT
            if (!vttUrl || !vttUrlIsEnglish) {
                const eng = getJwplayerEnglishVtt();
                if (eng) {
                    updateVttUrl(eng, 'boot watcher jwplayer poll', true);
                }
            }
            if (vttUrl && !vttText && !fetchInProgress) {
                fetchAndCacheVtt();
            }
            if (vttText && cues.length > 0) {
                clearInterval(vttBootWatcherInterval);
                vttBootWatcherInterval = null;
                log('Boot watcher completed: VTT cached with cues.');
            }
        }, 1000);
    };

    const resetStateForNewVideo = (reason) => {
        log(`Resetting state for new video. Reason: ${reason}`);
        vttUrl = null;
        vttUrlIsEnglish = false;
        vttText = null;
        cues = [];
        translatedCues = [];
        itTranslationDetected = false;
        fetchInProgress = false;
        vttCache.clear();
        if (overlayContainer) {
            try {
                overlayContainer.remove();
            } catch (e) {}
            overlayContainer = null;
        }
        // Remove injected <track> elements from previous video
        try {
            const oldVideo = document.querySelector('video');
            if (oldVideo) {
                const removedCount = removeInjectedTracks(oldVideo);
                if (removedCount > 0) log(`Removed ${removedCount} injected track(s).`);
            }
        } catch (e) {}
        currentDisplay = { en: '', vi: '' };
        translationSyncLoadingSince = 0;
        translationSyncPausedSince = 0;
        translationSyncPausedVideo = null;
        translationSyncLoadingKey = '';
        translationSyncLastRecoveryAt = 0;
        translationSyncUntranslatedSince = 0;
        if (translationSyncResumeTimer) {
            clearTimeout(translationSyncResumeTimer);
            translationSyncResumeTimer = null;
        }
        resetItHookGate();
        startITTranslationMonitor();
        startVttBootWatcher();
    };

    const shouldResetForVttUrl = (newUrl) => {
        if (!vttUrl) return false;
        const normNew = normalizeUrl(newUrl);
        const normCurrent = normalizeUrl(vttUrl);
        if (normNew === normCurrent) return false;
        try {
            const uNew = new URL(normNew);
            const uCur = new URL(normCurrent);
            if (uNew.pathname !== uCur.pathname) return true;
        } catch (e) {
            return true;
        }
        return false;
    };

    const waitForItHook = () => {
        return Promise.race([
            itHookPromise,
            new Promise(resolve => setTimeout(resolve, 3000))
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

    // ── 2.2 Hook XMLHttpRequest.prototype (for write/override protection) ──
    const hookXhrPrototype = () => {
        const props = ['status', 'statusText', 'readyState', 'response', 'responseText', 'responseURL'];
        for (const prop of props) {
            try {
                const origDesc = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, prop);
                Object.defineProperty(XMLHttpRequest.prototype, prop, {
                    get() {
                        const customKey = `_custom_${prop}`;
                        if (Object.prototype.hasOwnProperty.call(this, customKey)) {
                            return this[customKey];
                        }
                        return origDesc && origDesc.get ? origDesc.get.call(this) : undefined;
                    },
                    set(val) {
                        const customKey = `_custom_${prop}`;
                        this[customKey] = val;
                    },
                    configurable: true,
                    enumerable: true
                });
            } catch (e) {
                log(`Failed to hook XMLHttpRequest.prototype.${prop}: ${e.message}`);
            }
        }
    };
    hookXhrPrototype();

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
                if (typeof newFetch === 'function' && newFetch !== ourFetchWrapper) {
                    log(`Detected IT overriding window.fetch — wrapping with VTT bypass`);
                    triggerItHookReady();
                    // Wrap IT's fetch hook: serve cached VTT directly so IT's
                    // translateSubtitleWithFetch never sends requestSubtitle
                    const itFetch = newFetch;
                    currentFetch = function (input, init) {
                        let url = typeof input === 'string' ? input : (input && (input.url || input.href)) || '';
                        if (url && typeof url === 'string' && url.includes('.vtt') && VTT_FETCH_REGEX.test(String(url))) {
                            const normUrl = normalizeUrl(String(url));
                            const cachedContent = (vttText && normUrl === vttUrl) ? vttText : vttCache.get(normUrl);
                            if (cachedContent) {
                                log('Wrapped fetch: Serving cached VTT (bypasses IT hooks)');
                                return Promise.resolve(new Response(cachedContent, {
                                    status: 200, statusText: 'OK',
                                    headers: { 'Content-Type': 'text/vtt; charset=utf-8' }
                                }));
                            }
                        }
                        return itFetch.call(this, input, init);
                    };
                } else {
                    currentFetch = newFetch;
                }
            },
            configurable: true
        });
    } catch (e) {
        log(`Failed to hook window.fetch: ${e.message}`);
    }

    // ── 3. Utilities ──────────────────────────────────────────────────
    const isEnglishVtt = (url) => {
        if (!url || typeof url !== 'string') return false;
        const u = url.toLowerCase();
        return u.includes('english') ||
            u.includes('/en/') ||
            u.includes('/eng/') ||
            u.includes('-en') ||
            u.includes('_en') ||
            u.includes('/en.vtt') ||
            u.includes('_en.vtt') ||
            u.includes('/eng.vtt') ||
            u.includes('_eng.vtt') ||
            /\beng?[-_0-9]/.test(u) ||
            /\ben[-_0-9]/.test(u) ||
            /\/eng?[-_0-9]/.test(u) ||
            /\/en[-_0-9]/.test(u);
    };

    const getJwplayerEnglishVtt = () => {
        try {
            const jw = unsafeWindow.jwplayer || window.jwplayer;
            if (typeof jw === 'function') {
                const inst = jw();
                if (inst && inst.getPlaylist && inst.getPlaylist()[0] && inst.getPlaylist()[0].tracks) {
                    const tracks = inst.getPlaylist()[0].tracks.filter(t => t.file && t.file.includes('.vtt'));
                    const eng = tracks.find(t => {
                        const label = String(t.label || '').toLowerCase();
                        const file = String(t.file || '').toLowerCase();
                        return /\b(en|eng|english)\b/i.test(label) || file.includes('/en.vtt') || file.includes('_en.vtt') || file.includes('/eng.vtt') || file.includes('-en') || file.includes('_en') || /\beng?[-_0-9]/.test(file) || /\/eng?[-_0-9]/.test(file);
                    });
                    if (eng) return eng.file;
                }
            }
        } catch (e) { }
        return null;
    };

    // ── 3.2 Hook jwplayer to prioritize English subtitles ───────────────
    try {
        const hookJwplayerInstance = (origJw) => {
            if (typeof origJw !== 'function') return origJw;
            log('Hooking jwplayer function.');
            const hookJw = function (...args) {
                const inst = origJw.apply(this, args);
                if (inst && typeof inst.setup === 'function' && !inst._setupHooked) {
                    inst._setupHooked = true;
 
                    // Listen for playlistItem to reset state on new video load
                    try {
                        inst.on('playlistItem', (event) => {
                            log(`jwplayer playlistItem: new item loaded.`);
                            resetStateForNewVideo('jwplayer playlistItem');
                        });
                    } catch (e) {
                        log(`Error adding playlistItem listener: ${e.message}`);
                    }

                    const origSetup = inst.setup;
                    inst.setup = function (options, ...sArgs) {
                        try {
                            log('jwplayer setup options intercepted.');
                            let tracks = null;
                            if (options) {
                                if (options.playlist && options.playlist[0] && options.playlist[0].tracks) {
                                    tracks = options.playlist[0].tracks;
                                } else if (options.tracks) {
                                    tracks = options.tracks;
                                }
                            }
                            if (tracks) {
                                const engTrackIndex = tracks.findIndex(t => {
                                    const label = String(t.label || '').toLowerCase();
                                    const file = String(t.file || '').toLowerCase();
                                    return /\b(en|eng|english)\b/i.test(label) || file.includes('/en.vtt') || file.includes('_en.vtt') || file.includes('/eng.vtt') || file.includes('-en') || file.includes('_en') || /\beng?[-_0-9]/.test(file) || /\/eng?[-_0-9]/.test(file);
                                });
                                if (engTrackIndex !== -1) {
                                    const engTrack = tracks[engTrackIndex];
                                    log(`jwplayer hook setup: Found English VTT at index ${engTrackIndex}: ${engTrack.file}. Setting default=true.`);
                                    tracks.forEach((t, idx) => {
                                        if (idx === engTrackIndex) {
                                            t.default = true;
                                        } else if (t.file && t.file.includes('.vtt')) {
                                            t.default = false;
                                            delete t.default;
                                        }
                                    });
                                    updateVttUrl(engTrack.file, 'jwplayer hook setup', true);
                                }
                                // Remove VTT subtitle tracks from config to prevent JWPlayer from
                                // fetching them via XHR/fetch. IT's inject.js hooks intercept these
                                // requests and send requestSubtitle to the content-script, which
                                // can't fetch the VTT (missing Referer) and hangs for 30 seconds.
                                // On Firefox, stopImmediatePropagation() cannot cross compartment
                                // boundaries, so we must prevent the fetch entirely.
                                const vttSubTracks = tracks.filter(t =>
                                    t.file && t.file.includes('.vtt') &&
                                    (!t.kind || t.kind === 'subtitles' || t.kind === 'captions')
                                );
                                if (vttSubTracks.length > 0) {
                                    const nonVttTracks = tracks.filter(t =>
                                        !t.file || !t.file.includes('.vtt') ||
                                        (t.kind && t.kind !== 'subtitles' && t.kind !== 'captions')
                                    );
                                    if (options.playlist && options.playlist[0] && options.playlist[0].tracks) {
                                        options.playlist[0].tracks = nonVttTracks;
                                    } else if (options.tracks) {
                                        options.tracks = nonVttTracks;
                                    }
                                    log(`Removed ${vttSubTracks.length} VTT subtitle track(s) from setup config.`);
                                }
                            }
                        } catch (e) {
                            log(`Error in jwplayer setup hook: ${e.message}`);
                        }

                        const result = origSetup.apply(this, [options, ...sArgs]);

                        // Force selecting English captions track on player ready
                        try {
                            inst.on('ready', () => {
                                log('jwplayer ready event.');
                                const captions = inst.getCaptionsList ? inst.getCaptionsList() : [];
                                log('jwplayer captions list: ' + JSON.stringify(captions));
                                const engIdx = captions.findIndex(c => {
                                    const label = String(c.label || '').toLowerCase();
                                    const id = String(c.id || '').toLowerCase();
                                    return /\b(en|eng|english)\b/i.test(label) || /\b(en|eng|english)\b/i.test(id);
                                });
                                if (engIdx !== -1) {
                                    log(`jwplayer ready: Setting captions to English (index ${engIdx})`);
                                    inst.setCurrentCaptions(engIdx);
                                }
                            });
                        } catch (e) {
                            log(`Error setting up jwplayer ready listener: ${e.message}`);
                        }

                        return result;
                    };

                    const origLoad = inst.load;
                    inst.load = function (playlist, ...lArgs) {
                        try {
                            log('jwplayer load playlist intercepted.');
                            let tracks = null;
                            if (Array.isArray(playlist) && playlist[0] && playlist[0].tracks) {
                                tracks = playlist[0].tracks;
                            } else if (playlist && typeof playlist === 'object') {
                                if (playlist.tracks) tracks = playlist.tracks;
                                else if (playlist.playlist && playlist.playlist[0] && playlist.playlist[0].tracks) {
                                    tracks = playlist.playlist[0].tracks;
                                }
                            }
                            if (tracks) {
                                const engTrackIndex = tracks.findIndex(t => {
                                    const label = String(t.label || '').toLowerCase();
                                    const file = String(t.file || '').toLowerCase();
                                    return /\b(en|eng|english)\b/i.test(label) || file.includes('/en.vtt') || file.includes('_en.vtt') || file.includes('/eng.vtt') || file.includes('-en') || file.includes('_en') || /\beng?[-_0-9]/.test(file) || /\/eng?[-_0-9]/.test(file);
                                });
                                if (engTrackIndex !== -1) {
                                    const engTrack = tracks[engTrackIndex];
                                    log(`jwplayer hook load: Found English VTT at index ${engTrackIndex}: ${engTrack.file}. Setting default=true.`);
                                    tracks.forEach((t, idx) => {
                                        if (idx === engTrackIndex) {
                                            t.default = true;
                                        } else if (t.file && t.file.includes('.vtt')) {
                                            t.default = false;
                                            delete t.default;
                                        }
                                    });
                                    updateVttUrl(engTrack.file, 'jwplayer hook load', true);
                                }
                                // Remove VTT subtitle tracks (same rationale as setup hook)
                                const vttSubTracksLoad = tracks.filter(t =>
                                    t.file && t.file.includes('.vtt') &&
                                    (!t.kind || t.kind === 'subtitles' || t.kind === 'captions')
                                );
                                if (vttSubTracksLoad.length > 0) {
                                    const nonVttTracksLoad = tracks.filter(t =>
                                        !t.file || !t.file.includes('.vtt') ||
                                        (t.kind && t.kind !== 'subtitles' && t.kind !== 'captions')
                                    );
                                    if (Array.isArray(playlist) && playlist[0] && playlist[0].tracks) {
                                        playlist[0].tracks = nonVttTracksLoad;
                                    } else if (playlist && typeof playlist === 'object') {
                                        if (playlist.tracks) playlist.tracks = nonVttTracksLoad;
                                        else if (playlist.playlist && playlist.playlist[0] && playlist.playlist[0].tracks) {
                                            playlist.playlist[0].tracks = nonVttTracksLoad;
                                        }
                                    }
                                    log(`Removed ${vttSubTracksLoad.length} VTT subtitle track(s) from load config.`);
                                }
                            }
                        } catch (e) {
                            log(`Error in jwplayer load hook: ${e.message}`);
                        }
                        return origLoad.apply(this, [playlist, ...lArgs]);
                    };
                }
                return inst;
            };
            Object.assign(hookJw, origJw);
            hookJw.prototype = origJw.prototype;
            return hookJw;
        };

        let currentJw = unsafeWindow.jwplayer || window.jwplayer;
        if (currentJw) {
            currentJw = hookJwplayerInstance(currentJw);
            unsafeWindow.jwplayer = currentJw;
        }
        Object.defineProperty(unsafeWindow, 'jwplayer', {
            get() {
                return currentJw;
            },
            set(val) {
                currentJw = hookJwplayerInstance(val);
            },
            configurable: true
        });
    } catch (e) {
        log(`Failed to hook jwplayer: ${e.message}`);
    }

    const updateVttUrl = (url, source, isKnownEnglish = false) => {
        const norm = normalizeUrl(url);
        if (!norm) return;
 
        if (shouldResetForVttUrl(norm)) {
            resetStateForNewVideo(`New VTT URL detected via ${source}: ${norm}`);
        }
 
        const isEng = isKnownEnglish || isEnglishVtt(norm);
 
        if (!vttUrl) {
            vttUrl = norm;
            vttUrlIsEnglish = isEng;
            log(`VTT detected via ${source}: ${vttUrl} (isEnglish: ${vttUrlIsEnglish})`);
            if (vttUrlIsEnglish && !vttText && !fetchInProgress) {
                setTimeout(() => fetchAndCacheVtt(), 0);
            }
        } else if (isEng && !vttUrlIsEnglish) {
            vttUrl = norm;
            vttUrlIsEnglish = true;
            log(`VTT upgraded to English via ${source}: ${vttUrl}`);

            // Reset fetchInProgress and vttText so we refetch the English VTT!
            vttText = null;
            cues = [];
            setTimeout(() => {
                fetchAndCacheVtt();
            }, 100);
        }
    };

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

    const removeInjectedTracks = (video) => {
        if (!video) return 0;
        const injected = [...video.querySelectorAll('track[data-it-fix-injected="1"]')];
        injected.forEach(track => {
            try {
                track.remove();
            } catch (e) {}
        });
        return injected.length;
    };

    const injectVttTrack = (video, text, options = {}) => {
        if (!video || !text) return false;
        const { replace = false, reason = 'inject' } = options;

        try {
            if (replace) {
                removeInjectedTracks(video);
            } else {
                const hasOurTrack = [...video.querySelectorAll('track[src]')].some(track =>
                    track.dataset.itFixInjected === '1' || (track.src || '').startsWith('data:text/vtt;charset=utf-8;base64,')
                );
                if (hasOurTrack) return false;
            }

            const vttWithNonce = `${text.trimEnd()}\n\nNOTE it-fix ${reason} ${Date.now()}`;
            const dataUri = toDataUri(vttWithNonce);
            const newTrack = document.createElement('track');
            newTrack.kind = 'subtitles';
            newTrack.label = 'English (IT-Fix)';
            newTrack.srclang = 'en';
            newTrack.default = true;
            newTrack.src = dataUri;
            newTrack.dataset.itFixInjected = '1';
            video.appendChild(newTrack);
            log(`Injected <track> with VTT data:URI (${(dataUri.length / 1024).toFixed(0)}KB, reason=${reason}).`);
            return true;
        } catch (e) {
            log(`Track injection error: ${e.message}`);
            return false;
        }
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

    const getCueAtTime = (timeSec) => {
        if (!Number.isFinite(timeSec) || !Array.isArray(cues) || cues.length === 0) return null;
        for (const cue of cues) {
            if (timeSec >= cue.start && timeSec <= cue.end) return cue;
        }
        return null;
    };

    const toSec = (t) => {
        const p = t.split(':');
        if (p.length === 3) return parseFloat(p[0]) * 3600 + parseFloat(p[1]) * 60 + parseFloat(p[2]);
        if (p.length === 2) return parseFloat(p[0]) * 60 + parseFloat(p[1]);
        return parseFloat(p[0]);
    };

    // ── 3.5 Early window.fetch Override ───────────────────────────────
    // Intercepts VTT fetches to inject Referer/Origin headers via GM_xmlhttpRequest
    const VTT_FETCH_REGEX = /(?:lostproject\.club|watching\.onl|mt\.nekostream\.site)\/.+\.vtt/i;
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

        let urlStr = String(url);

        // Dynamically query jwplayer for English VTT if we don't have it yet
        if (!vttUrl || !vttUrlIsEnglish) {
            const eng = getJwplayerEnglishVtt();
            if (eng) {
                updateVttUrl(eng, 'dynamic jwplayer check (fetch)', true);
            }
        }

        // Discover VTT URLs
        if (urlStr.includes('.vtt')) {
            updateVttUrl(urlStr, 'page fetch');
            // Redirect non-English VTT to English VTT (compare path only)
            if (vttUrl && vttUrlIsEnglish && !isEnglishVtt(urlStr)) {
                const targetPath = vttUrl.split('?')[0];
                const sourcePath = urlStr.split('?')[0];
                if (targetPath !== sourcePath) {
                    log(`Fetch redirect: non-English VTT → English VTT`);
                    log(`  from: ${urlStr.substring(0, 100)}`);
                    log(`  to:   ${vttUrl.substring(0, 100)}`);
                    if (typeof input === 'string') {
                        input = vttUrl;
                    }
                    url = vttUrl;
                    urlStr = vttUrl;
                }
            }
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
                        'Referer': location.origin + '/',
                        'Origin': location.origin
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
                        const tracks = inst.getPlaylist()[0].tracks.filter(t => t.file && t.file.includes('.vtt'));
                        if (tracks.length > 0) {
                            // Prioritize English track
                            let selectedTrack = tracks.find(t => {
                                const label = String(t.label || '').toLowerCase();
                                const file = String(t.file || '').toLowerCase();
                                return label.includes('english') || label.includes('eng') || file.includes('/en.vtt') || file.includes('_en.vtt') || file.includes('/eng.vtt') || file.includes('-en') || file.includes('_en');
                            });
                            // If no English track, look for default track
                            if (!selectedTrack) {
                                selectedTrack = tracks.find(t => t.default);
                            }
                            // Fallback to the first track
                            if (!selectedTrack) {
                                selectedTrack = tracks[0];
                            }
                            raw = selectedTrack.file;
                            log(`VTT from JW: ${raw} (label: ${selectedTrack.label || 'none'})`);
                        }
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
        if (raw) updateVttUrl(raw, 'findVtt');
    };

    // XHR interceptor: detect VTT URLs and proxy them via GM_xmlhttpRequest
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;

    ourXhrOpen = function (method, url, ...args) {
        this._url = url;
        this._method = method;

        // Dynamically query jwplayer for English VTT if we don't have it yet
        if (!vttUrl || !vttUrlIsEnglish) {
            const eng = getJwplayerEnglishVtt();
            if (eng) {
                updateVttUrl(eng, 'dynamic jwplayer check (XHR open)', true);
            }
        }

        if (typeof url === 'string' && url.includes('.vtt')) {
            updateVttUrl(url, 'XHR open');
            // Redirect non-English VTT to English VTT (compare path only, ignore query string)
            if (vttUrl && vttUrlIsEnglish && !isEnglishVtt(url)) {
                const targetPath = vttUrl.split('?')[0];
                const sourcePath = url.split('?')[0];
                if (targetPath !== sourcePath) {
                    log(`XHR open: Redirecting non-English VTT → English VTT`);
                    log(`  from: ${url.substring(0, 100)}`);
                    log(`  to:   ${vttUrl.substring(0, 100)}`);
                    this._url = vttUrl;
                    url = vttUrl;
                }
            }
        }

        // If VTT is cached, replace URL with blob: URL so IT's XHR hooks
        // (which run on the prototype AFTER our hook) see a non-matching URL
        // and skip requestSubtitle (preventing the 30-second timeout).
        const urlToCheck = this._url || url;
        if (typeof urlToCheck === 'string' && urlToCheck.includes('.vtt') && VTT_FETCH_REGEX.test(urlToCheck)) {
            const normUrl = normalizeUrl(urlToCheck);
            const cachedContent = (vttText && normUrl === vttUrl) ? vttText : vttCache.get(normUrl);
            if (cachedContent) {
                this._realVttUrl = urlToCheck;
                const blob = new Blob([cachedContent], { type: 'text/vtt; charset=utf-8' });
                const blobUrl = URL.createObjectURL(blob);
                this._url = blobUrl;
                log(`XHR open: VTT → blob: URL (bypasses IT hooks)`);
                return origOpen.apply(this, [method, blobUrl, ...args]);
            }
        }

        return origOpen.apply(this, [method, url, ...args]);
    };
    XMLHttpRequest.prototype.open = ourXhrOpen;

    // Helper: safely set XHR properties (IT's translateSubtitle may pre-set them)
    const safeDefineXHRProp = (xhr, prop, value) => {
        xhr[`_custom_${prop}`] = value;
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
                const responseText = vttCache.get(normUrl);

                // Use setTimeout to make mock response asynchronous, avoiding race condition with event listeners
                setTimeout(() => {
                    safeDefineXHRProp(this, 'status', 200);
                    safeDefineXHRProp(this, 'statusText', 'OK');
                    safeDefineXHRProp(this, 'readyState', 4);
                    safeDefineXHRProp(this, 'response', responseText);
                    safeDefineXHRProp(this, 'responseText', responseText);
                    safeDefineXHRProp(this, 'responseURL', urlStr);

                    if (typeof this.onreadystatechange === 'function') this.onreadystatechange();
                    if (typeof this.onload === 'function') this.onload();
                    this.dispatchEvent(new Event('readystatechange'));
                    this.dispatchEvent(new Event('load'));
                }, 10);
                return;
            }

            log(`XHR proxy (network): ${urlStr.substring(0, 80)}... → GM_xmlhttpRequest`);
            GM_xmlhttpRequest({
                method: this._method || 'GET',
                url: this._url,
                headers: {
                    'Referer': location.origin + '/',
                    'Origin': location.origin
                },
                onload: (resp) => {
                    vttCache.set(normUrl, resp.responseText);
                    safeDefineXHRProp(this, 'status', resp.status);
                    safeDefineXHRProp(this, 'statusText', resp.statusText);
                    safeDefineXHRProp(this, 'readyState', 4);
                    safeDefineXHRProp(this, 'response', resp.responseText);
                    safeDefineXHRProp(this, 'responseText', resp.responseText);
                    safeDefineXHRProp(this, 'responseURL', urlStr);

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
                'Referer': location.origin + '/',
                'Origin': location.origin
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
                fetchInProgress = false;
                log(`VTT cached (${vttText.length} bytes, ${cues.length} cues).`);

                // Set video metadata for IT extension
                const video = document.querySelector('video');
                if (video) {
                    video.dataset.itVttUrl = vttUrl;
                    video.dataset.immersiveTranslateVideoId = 'anisuge-' + Date.now();
                    if (video.crossOrigin !== 'anonymous') video.crossOrigin = 'anonymous';

                    injectVttTrack(video, vttText, { reason: 'initial fetch' });
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

    // Window message listener handles both OUTBOUND (inject -> content-script) and INBOUND (content-script -> inject) messages
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

                // --- OUTBOUND MESSAGE INTERCEPTION (inject -> content-script) ---
                // NOTE: On Firefox, stopImmediatePropagation() cannot cross JavaScript
                // compartment boundaries. The content-script's message listener is in a
                // separate compartment and always receives the original message. Instead
                // of trying to intercept here, we prevent IT from sending requestSubtitle
                // by: (1) removing VTT tracks from JWPlayer config, (2) replacing VTT
                // URLs with blob: URLs in XHR hooks, (3) wrapping IT's fetch hook.
                if (msg.from === 'inject' && msg.to === 'content-script') {
                    // Track getConfig request IDs to match responses
                    if (msgType === 'getConfig' && msg.id) {
                        _pendingGetConfigIds.add(msg.id);
                    }
                    // Log outbound messages for diagnostics (skip noisy ones)
                    if (msgType !== 'isContentReady') {
                        log(`Bridge (inject→cs) "${msgType}" id=${msg.id || 'none'}`);
                    }
                    return; // Don't process outbound messages further
                }

                // --- INBOUND MESSAGE INTERCEPTION (content-script -> inject) ---
                const direction = `${msg.from}→${msg.to}`;

                // Detect getConfig RESPONSE by matching ID
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
                        setTimeout(() => {
                            if (!itHookReady) {
                                log("Safety timeout after getConfig reached. Releasing VTT requests.");
                                triggerItHookReady();
                            }
                        }, 800);
                    }
                } else if (msg.from === 'content-script' && msg.to === 'inject') {
                    // Log inbound messages
                    log(`Bridge (cs→inject) [${_bridgeMsgTypes[msgType]}] "${msgType}" id=${msg.id || 'none'} payload=${previewPayload(msg.data)}`);
                }

                // Block crash-prone messages ONLY on Firefox to prevent XrayWrapper crash
                if (isFirefox && PREACT_CRASH_MSG_TYPES.has(msgType)
                    && msg.from === 'content-script' && msg.to === 'inject') {
                    event.stopImmediatePropagation();
                    _bridgeBlockedCount++;
                    log(`Blocked "${msgType}" message to prevent Firefox XrayWrapper crash.`);
                    tryExtractAttachSubtitle(msg);
                    return;
                }

                if (msgType === 'requestSubtitle' && msg.from === 'content-script' && msg.to === 'inject') {
                    log(`requestSubtitle response (cs→inject): data type=${typeof msg.data}, length=${typeof msg.data === 'string' ? msg.data.length : 'N/A'}`);
                }

                if (msgType === 'subtitleResponse') {
                    tryExtractSubtitleResponse(msg);
                }
            } catch (e) {
                log(`postMessage event listener error: ${e.message}`);
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

    const mergeCues = (existing, incoming) => {
        const cueMap = new Map();
        for (const cue of existing) {
            const key = `${cue.start.toFixed(3)}-${cue.end.toFixed(3)}`;
            cueMap.set(key, cue);
        }
        for (const cue of incoming) {
            const key = `${cue.start.toFixed(3)}-${cue.end.toFixed(3)}`;
            if (cueMap.has(key)) {
                const existingCue = cueMap.get(key);
                cueMap.set(key, {
                    ...existingCue,
                    ...cue,
                    translation: cue.translation || existingCue.translation
                });
            } else {
                cueMap.set(key, cue);
            }
        }
        return Array.from(cueMap.values()).sort((a, b) => a.start - b.start);
    };

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
                const prevCount = translatedCues.length;
                translatedCues = mergeCues(translatedCues, bilingual);
                log(`Merged attachSubtitle cues. Count: ${prevCount} -> ${translatedCues.length}`);
                
                itTranslationDetected = true;
                hideJWPlayerCaptions();
                log('IT translation active via attachSubtitle.');
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
                        const prevCount = translatedCues.length;
                        translatedCues = mergeCues(translatedCues, bilingual);
                        log(`Merged subtitleResponse cues. Count: ${prevCount} -> ${translatedCues.length}`);
                        
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
                        const prevCount = translatedCues.length;
                        translatedCues = mergeCues(translatedCues, bilingual);
                        log(`Merged subtitleResponse (object) cues. Count: ${prevCount} -> ${translatedCues.length}`);
                        
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
        if (!ENABLE_TEXTTRACK_MONITOR_DEBUG) {
            if (textTrackMonitorInterval) {
                clearInterval(textTrackMonitorInterval);
                textTrackMonitorInterval = null;
            }
            return;
        }

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

    const isElementVisible = (el) => {
        if (!el || !el.isConnected) return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none'
            && style.visibility !== 'hidden'
            && style.opacity !== '0'
            && el.getClientRects().length > 0;
    };

    const queryAllDeep = (selector, root = document) => {
        const results = [];
        const visited = new Set();
        const walk = (node) => {
            if (!node || visited.has(node)) return;
            visited.add(node);

            if (typeof node.querySelectorAll === 'function') {
                results.push(...node.querySelectorAll(selector));
            }

            const elements = typeof node.querySelectorAll === 'function'
                ? node.querySelectorAll('*')
                : [];
            for (const el of elements) {
                if (el.shadowRoot) {
                    walk(el.shadowRoot);
                }
            }
        };
        walk(root);
        return results;
    };

    const getVisibleItCaptionWindow = () => {
        const windows = queryAllDeep('#imt-caption-window');
        for (const win of windows) {
            if (isElementVisible(win)) return win;
        }
        return null;
    };

    const getCaptionWindowContentRoot = (captionWindow) => {
        if (!captionWindow) return null;
        return captionWindow.shadowRoot || captionWindow;
    };

    const getItTranslationLoadingState = () => {
        const captionWindow = getVisibleItCaptionWindow();
        if (!captionWindow) {
            return { loading: false, sourceText: '', targetText: '', loadingText: '' };
        }

        const contentRoot = getCaptionWindowContentRoot(captionWindow);
        if (!contentRoot) {
            return { loading: false, sourceText: '', targetText: '', loadingText: '' };
        }

        const sourceText = Array.from(contentRoot.querySelectorAll('.source-cue'))
            .map(node => (node.textContent || '').trim())
            .filter(Boolean)
            .join(' ');
        const targetText = Array.from(contentRoot.querySelectorAll('.target-cue'))
            .map(node => (node.textContent || '').trim())
            .filter(Boolean)
            .join(' ');
        const loadingText = Array.from(contentRoot.querySelectorAll('.loading-text'))
            .filter(isElementVisible)
            .map(node => (node.textContent || '').trim())
            .filter(Boolean)
            .join(' ');

        return {
            loading: !!sourceText && !targetText && !!loadingText,
            sourceText,
            targetText,
            loadingText,
        };
    };

    const findITTranslatedTrack = (video) => {
        if (!video || !video.textTracks) return null;
        for (let i = 0; i < video.textTracks.length; i++) {
            const track = video.textTracks[i];
            const createBy = track.createBy || track.getAttribute?.('data-create-by');
            if (createBy && /^(?:imt|immersive[-_]translate|it[-_]subtitle)/i.test(String(createBy))) {
                return track;
            }
        }
        for (let i = 0; i < video.textTracks.length; i++) {
            const track = video.textTracks[i];
            const cues = track.cues;
            if (!cues) continue;
            for (let j = 0; j < cues.length; j++) {
                const t = (cues[j].text || '');
                if (t.includes('\n') || t.includes('​') || /\p{L}/u.test(t)) {
                    if (t.length > 8 && /\p{Script=Latin}/u.test(t)) return track;
                }
            }
        }
        return null;
    };

    const isActiveCueUntranslated = (video) => {
        const itTrack = findITTranslatedTrack(video);
        if (!itTrack || !itTrack.cues) return false;
        const now = video.currentTime;
        const originalCue = getCueAtTime(now);
        const originalText = originalCue?.text?.trim() || '';
        for (let i = 0; i < itTrack.cues.length; i++) {
            const cue = itTrack.cues[i];
            if (now < cue.startTime || now > cue.endTime) continue;
            const cueText = (cue.text || '').trim();
            if (!cueText) continue;
            const parts = cueText.split(/\r?\n/);
            const afterNewline = parts.length > 1 ? parts.slice(1).join(' ').trim() : '';
            const isErrored = afterNewline === 'translateFail' || afterNewline === 'Translation failed' || /^translateFail[:.]/i.test(afterNewline);
            const hasTranslated = /\p{L}/u.test(afterNewline || cueText) && !/^[A-Za-z0-9\s.,!?'"`-]+$/.test(afterNewline || cueText);
            const missingTranslation = !hasTranslated || isErrored;
            if (missingTranslation && originalText) {
                const containsOriginal = cueText.includes(originalText);
                if (containsOriginal || cueText === originalText) return true;
            }
        }
        return false;
    };

    const startTranslationSyncGuard = () => {
        if (!ENABLE_TRANSLATION_SYNC_GUARD) return;
        if (translationSyncInterval) clearInterval(translationSyncInterval);

        translationSyncInterval = setInterval(() => {
            const video = document.querySelector('video');
            if (!video) {
                translationSyncLoadingSince = 0;
                translationSyncPausedSince = 0;
                translationSyncPausedVideo = null;
                if (translationSyncResumeTimer) {
                    clearTimeout(translationSyncResumeTimer);
                    translationSyncResumeTimer = null;
                }
                return;
            }

            const now = Date.now();
            const state = getItTranslationLoadingState();
            const activeCue = getCueAtTime(video.currentTime);
            const loadingKey = state.sourceText || activeCue?.text || '';

            if (state.loading) {
                if (!translationSyncLoadingSince || loadingKey !== translationSyncLoadingKey) {
                    translationSyncLoadingSince = now;
                    translationSyncLoadingKey = loadingKey;
                }

                if (!translationSyncPausedVideo && !video.paused && now - translationSyncLoadingSince >= TRANSLATION_SYNC_PAUSE_DELAY_MS) {
                    translationSyncPausedVideo = video;
                    translationSyncPausedSince = now;
                    if (translationSyncResumeTimer) {
                        clearTimeout(translationSyncResumeTimer);
                        translationSyncResumeTimer = null;
                    }
                    try {
                        video.pause();
                        log('Translation sync guard paused video while IT catches up.');
                    } catch (e) {}
                } else if (translationSyncPausedVideo && now - translationSyncPausedSince >= TRANSLATION_SYNC_MAX_PAUSE_MS) {
                    const pausedVideo = translationSyncPausedVideo;
                    translationSyncPausedVideo = null;
                    translationSyncPausedSince = 0;
                    translationSyncLoadingSince = 0;
                    if (translationSyncResumeTimer) clearTimeout(translationSyncResumeTimer);
                    translationSyncResumeTimer = setTimeout(() => {
                        translationSyncResumeTimer = null;
                        if (!pausedVideo.isConnected || !pausedVideo.paused) return;
                        Promise.resolve(pausedVideo.play()).then(() => {
                            log('Translation sync guard hit max wait and resumed video.');
                        }).catch(() => {});
                    }, TRANSLATION_SYNC_RESUME_DELAY_MS);
                }

                if (loadingKey
                    && now - translationSyncLoadingSince >= TRANSLATION_SYNC_STALE_LOADING_MS
                    && now - translationSyncLastRecoveryAt >= TRANSLATION_SYNC_REINJECT_COOLDOWN_MS) {
                    if (injectVttTrack(video, vttText, { replace: true, reason: 'stale loading recovery' })) {
                        translationSyncLastRecoveryAt = now;
                        log(`Translation sync guard reinjected track after stale loading on cue: ${loadingKey.substring(0, 80)}`);
                    }
                }
                return;
            }

            translationSyncLoadingSince = 0;
            translationSyncLoadingKey = '';
            if (!translationSyncPausedVideo && isActiveCueUntranslated(video)) {
                if (!translationSyncUntranslatedSince) {
                    translationSyncUntranslatedSince = now;
                }
                if (now - translationSyncUntranslatedSince >= TRANSLATION_SYNC_UNTRANSLATED_MS
                    && now - translationSyncLastRecoveryAt >= TRANSLATION_SYNC_PERSIST_REINJECT_COOLDOWN_MS) {
                    if (injectVttTrack(video, vttText, { replace: true, reason: 'untranslated active cue recovery' })) {
                        translationSyncLastRecoveryAt = now;
                        translationSyncUntranslatedSince = 0;
                        log('Translation sync guard reinjected track for stuck untranslated active cue.');
                    }
                }
            } else if (translationSyncUntranslatedSince) {
                translationSyncUntranslatedSince = 0;
            }
            if (!translationSyncPausedVideo) return;

            const pausedVideo = translationSyncPausedVideo;
            translationSyncPausedVideo = null;
            translationSyncPausedSince = 0;

            if (translationSyncResumeTimer) {
                clearTimeout(translationSyncResumeTimer);
            }
            translationSyncResumeTimer = setTimeout(() => {
                translationSyncResumeTimer = null;
                if (!pausedVideo.isConnected || !pausedVideo.paused) return;
                const latestState = getItTranslationLoadingState();
                if (latestState.loading) return;
                Promise.resolve(pausedVideo.play()).then(() => {
                    log('Translation sync guard resumed video.');
                }).catch(() => {});
            }, TRANSLATION_SYNC_RESUME_DELAY_MS);
        }, TRANSLATION_SYNC_POLL_MS);
    };

    // ── 8. Boot ──────────────────────────────────────────────────────
    findVtt();
    startVttBootWatcher();
    startTranslationSyncGuard();

    // Monitor video element changes (source changes, new element creation)
    let lastVideoElement = null;
    let lastVideoSrc = null;
    setInterval(() => {
        const video = document.querySelector('video');
        if (video) {
            if (video !== lastVideoElement) {
                const isFirst = (lastVideoElement === null);
                lastVideoElement = video;
                lastVideoSrc = video.src;
                if (!isFirst && vttUrl) {
                    resetStateForNewVideo('New video element detected');
                }
            } else if (video.src !== lastVideoSrc) {
                lastVideoSrc = video.src;
                if (vttUrl) {
                    resetStateForNewVideo('Video src changed');
                }
            }
        }
    }, 1000);

    log('v11.6+ ready. v11.6 base + proactive cache warm on first English detect.');

    // ── 9. Diagnostic monitors ─────────────────────────────────────────
    if (ENABLE_BRIDGE_DIAGNOSTICS) {
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
    }

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
                try {
                    appendToVisualConsole(data.msg, data.frameId);
                } catch (e) { }
            }
            // Receive VTT relay from iframe
            if (data && data.type === 'it-fix-vtt-relay') {
                log(`VTT relayed from iframe: ${data.vttUrl?.substring(0, 80)}... (${data.vttText?.length || 0} bytes, ${data.cueCount} cues)`);
                const norm = normalizeUrl(data.vttUrl);
                if (!vttUrl) {
                    vttUrl = norm;
                    vttText = data.vttText;
                    vttCache.set(vttUrl, vttText);
                    cues = parseVTT(vttText);
                    log(`VTT from iframe cached: ${cues.length} cues.`);
                    startITTranslationMonitor();
                } else if (isEnglishVtt(norm) && !isEnglishVtt(vttUrl)) {
                    vttUrl = norm;
                    vttText = data.vttText;
                    vttCache.set(vttUrl, vttText);
                    cues = parseVTT(vttText);
                    log(`VTT from iframe upgraded to English: ${cues.length} cues.`);

                    // Reset translation state to monitor again
                    itTranslationDetected = false;
                    translatedCues = [];
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
        } catch (e) {
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
                } catch (e) {
                    log(`VTT relay failed: ${e.message}`);
                }
            }
        };

        setTimeout(iframePlayerCheck, 3000);
        setTimeout(iframePlayerCheck, 8000);
        setTimeout(iframePlayerCheck, 15000);
    }

    log(`v11.6+ initialization complete. isInIframe=${isInIframe}`);
})();
