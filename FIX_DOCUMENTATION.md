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