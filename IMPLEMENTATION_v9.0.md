# Implementation History: Immersive Translate Anime-Site Fix

This document is the historical log of how the fix was built. See `FIX_DOCUMENTATION.md` for the full technical deep-dive and `NEXT_STEPS.md` for current operating instructions.

## v1 — Custom Google Translate overlay

**Date:** pre-2026

Approach: skip IT entirely, fetch English VTT, call Google Translate API directly from userscript, render bilingual overlay on top of JWPlayer.

**Verdict:** User rejected this. Goal was always to use IT's own translation engine.

## v3.6 — Cross-origin VTT injection via data:URI

**Date:** 2026

Approach: intercept fetch for `.vtt` URLs, fetch with `Referer` header, convert to `data: URI`, swap URL via postMessage bridge so IT gets the VTT content.

**Verdict:** Worked, but unreliable: cross-origin postMessage bridge hit Firefox's XrayWrapper issues intermittently.

## v5 / v8 — Preact XrayWrapper patches + DOM hook

**Date:** 2026

Approach: pre-define 17 Preact internal properties on `Node.prototype` to prevent the content-script Preact from crashing when rendering cross-origin DOM elements. Pair with `TextTrackCue.prototype.innerHTML` setter to capture IT's translated cue writes.

**Verdict:** Patches installed correctly but never observed firing because IT never reached the `cue.innerHTML = translatedText` codepath.

## v9.0 — Minimal extension to built-in `common-vtt-jw`

**Commit:** `0511484`

Approach: stop fighting IT's architecture. Use IT's existing `common-vtt-jw` rule (already configured for `subtitleRule.type: "subsrt"`) and just extend `matches.add` to include `anisuge.tv` and `megaplay.buzz`. Simplify userscript to fetch override only.

**Changes:**
- Removed HTMLTrackElement.src swap, MutationObserver polling, manual track injection, 3s polling engine.
- Kept: anti-debug, Preact XrayWrapper fix (page context only, harmless), TextTrackCue.innerHTML patch, GM_webRequest, bridge postMessage interceptor, IT translation monitor, Google fallback, bilingual overlay.

**Verdict:** Setup now reaches IT's `Ms.translateSubtitle` codepath consistently. Still slow / unreliable.

## v11.5 — Bridge responder for `requestSubtitle`

**Date:** 2026-06-18

Approach: respond to IT's `requestSubtitle` postMessage from userscript with the full VTT body. IT translates the entire file as one document → no windowed batching → no per-batch timeout stalls.

**Verdict:** Translation was smooth, no stall. But Firefox's `stopImmediatePropagation()` couldn't cross the userscript/content-script compartment boundary in some configurations, causing intermittent "lúc được lúc không" detection.

## v11.6 — Direct `<track>` injection

**Date:** 2026-06-20 (commit `60479fc`, `b180529`, `938a440`, `2804270`)

Approach: stop trying to fight the bridge. Fetch the English VTT once, inject it as a `<track kind="subtitles" default src="data:text/vtt;base64,…">` on the video. IT's content_main reads cue text directly from the DOM (no fetch, no bridge) → reliably translates, but now does so via the `attachSubtitle` windowed path (cuechange-driven, one lookahead window at a time, each wrapped in IT's per-request timeout).

**Trade-off:** Detection became deterministic; per-request stall was introduced. Mitigated by tuning the gemma service's `requestTimeout` to ~20s in `Full_User_config.json`.

**Verdict:** Stable. The current architectural baseline. v11.6 is the only working approach on Firefox in this setup.

## v11.6.4 — Translation sync guard + recovery (this repo's current build)

**Date:** 2026-06-27

Approach: v11.6 is stable, but windowed batched translation means a single batch timeout can lose a window of cues. Once a cue is marked `state="error"` in IT's React state, IT never retranslates it (`v[b].translation && !C` is permanently true). Add three layers of defense:

1. **Shadow-aware sync guard** — poll IT's `#imt-caption-window` (including `shadowRoot`) every 80ms. Pause video when `.source-cue` present but `.target-cue` empty.
2. **Stale-loading recovery** — after 2.5s of `state="loading"`, reinject the `<track>` with a fresh data:URI (timestamp nonce forces IT to re-process).
3. **Untranslated-cue recovery** — every 80ms, scan IT's managed TextTrack. If active cue is untranslated (no target-language characters, or contains literal `translateFail`), reinject after 3.5s of being stuck. Cooldown 10s.

Files updated:
- `megaplay_patch.user_firefox.js` → `11.6.4`
- `megaplay_patch.user_firefox_experiment.js` → `11.6-exp13-untranslated-recovery`
- `megaplay_patch.no_antidebug.user.js` → `11.6.4`
- `Full_User_config.json` → `requestTimeout: 20000`, `retry: 0`, `maxTextGroupLengthPerRequestForSubtitle: 1` on Gemma + Google + Bing
- `user_rules.json` → expanded domain coverage

**Verdict:** Confirmed working. 3-consecutive-line misses reduced to occasional single-cue misses that recover automatically within ~3.5s.

## v11.6.5 — Domain expansion

**Date:** 2026-06-27

Approach: extend `@match` and `user_rules.json` to cover all sister sites (animesalt, animekai, anikoto family, hianime family, zorotv, 9anime, etc.).

Files updated:
- All three userscripts bumped to `11.6.5` (or `11.6-exp14-site-coverage` for experiment)
- `user_rules.json` → 76 `matches.add` entries (38 domains × 2 each: exact + wildcard)

**Verdict:** Build covers the full ecosystem of similar JWPlayer-embed anime sites.