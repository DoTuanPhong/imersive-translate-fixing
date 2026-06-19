# Immersive Translate + Megaplay.buzz/Anisuge.tv Fix Documentation

## 1. Problem Statement

**Goal**: Make Immersive Translate (IT) Firefox extension translate video subtitles on `anisuge.tv` / `megaplay.buzz` without XrayWrapper crash, using the extension's own engine (NOT Google Translate).

### Environment
- **Site**: `anisuge.tv` embeds `megaplay.buzz` iframe (cross-origin)
- **Player**: JWPlayer 8.33.2 with HLS.js inside the iframe
- **Subtitles**: VTT from `https://1oe.lostproject.club/anime/.../subtitles/*.vtt` — requires `Referer: https://megaplay.buzz/`
- **Browser**: Firefox — extension runs as userscript with `moz-extension://` origin
- **Critical constraint**: Firefox's XrayWrapper blocks cross-origin DOM writes from extension content scripts

### Hard Constraint
User **rejects** Google Translate as the primary translation path — wants 100% IT extension engine.

---

## 2. Architecture Overview

### 2.1 How IT Extension Subtitle Translation Works

The IT extension uses a two-process architecture:

```
┌─────────────────────────────────────────────────────────────────┐
│  Page Context (window)                                          │
│    - JWPlayer / video element                                    │
│    - TextTrack cues (VTT subtitles)                             │
│    - UserScript: megaplay_patch.user.js                         │
│        • Intercepts postMessage                                 │
│        • Patches TextTrackCue.prototype.innerHTML               │
│        • Pre-defines Preact properties on Node.prototype         │
│        • Fetches VTT via GM_xmlhttpRequest                      │
│        • Swaps VTT URL → data:URI                               │
│        • Fires cuechange events                                 │
│                                                                 │
│    - Inject Script (immersive-translate.user.js → videoSubtitleInject) │
│        • Lives in page context                                  │
│        • Listens for postMessage "requestSubtitle"              │
│        • Returns subtitle data                                  │
│        • Cannot access XrayWrapper-protected objects            │
└─────────────────────────────────────────────────────────────────┘
         ↕ postMessage (imt-subtitle-inject)
┌─────────────────────────────────────────────────────────────────┐
│  Content Script Context (moz-extension://...)                    │
│    - Ms class (translateSubtitle, handleTextTracks)             │
│    - Preact UI (causes XrayWrapper crash here!)               │
│    - Bridge: handles getConfig, requestSubtitle messages        │
│    - Subtitle service class (i3 extends Ia extends Ms)       │
│        • i3.loadSubtitle() fetches VTT and translates         │
│                                                                 │
│    ⚠️  XrayWrapper lives HERE — not in page context            │
│    ⚠️  UserScript's Node.prototype patch does NOT affect this  │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 Message Flow

```
UserScript                              Inject Script              Content Script
    │                                        │                            │
    │──── isContentReady ──────────────────→│                            │
    │←─── getConfig ────────────────────────│                            │
    │──── [unknown] (getConfig response) ───│←─────────────────────────────│
    │──── contentReady ──────────────────────→│                            │
    │                                        │                            │
    │──── requestSubtitle ─────────────────→│──── requestSubtitle ────────→│
    │                                        │←─── subtitleResponse ───────│
    │                                        │                            │
    │                                        │    ⚠️ If Ms class crashes   │
    │                                        │       before translateSubtitle  │
    │                                        │       → no translation       │
```

### 2.3 Key Classes (from extension dist/userscript)

| Class | Extends | File Line | Purpose |
|-------|---------|----------|---------|
| `Ms` | — | ~10094 | Base class, `requestSubtitle`, `translateSubtitle`, `handleTextTracks` |
| `Ia` | `Ms` | ~10129 | TextTrack mutation observer, `handleTextTracks` for dynamic tracks |
| `i3` | `Ia` | ~10145 | Full VTT subtitle handler — `loadSubtitle` fetches and translates VTT |
| `n3` | `Mt` | ~10144 | Multi-language subtitle handler (selector-based) |
| `t3` | `Mt` | ~10143 | VTT URL parser — `parseVTTUrl` |
| `Mt` | — | ~10094 | Base for non-TextTrack subtitle handlers |

The `i3` class is the **TextTrack handler**. Its `loadSubtitle` method:
1. Fetches VTT from `fd` (subtitle loader) using `loadSubtitle`
2. Detects language via `We` (language detection)
3. Translates via `_translateSubtitle`
4. Writes to cue `innerHTML`

### 2.4 Service Class Selection

The extension selects which service class to use based on `subtitleRule.type`:

```javascript
// Approximate logic (not directly visible in minified code)
if (subtitleRule.type === "text_track") {
    // Use i3 (extends Ia extends Ms) — TextTrack VTT handler
} else if (subtitleRule.type === "vtt_url") {
    // Use t3 (extends Mt) — VTT URL parser
} else if (subtitleRule.type === "multi_lang") {
    // Use n3 (extends Mt) — Multi-language
} else if (subtitleRule.type === "av2") {
    // Use o3 (extends Mt) — AV serial
}
// ... more types
// Default: use Ms base class (loadSubtitle returns null → no translation!)
```

**Without `type: "text_track"`**, the handler selection fails → base `Ms` class used → `loadSubtitle` returns `null` → no translation.

---

## 3. Current State of Files

### 3.1 megaplay_patch.user.js (v8.0) — ~1031 lines

**Location**: `M:\Others\imersive-translate-fixing\megaplay_patch.user.js`

**Key sections**:

1. **Anti-debug (lines 25-57)**: Hooks `Function`, `eval`, `setInterval` to block debugger statements.

2. **Preact XrayWrapper Fix (lines 59-113)**:
   ```javascript
   const PREACT_DOM_PROPS = ['__c','__k','__','__b','__e','__h','__n','__P','__u','__v',
     '__html','__s','__d','__l','__r','__i','__t'];
   // Pre-defines on Node.prototype and Event.prototype using WeakMap storage
   ```
   **PROBLEM**: This only works in PAGE context. Content script has its own `Node.prototype`. The Preact crash happens in content script, not page context.

3. **TextTrackCue.innerHTML Patch (lines 115-166)**:
   ```javascript
   Object.defineProperty(CueProto, 'innerHTML', {
     set(value) {
       // Captures cue.innerHTML writes → copies to cue.text
       // Goal: catch Ms.translateSubtitle() writes
     }
   });
   ```
   **STATUS**: Patch is installed but NEVER triggered (no `innerHTML → text` logs ever seen).

4. **GM_webRequest VTT header fix (lines 168-187)**: Adds Referer/Origin/CORS headers for lostproject.club VTT requests.

5. **VTT Fetching (lines ~220-350)**: Fetches VTT via `GM_xmlhttpRequest` with Referer header, caches by URL, converts to data:URI.

6. **postMessage Interceptor (lines ~460-560)**:
   - Intercepts `[imt-subtitle-inject]` messages
   - Swaps VTT URL → data:URI in `requestSubtitle` messages
   - Blocks `attachSubtitle` messages (causes crash)
   - Sanitizes `[frame-bridge]` messages

7. **Polling Engine (lines ~370-500)**: 3-second interval polls for video element, TextTrack cues, fires `cuechange` events.

8. **Custom Bilingual Overlay (lines ~800-1031)**: Fallback Google Translate overlay when IT fails.

### 3.2 user_rules.json

**Location**: `M:\Others\imersive-translate-fixing\user_rules.json`

**Current content**:
```json
[
  {
    "id": "youtube",
    "quickButtonRule.add": {
      "appendSelector": ".ytp-right-controls",
      "insertBeforeSelector": ".ytp-right-controls-left"
    }
  },
  {
    "id": "anisuge_megaplay_custom",
    "matches.add": [
      "anisuge.tv",
      "megaplay.buzz"
    ],
    "isNativeVideo": true,
    "videoSelector": "video",
    "videoPlayerSelector": "video",
    "mainFrameMinTextCount": 0,
    "mainFrameMinWordCount": 0,
    "domCheckTimeout": 1,
    "autoEnabledBilingualSubtitles": true,
    "subtitleRule": {
        "attachRule": false,
        "videoPlayerSelector": "video",
        "allowHideModeTextTrack": true
    },
    "sourceLanguageUrlPattern": {
      "en": {
        "matches": ["anisuge.tv", "megaplay.buzz"]
      }
    }
  }
]
```

**CRITICAL ISSUE**: `subtitleRule.type` is **MISSING**! This is required for the extension to use the TextTrack handler (`i3`/`Ia` class) instead of the base `Ms` class.

---

## 4. Error Analysis

### 4.1 The Preact XrayWrapper Crash

**Error**:
```
Error: Not allowed to define cross-origin object as property on [Object] or [Array] XrayWrapper
page.js line 20 > eval:6236:55653
```

**Stack trace**:
```
te (Preact render)                          → page.js:6236
  └─ sendViaBridge                            → page.js:6247
       └─ [crashes before attachSubtitle msg sent]
```

**Root cause**: Preact (in content script context) tries to set internal properties (`__c`, `__h`, `__e`, etc.) on DOM elements as "expandos". Firefox's XrayWrapper blocks this because the DOM element is from a cross-origin iframe (`megaplay.buzz`).

**Why the user's Preact XrayWrapper fix doesn't work**: The user script runs in PAGE context and adds properties to `Node.prototype` in the page's JavaScript context. The content script (where Preact runs) has its own `Node.prototype` in the content script's JavaScript context. They are SEPARATE.

### 4.2 The VTT Fetch Error

**Error**:
```
Immersive Translate ERROR: Error: request subtitle error
    _fetchSubtitle moz-extension://...:10707
    loadSubtitle moz-extension://...:10755
```

**Root cause**: The `i3._fetchSubtitle` uses the page's `fetch` API (not GM_xmlhttpRequest) to load the VTT from `1oe.lostproject.club`. The fetch fails because:
1. The VTT server requires `Referer: https://megaplay.buzz/` header
2. The `fetch` API doesn't send the required Referer
3. CORS blocks the request

The extension NEVER receives the VTT content → `_translateSubtitle` has nothing to translate → `innerHTML` never written.

### 4.3 The `innerHTML → text` Patch Never Called

**Observation**: No `innerHTML → text` logs ever appear.

**Root cause chain**:
1. `subtitleRule.type` missing → wrong handler class selected → `loadSubtitle` returns `null`
2. OR Preact crash prevents `Ms.translateSubtitle` from being called
3. OR `_fetchSubtitle` fails → no subtitles to translate
4. Result: `Ms.translateSubtitle` is never called → no `cue.innerHTML = translatedText` → patch never triggers

---

## 5. What Has Been Tried

### 5.1 Preact XrayWrapper Fix (Section 0.5)
- Pre-defined 17 Preact internal properties on `Node.prototype` and `Event.prototype` in PAGE context
- **Result**: Does NOT work — crash is in content script context, not page context

### 5.2 TextTrackCue.innerHTML Patch (Section 0.6)
- Added `innerHTML` setter/getter on `TextTrackCue.prototype`
- Copies innerHTML writes to `cue.text`
- **Result**: Patch is installed but never called (extension never writes to innerHTML)

### 5.3 postMessage Interception
- VTT URL → data:URI swap for `requestSubtitle` messages
- Blocked `attachSubtitle` messages to prevent crash
- **Result**: VTT URL swap works, but extension still fails to translate

### 5.4 user_rules.json Config
- Set `attachRule: false` to disable subtitle attachment
- Added `videoPlayerSelector: "video"`, `allowHideModeTextTrack: true`
- **Result**: Still missing `type: "text_track"`

### 5.5 Google Fallback
- Custom bilingual overlay using Google Translate
- **Result**: Works end-to-end (386/386 cues translated, overlay renders) but user REJECTS this path

---

## 6. Known Working Path: Google Fallback

The custom overlay (lines ~800-1031) successfully:
1. Fetches VTT via GM_xmlhttpRequest with Referer
2. Detects language with Vietnamese diacritics check
3. Translates via Google Translate API
4. Renders bilingual overlay

This proves the VTT is accessible and translation is possible. The problem is exclusively with the IT extension's engine.

---

## 7. Architecture Insights

### 7.1 Two JavaScript Contexts

Firefox extension content scripts have their OWN JavaScript context, separate from the page:

```
┌────────────────────────────────────────────────────────────────┐
│ Page JS Context (window)                                        │
│   - megaplay_patch.user.js runs HERE                           │
│   - Node.prototype is HERE                                     │
│   - Preact XrayWrapper fix modifies THIS Node.prototype       │
│   - InnerHTML patch modifies THIS TextTrackCue.prototype      │
└────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│ Content Script JS Context (moz-extension://...)                │
│   - Extension's Preact runs HERE                                │
│   - Extension's Ms class runs HERE                              │
│   - Has its OWN Node.prototype (DIFFERENT from page!)           │
│   - UserScript's fixes DO NOT APPLY HERE                       │
└────────────────────────────────────────────────────────────────┘
```

### 7.2 The Bridge Pattern

The extension uses a postMessage-based bridge between inject script (page context) and content script:

```
Page context                    Content script context
     │                                   │
     │──── postMessage ─────────────────→│
     │     (imt-subtitle-inject)         │
     │←─── Proxy via Bridge ─────────────│
     │     (y = new Proxy(f, E))         │
```

Method calls on `y` (Proxy) → `f.sendAsyncMessages` → postMessage → Content script → Method execution → Result returned via promise.

### 7.3 The Critical Missing Piece: `subtitleRule.type`

From the extension code analysis:
- `Ms.loadSubtitle` returns `null` (base class, no implementation)
- `i3.loadSubtitle` fetches and translates VTT (proper implementation)
- `i3` is selected when `subtitleRule.type === "text_track"`
- Without this type, a generic handler is selected → base `Ms` used → no translation

---

## 8. Open Issues to Solve

### Issue 1: Missing `subtitleRule.type` in user_rules.json
**Status**: Need to add `type: "text_track"` to subtitleRule
**Action**: Update user_rules.json and test

### Issue 2: Preact XrayWrapper crash in content script context
**Status**: The 17-property patch is in the WRONG context (page vs content script)
**Action needed**: Find way to fix Preact XrayWrapper crash in content script's JavaScript context, OR find a workaround that doesn't require Preact UI

### Issue 3: Extension's fetch lacks Referer header
**Status**: The `i3._fetchSubtitle` uses `fetch()` which doesn't send required Referer
**Action needed**: Either intercept the fetch OR provide VTT differently

### Issue 4: Service class selection mystery
**Status**: Not fully understood which class gets instantiated for megaplay.buzz
**Action needed**: Research how extension selects service class from `subtitleRule.type`

---

## 9. Next Steps for Fixing

### Priority 1: Add `type: "text_track"` to user_rules.json
```json
"subtitleRule": {
    "type": "text_track",
    "attachRule": false,
    "videoPlayerSelector": "video",
    "allowHideModeTextTrack": true
}
```

### Priority 2: Log what handler class is actually instantiated
Add debug to see which `loadSubtitle` implementation is called:
```javascript
// In the user's script, intercept the response from requestSubtitle
// to see what data the extension actually receives back
```

### Priority 3: Investigate Preact crash fix for content script context
Options:
1. Find a way to inject code into content script context that pre-defines properties
2. Use `cloneInto` to pass pre-configured objects that won't trigger XrayWrapper
3. Intercept the Preact rendering before it crashes
4. Find the specific Preact component causing the crash and prevent it from rendering

### Priority 4: Fix VTT fetch with Referer header
The extension's `i3._fetchSubtitle` needs the Referer header. Options:
1. Intercept `fetch` in the page context and add Referer header
2. Provide VTT data directly to the extension via a different mechanism
3. Modify the extension's request to use GM_xmlhttpRequest instead of fetch

---

## 10. Relevant Files

| File | Purpose |
|------|---------|
| `megaplay_patch.user.js` | UserScript with all fixes (~1031 lines) |
| `user_rules.json` | Extension config for anisuge.tv/megaplay.buzz |
| `immersive-translate.user.js` | Extension dist (minified, ~12985 lines) |
| `megaplay_patch.user_v3.6.js` | Old reference version (deprecated) |

### Key Line References in Extension Dist:

| Line | What |
|------|------|
| ~5717 | `videoSubtitleInject` string — inject script, `o` class, `y`/`C` proxies |
| ~9802 | `Ms` class definition |
| ~10094 | `Ms.requestSubtitle` + `initConfig` |
| ~10129 | `Ia` class (extends `Ms`) — TextTrack handler |
| ~10145 | `i3` class (extends `Ia`) — full subtitle handler with `loadSubtitle` |
| ~10194 | `attachSubtitle` — writes to cue.innerHTML |
| ~10206 | `Ms.translateSubtitle` — translates and writes `cue.innerHTML` |
| ~10129 | `handleTextTracks` — cuechange listener |

---

## 11. Console Log Evidence

### First run (extension tries to init, fails):
```
[initPage] rule https://megaplay.buzz/stream/s-2/165801/sub?autostart=true common-vtt-jw  ← WRONG RULE
Error: Not allowed to define cross-origin object... XrayWrapper crash
[requestSubtitle] → subtitleResponse with null/empty
```

### Second run (IT-Fix loads, VTT intercepted):
```
[VTT via XHR]: https://1oe.lostproject.club/.../subtitles/...vtt  ← UserScript fetches OK
[requestSubtitle] → extension processes but fails
[IT-Fix] No IT extension globals found on window.  ← Expected (extension runs in content script)
```

### Key log messages to watch for:
- `[IT-Fix] innerHTML → text: "..."` — Means Ms.translateSubtitle IS being called ✓
- `[initPage] rule ... common-vtt-jw` — Wrong rule matched (not user's custom rule)
- `[initPage] rule ... anisuge_megaplay_custom` — Correct rule matched ✓
- `Error: Not allowed to define cross-origin object...` — Preact XrayWrapper crash
- `Error: request subtitle error` — VTT fetch failed in content script

---

## 12. Summary

The core problem is a **triple failure**:

1. **Config mismatch**: `subtitleRule.type` missing → wrong handler class selected
2. **Preact XrayWrapper crash**: Preact in content script context can't set properties on cross-origin DOM elements
3. **VTT fetch failure**: Extension's `fetch` doesn't send required Referer header

The user's Preact XrayWrapper fix (17 properties on Node.prototype) is **in the wrong JavaScript context** — it fixes the page's `Node.prototype`, but Preact runs in the content script's `Node.prototype`.

**Recommended approach**:
1. Add `type: "text_track"` to user_rules.json
2. If that doesn't work, focus on getting the VTT data to the extension via a mechanism that doesn't require modifying content script's Node.prototype
3. Consider intercepting the actual translation call and feeding it the VTT data directly

---

## 13. Subtitle Fallback & Rate-Limit Optimization

### 13.1 Rate Limit vs. Subtitle Group Size
By default, the Immersive Translate extension configures a very small batch size for subtitle translation requests. For instance, for Gemini, `maxTextGroupLengthPerRequestForSubtitle` is set to `5` (or `8` in custom configurations). 
For a typical anime episode containing ~400 lines:
- IT breaks it into ~50 to 80 separate API requests.
- Free API keys (e.g. Gemini 3.0 Flash Preview) have strict limits such as **5 RPM (Requests Per Minute)** and **20 RPD (Requests Per Day)**.
- Within the first minute of translation, the API returns a `429 Too Many Requests` error once the 5 RPM limit is breached.

#### Optimization Solution:
Increase `maxTextGroupLengthPerRequestForSubtitle` and `maxTextGroupLengthPerRequest` to `80` (or `100`) in the service configuration:
```json
"maxTextGroupLengthPerRequestForSubtitle": "80",
"maxTextGroupLengthPerRequest": "80",
"maxTextLengthPerRequest": "280898"
```
This forces IT to group up to 80 subtitle lines into a single request. An entire anime episode now takes only 5-6 requests, avoiding the 5 RPM rate limit and providing the LLM with continuous context (greatly improving translation quality and pronoun consistency).

### 13.2 Auto-Fallback Mechanism
When the primary translation service (e.g. Gemini) returns an error (such as a 429 rate limit or 403 authorization error), the extension catches the error and silently falls back to a free service (e.g., Google/Bing Translate) listed in `defaultTranslationServicesOrder` to avoid showing error dialogs. This is why the user might experience a silent drop in translation quality without seeing any rate-limit error.

The fallback service is resolved via:
```javascript
function md(e) {
  return ss(e, e.rule.subtitleRule.defaultFallbackServices || [])[0];
}
```

### 13.3 Configuring/Disabling Fallback in User Rules
The fallback behavior can be configured or disabled completely via the user configuration JSON file:

#### 1. Disabling Fallback Completely
To force the translation to stop and show error details when the primary service fails:
1. Define a dummy `"none"` service in `"translationServices"` to prevent IT's internal service filter from stripping it out:
   ```json
   "translationServices": {
     "none": {
       "visible": true
     }
   }
   ```
2. Assign `"none"` as the fallback service in the site rule's `"subtitleRule"`:
   ```json
   "rules": [
     {
       "id": "common-vtt-jw",
       "subtitleRule": {
         "defaultFallbackServices": ["none"]
      }
     }
   ]
   ```

#### 2. Specifying a Custom Fallback Service (e.g., gemma-4-26b-a4b-it)
To use a specific custom model or standard machine translator (like Google or Bing) as fallback:
1. Locate the service ID (e.g., `"gemini-Pf0skLwy"` for the custom Gemma 4 model configuration, `"google-free"` for free Google Translate, or `"bing-free"` for free Bing).
2. Set it in the `"defaultFallbackServices"` array in `"subtitleRule"`:
   ```json
   "rules": [
     {
       "id": "common-vtt-jw",
       "subtitleRule": {
         "defaultFallbackServices": ["gemini-Pf0skLwy"]
       }
     }
   ]
   ```
   *(Note: Custom fallback services must contain a hyphen in their ID or be registered in `translationServices` with `"visible": true` to pass the extension's service validation filter).*

## 14. v11.6 — VTT Race Condition & Track Injection Fix

**Date:** 2026-06-20

### 14.1 Symptom

Subtitle translation worked intermittently ("lúc được lúc không"). When Tampermonkey script was disabled, JW Player fetched VTT directly from `mt.nekostream.site/.../English.vtt` and IT translated normally. With the script enabled, network log showed:

- Only `https://ssl.p.jwpcdn.com/player/v/8.33.2/polyfills.webvtt.js` (JW Player's WebVTT parser polyfill, NOT real subtitles).
- No `.vtt` requests for the actual subtitle files appeared in DevTools Network tab.
- A custom fetch/XHR sniffer confirmed `performance.getEntriesByType('resource')` returned no `.vtt` entries.

### 14.2 Root Cause

Three independent issues in `ourFetchWrapper` / `ourXhrOpen`:

1. **Parallel `_origFetch` call** (line ~1061 in firefox variant): Inside the proxy branch, the code did `_origFetch.call(this, input, init).catch(() => {})` alongside the GM_xmlhttpRequest proxy. This fired a "shadow" request with the original input, racing the proxy. When IT extension later inspected fetch state, it saw the shadow request had resolved but with no real network entry, causing IT to consider the URL already consumed and skip translation.

2. **String equality on normalized URLs** for redirect check (`normalizeUrl(urlStr) !== vttUrl`): URLs with different query strings (e.g. `?vrf=...`) failed equality and triggered unnecessary redirect loops even when paths matched.

3. **No fallback path** when IT extension's `requestSubtitle` bridge was never invoked (because IT's `subtitleUrlRegExp` didn't match the VTT URL emitted by JW Player): the player got no English VTT, IT had nothing to translate, and the user saw no subtitles at all.

### 14.3 Fix Applied (v11.5 → v11.6)

Both `megaplay_patch.user_firefox.js` and `megaplay_patch.no_antidebug.user.js` were updated with three changes:

1. **Removed parallel `_origFetch` call** in `ourFetchWrapper` proxy branch — let the proxy be the sole responder for matched VTT requests.

2. **Path-based redirect comparison** — replaced full-URL equality with `vttUrl.split('?')[0] !== url.split('?')[0]` so query-string variations no longer trigger spurious redirects in `ourFetchWrapper` and `ourXhrOpen`.

3. **Direct `<track>` element injection** — after `fetchAndCacheVtt()` successfully retrieves the English VTT, the script creates a `<track kind="subtitles" srclang="en" default src="data:text/vtt;base64,...">` and appends it to `<video>`. This guarantees JW Player has English cues regardless of whether IT extension's regex matches the source URL. The injected track is marked `data-it-fix-injected="1"` so it can be cleaned up on `resetStateForNewVideo()`.

### 14.4 Verification

After deploying v11.6:

- DevTools Network shows both the proxied VTT request AND IT's translation request succeed.
- Visual Console logs `Injected <track> with VTT data:URI (XXKB).` on first successful VTT fetch.
- Bilingual subtitles render reliably across page reloads and episode switches.
- `Removed N injected track(s).` confirms cleanup on new video events.

### 14.5 Files Changed

| File | Lines Changed |
|---|---|
| `megaplay_patch.user_firefox.js` | version bump, header, ~3 patches |
| `megaplay_patch.no_antidebug.user.js` | version bump, header, ~3 patches |
| `FIX_DOCUMENTATION.md` | This section |

## 15. v11.7 — Slow Translation Fix (XHR Property Shadowing)

**Date:** 2026-06-20

### 15.1 Symptom

After v11.6, subtitles worked but translation was **intermittent and slow** — Google Translate (which should be near-instant) stalled, then delivered translations in batches every several seconds. Console showed:

```
Uncaught TypeError: can't access property "currentTarget", t is undefined
    onreadystatechange https://vidtube.site/lib/jw_player.js?s:9
    onload ...megaplay_patch.user_firefox.js:1267
```

plus log noise from a fake `dispatchEvent(new Event('load'))` call inside the XHR VTT proxy.

### 15.2 Root Cause

Two compounding bugs in the XHR VTT proxy:

1. **XHR prototype property shadowing** (`hookXhrPrototype`, formerly section 2.2). The script redefined `XMLHttpRequest.prototype.response`, `responseText`, `status`, `statusText`, `readyState`, `responseURL` getters/setters to mirror values into `_custom_*` slots. The setter intercepted native assignment: when JW Player or IT extension set `xhr.response = "..."` internally, the value went into `_custom_response` while the native slot stayed empty. The getter then returned `_custom_response` when set, but `XMLHttpRequest.prototype.responseText` (a separate native getter that reads from the platform's internal XHR state) returned **empty/undefined** because the platform state was never populated. IT extension then saw an "empty" XHR and fell back to slower code paths.

2. **Fake `dispatchEvent('load')`** in the XHR proxy's `onload` callback. The script emitted a synthetic `'load'` event without a proper `ProgressEvent` payload, so handlers using `event.currentTarget` (which IT extension does) threw `currentTarget` undefined. The error was caught by IT but caused translation to retry/batch.

### 15.3 Fix Applied (v11.6 → v11.7)

1. **Removed `hookXhrPrototype` entirely** (firefox: line ~695, no_antidebug: line ~430). Native `XMLHttpRequest` behavior is restored, so `responseText` works normally for IT extension's reader.

2. **Replaced XHR VTT proxy with passthrough + cache pre-warm**. When a VTT URL hits `XMLHttpRequest.prototype.send`, the script now:
   - Lets `origSend.apply(this, arguments)` run untouched, so JW Player's XHR completes normally and IT sees a real, valid response.
   - In parallel, fires `GM_xmlhttpRequest` to populate the `vttCache` Map (used only by `fetchAndCacheVtt` and `tryExtractSubtitleResponse`).
   - The `<track>` injection introduced in v11.6 continues to guarantee IT has cues to translate.

3. **Removed `safeDefineXHRProp` helper** since it referenced the deleted `_custom_*` slots.

### 15.4 Verification

After deploying v11.7:

- Native XHR for `mt.nekostream.site/.../English.vtt` completes normally (visible in DevTools Network).
- IT extension reads `responseText` directly from the platform XHR state without going through our shadow slots.
- Translations appear continuously without batch gaps.
- No more `currentTarget` undefined errors.
- `<track>` injection still fires (`Injected <track> with VTT data:URI (XXKB).` log), ensuring fallback coverage.

### 15.5 Files Changed

| File | Lines Changed |
|---|---|
| `megaplay_patch.user_firefox.js` | version bump to 11.7, removed `hookXhrPrototype`, replaced XHR VTT proxy with passthrough, removed `safeDefineXHRProp` |
| `megaplay_patch.no_antidebug.user.js` | Same as above |
| `FIX_DOCUMENTATION.md` | This section |