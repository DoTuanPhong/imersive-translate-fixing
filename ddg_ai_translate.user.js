// ==UserScript==
// @name         AniSuge AI Subtitle Translator (DuckDuckGo AI - Free)
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Dịch phụ đề qua DuckDuckGo AI Chat (GPT-4o-mini/Claude/Llama) MIỄN PHÍ. Phát hiện VTT, dịch batch, render overlay song ngữ.
// @author       Antigravity
// @match        *://anisuge.tv/*
// @match        *://megaplay.buzz/*
// @match        *://1anime.site/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @run-at       document-start
// @connect      1oe.lostproject.club
// @connect      duckduckgo.com
// @connect      translate.googleapis.com
// @connect      *
// ==/UserScript==

(async function () {
    'use strict';

    const log = (msg) => console.log(`[DDG-Trans] ${msg}`);

    // ═══════════════════════════════════════════════════════════════
    // CONFIG
    // ═══════════════════════════════════════════════════════════════
    const CONFIG = {
        // AI model for translation (DDG free tier)
        // Options: gpt-4o-mini, claude-3-haiku-20240307,
        //          meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo,
        //          mistralai/Mixtral-8x7B-Instruct-v0.1
        model: 'gpt-4o-mini',

        // Batch size: how many cues per API call
        batchSize: 20,

        // Fallback to Google Translate if DDG AI fails
        googleFallback: true,

        // Delay between batches (ms) — avoid rate limiting
        batchDelay: 2000,

        // DDG API endpoints
        ddgStatusUrl: 'https://duckduckgo.com/duckchat/v1/status',
        ddgChatUrl: 'https://duckduckgo.com/duckchat/v1/chat',
    };

    // ═══════════════════════════════════════════════════════════════
    // PROMISE WRAPPERS for GM_xmlhttpRequest
    // ═══════════════════════════════════════════════════════════════
    const gmRequest = (details) => new Promise((resolve, reject) => {
        const opts = { ...details, timeout: 60000 };
        const onload = opts.onload;
        const onerror = opts.onerror;
        opts.onload = (r) => {
            if (onload) onload(r);
            resolve(r);
        };
        opts.onerror = (e) => {
            if (onerror) onerror(e);
            reject(new Error('GM_xmlhttpRequest error'));
        };
        opts.ontimeout = () => reject(new Error('GM_xmlhttpRequest timeout'));
        GM_xmlhttpRequest(opts);
    });

    const gmGet = (url, headers = {}) => gmRequest({ method: 'GET', url, headers });
    const gmPost = (url, data, headers = {}) => gmRequest({
        method: 'POST', url, data,
        headers: { 'Content-Type': 'application/json', ...headers }
    });

    // ═══════════════════════════════════════════════════════════════
    // UTILITIES
    // ═══════════════════════════════════════════════════════════════
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

    // ═══════════════════════════════════════════════════════════════
    // STEP 1: VTT DISCOVERY
    // ═══════════════════════════════════════════════════════════════
    const discoverVTT = () => {
        let raw = null;

        // ArtPlayer
        const art = unsafeWindow.artplayer || (unsafeWindow.art && unsafeWindow.art.instances && unsafeWindow.art.instances[0]);
        if (art && art.option && art.option.subtitle && art.option.subtitle.url && art.option.subtitle.url.includes('.vtt')) {
            raw = art.option.subtitle.url;
        }

        // JWPlayer
        if (!raw) {
            const jw = unsafeWindow.jwplayer || window.jwplayer;
            if (typeof jw === 'function') {
                try {
                    const inst = jw();
                    if (inst && inst.getPlaylist && inst.getPlaylist()[0] && inst.getPlaylist()[0].tracks) {
                        inst.getPlaylist()[0].tracks.forEach(t => { if (t.file && t.file.includes('.vtt')) raw = t.file; });
                    }
                } catch (e) { }
            }
        }

        // Window properties
        if (!raw) {
            for (let key in unsafeWindow) {
                try {
                    const val = unsafeWindow[key];
                    if (typeof val === 'string' && val.includes('.vtt') && val.startsWith('http')) {
                        raw = val; break;
                    }
                } catch (e) { }
            }
        }

        return raw ? normalizeUrl(raw) : null;
    };

    // Also intercept page fetch/XHR for VTT detection
    let detectedVttUrl = null;
    const origFetch = unsafeWindow.fetch;
    const origXHROpen = XMLHttpRequest.prototype.open;
    if (origFetch) {
        unsafeWindow.fetch = function (...args) {
            const raw = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
            if (typeof raw === 'string' && raw.includes('.vtt') && !detectedVttUrl) {
                detectedVttUrl = normalizeUrl(raw);
                log(`VTT phát hiện qua fetch: ${detectedVttUrl}`);
            }
            return origFetch.apply(this, args);
        };
    }
    XMLHttpRequest.prototype.open = function (method, url) {
        if (typeof url === 'string' && url.includes('.vtt') && !detectedVttUrl) {
            detectedVttUrl = normalizeUrl(url);
            log(`VTT phát hiện qua XHR: ${detectedVttUrl}`);
        }
        return origXHROpen.apply(this, arguments);
    };

    // ═══════════════════════════════════════════════════════════════
    // STEP 2: FETCH VTT
    // ═══════════════════════════════════════════════════════════════
    const fetchVTT = async (url) => {
        log(`Tải VTT: ${url}`);
        try {
            const resp = await gmRequest({
                method: 'GET',
                url,
                headers: {
                    'Referer': 'https://megaplay.buzz/',
                    'Origin': 'https://megaplay.buzz'
                }
            });
            if (resp.status !== 200) {
                log(`LỖI tải VTT: HTTP ${resp.status}`);
                return null;
            }
            log(`VTT tải xong: ${resp.responseText.length} bytes`);
            return resp.responseText;
        } catch (e) {
            log(`LỖI tải VTT: ${e.message}`);
            return null;
        }
    };

    // ═══════════════════════════════════════════════════════════════
    // STEP 3: DDG AI CHAT — GET VQD TOKEN
    // ═══════════════════════════════════════════════════════════════
    const getVQDToken = async () => {
        log('Lấy VQD token từ DuckDuckGo...');
        try {
            const resp = await gmRequest({
                method: 'GET',
                url: CONFIG.ddgStatusUrl,
                headers: { 'x-vqd-accept': '1' }
            });
            // responseHeaders is a string like "header: value\r\n..."
            const headers = resp.responseHeaders || '';
            const match = headers.match(/x-vqd-4:\s*(\S+)/i);
            if (match) {
                log(`VQD token OK: ${match[1].substring(0, 12)}...`);
                return match[1];
            }
            log('KHÔNG tìm thấy x-vqd-4 trong response headers');
            log(`Headers: ${headers.substring(0, 200)}`);
            return null;
        } catch (e) {
            log(`LỖI lấy VQD: ${e.message}`);
            return null;
        }
    };

    // ═══════════════════════════════════════════════════════════════
    // STEP 4: TRANSLATE via DDG AI CHAT
    // ═══════════════════════════════════════════════════════════════
    const translateViaDDG = async (texts, vqdToken) => {
        // Build prompt: include all texts, ask for line-by-line translation
        const lines = texts.map((t, i) => `${i + 1}. ${t.replace(/\n/g, ' ')}`).join('\n');
        const prompt = `Translate these ${texts.length} English lines to Vietnamese. Output ONLY the Vietnamese translations, one per line, numbered the same way. Do not add any explanations, notes, or extra text. Keep the original meaning, tone, and formatting.

${lines}`;

        try {
            const resp = await gmRequest({
                method: 'POST',
                url: CONFIG.ddgChatUrl,
                headers: {
                    'x-vqd-4': vqdToken,
                    'Content-Type': 'application/json'
                },
                data: JSON.stringify({
                    model: CONFIG.model,
                    messages: [{ role: 'user', content: prompt }]
                })
            });

            if (resp.status !== 200) {
                log(`DDG API error: HTTP ${resp.status}`);
                return null;
            }

            // Parse SSE stream from response
            let fullText = '';
            const lines_resp = resp.responseText.split('\n');
            for (const line of lines_resp) {
                if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                    try {
                        const data = JSON.parse(line.slice(6));
                        if (data.message) fullText += data.message;
                    } catch (e) { /* skip parse errors */ }
                }
            }

            if (!fullText.trim()) {
                log('DDG trả về rỗng');
                return null;
            }

            // Parse numbered translations from response
            const translations = [];
            const answerLines = fullText.split('\n');
            for (const line of answerLines) {
                const m = line.match(/^\d+[\.\):]\s*(.+)/);
                if (m) {
                    translations.push(m[1].trim());
                }
            }

            // If parsing failed, try splitting by newline directly
            if (translations.length === 0) {
                const parts = fullText.split('\n').filter(s => s.trim());
                for (const p of parts) {
                    const clean = p.replace(/^\d+[\.\):]\s*/, '').trim();
                    if (clean) translations.push(clean);
                }
            }

            // If still not enough, use the whole text as single translation
            if (translations.length === 0 && fullText.trim()) {
                translations.push(fullText.trim());
            }

            return translations;
        } catch (e) {
            log(`DDG translate error: ${e.message}`);
            return null;
        }
    };

    // ═══════════════════════════════════════════════════════════════
    // STEP 5: GOOGLE TRANSLATE FALLBACK
    // ═══════════════════════════════════════════════════════════════
    const translateViaGoogle = async (text) => {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=vi&dt=t&q=${encodeURIComponent(text)}`;
        try {
            const resp = await gmGet(url);
            const json = JSON.parse(resp.responseText);
            if (json && json[0]) return json[0].map(part => part[0]).join('');
            return text;
        } catch (e) {
            return `[ERR: ${e.message}]`;
        }
    };

    const googleBatchTranslate = async (texts) => {
        const combined = texts.join('\n|||\n');
        const result = await translateViaGoogle(combined);
        return result.split(/\s*\|\|\|\s*/).map(s => s.trim());
    };

    // ═══════════════════════════════════════════════════════════════
    // STEP 6: ORCHESTRATE TRANSLATION
    // ═══════════════════════════════════════════════════════════════
    const translateAllCues = async (cues) => {
        // Try DDG AI first
        log(`Lấy VQD token...`);
        let vqd = await getVQDToken();

        if (vqd) {
            log(`DDG AI Chat sẵn sàng. Bắt đầu dịch ${cues.length} câu...`);
            const batches = [];
            for (let i = 0; i < cues.length; i += CONFIG.batchSize) {
                batches.push(cues.slice(i, i + CONFIG.batchSize));
            }

            const translated = [];
            let allBatchesSucceeded = true;
            for (let b = 0; b < batches.length; b++) {
                const batch = batches[b];
                const texts = batch.map(c => c.text);
                log(`DDG batch ${b + 1}/${batches.length} (${texts.length} câu)...`);

                let translations = await translateViaDDG(texts, vqd);

                // If DDG fails, try refreshing VQD token
                if (!translations) {
                    log(`DDG batch ${b + 1} thất bại, thử refresh VQD...`);
                    vqd = await getVQDToken();
                    if (vqd) {
                        translations = await translateViaDDG(texts, vqd);
                    }
                }

                if (translations && translations.length > 0) {
                    for (let j = 0; j < batch.length; j++) {
                        translated.push({
                            ...batch[j],
                            translation: translations[j] || batch[j].text
                        });
                    }
                    log(`  ✓ ${translations.length}/${texts.length} câu đã dịch`);
                } else {
                    log(`  ✗ DDG thất bại cho batch ${b + 1}, dùng Google fallback...`);
                    allBatchesSucceeded = false;
                    if (CONFIG.googleFallback) {
                        const googleResult = await googleBatchTranslate(texts);
                        for (let j = 0; j < batch.length; j++) {
                            translated.push({
                                ...batch[j],
                                translation: googleResult[j] || batch[j].text
                            });
                        }
                        log(`  ✓ Google fallback: ${googleResult.length}/${texts.length} câu`);
                    } else {
                        // Add untranslated as-is
                        for (let j = 0; j < batch.length; j++) {
                            translated.push({ ...batch[j], translation: batch[j].text });
                        }
                    }
                }

                // Delay between batches to avoid rate limiting
                if (b < batches.length - 1) {
                    await new Promise(r => setTimeout(r, CONFIG.batchDelay));
                }
            }

            return translated;
        }

        // DDG completely unavailable, use Google fallback
        if (CONFIG.googleFallback) {
            log('DDG AI không khả dụng. Dùng Google Translate...');
            const translated = [];
            const batches = [];
            for (let i = 0; i < cues.length; i += CONFIG.batchSize) {
                batches.push(cues.slice(i, i + CONFIG.batchSize));
            }
            for (let b = 0; b < batches.length; b++) {
                const batch = batches[b];
                const texts = batch.map(c => c.text);
                const googleResult = await googleBatchTranslate(texts);
                for (let j = 0; j < batch.length; j++) {
                    translated.push({
                        ...batch[j],
                        translation: googleResult[j] || batch[j].text
                    });
                }
                log(`Google batch ${b + 1}/${batches.length} (${googleResult.length}/${texts.length} câu)`);
                if (b < batches.length - 1) await new Promise(r => setTimeout(r, CONFIG.batchDelay));
            }
            return translated;
        }

        log('KHÔNG có phương thức dịch nào khả dụng!');
        return cues.map(c => ({ ...c, translation: c.text }));
    };

    // ═══════════════════════════════════════════════════════════════
    // STEP 7: BILINGUAL OVERLAY RENDER
    // ═══════════════════════════════════════════════════════════════
    let overlayContainer = null;
    let currentDisplay = { en: '', vi: '' };
    let renderInterval = null;

    const ensureOverlay = () => {
        if (overlayContainer && overlayContainer.parentNode) return overlayContainer;

        const video = document.querySelector('video');
        if (!video) return null;
        const videoParent = video.parentNode;
        if (!videoParent) return null;
        let jwContainer = video.closest('.jw-wrapper, .jwplayer, [class*="jw"]');
        if (!jwContainer) jwContainer = videoParent;

        overlayContainer = document.createElement('div');
        overlayContainer.id = 'ddg-custom-captions';
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
        log('Overlay caption đã tạo.');
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

    const startRender = (translatedCues) => {
        if (renderInterval) clearInterval(renderInterval);
        let lastCueIdx = -1;

        const jwCaptions = document.querySelector('.jw-captions');
        if (jwCaptions) {
            jwCaptions.style.setProperty('display', 'none', 'important');
            log('JWPlayer captions đã ẩn.');
        }

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

    // ═══════════════════════════════════════════════════════════════
    // STEP 8: BOOT — wait for video, discover VTT, translate, render
    // ═══════════════════════════════════════════════════════════════
    log('Khởi động...');

    const waitForVTT = () => new Promise((resolve) => {
        const check = () => {
            const found = discoverVTT() || detectedVttUrl;
            if (found) { resolve(found); return; }

            const video = document.querySelector('video');
            if (video && video.querySelector) {
                const tracks = video.querySelectorAll('track');
                for (const t of tracks) {
                    const src = t.getAttribute('src') || t.src || '';
                    if (src.includes('.vtt')) { resolve(normalizeUrl(src)); return; }
                }
            }
            setTimeout(check, 1000);
        };
        check();
    });

    try {
        const vttUrl = await waitForVTT();
        log(`VTT URL: ${vttUrl}`);

        const vttText = await fetchVTT(vttUrl);
        if (!vttText) {
            log('KHÔNG thể tải VTT. Dừng.');
            return;
        }

        const cues = parseVTT(vttText);
        log(`Đã parse ${cues.length} câu.`);

        if (cues.length === 0) {
            log('Không có câu nào trong VTT.');
            return;
        }

        log(`Bắt đầu dịch ${cues.length} câu...`);
        const translatedCues = await translateAllCues(cues);
        log(`Dịch xong: ${translatedCues.length} câu.`);

        // Đợi video element sẵn sàng rồi render
        const waitForVideo = () => new Promise((resolve) => {
            const check = () => {
                const v = document.querySelector('video');
                if (v && v.readyState >= 1) { resolve(v); return; }
                setTimeout(check, 500);
            };
            check();
        });
        await waitForVideo();
        startRender(translatedCues);
        log('HOÀN THÀNH — phụ đề song ngữ đang hiển thị.');

    } catch (e) {
        log(`LỖI: ${e.message}`);
        console.error(e);
    }
})();