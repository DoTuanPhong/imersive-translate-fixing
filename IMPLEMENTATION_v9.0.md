# Implementation Summary: Immersive Translate Fix v9.0

## Overview
Successfully implemented **Plan v2 Steps 1-2** and **Step 5 cleanup** from the comprehensive roadmap. The implementation moves away from DOM-level patching toward a cleaner fetch-level override approach.

## Changes Made

### 1. user_rules.json (Step 1)
**From**: Custom rule with wrong ID and type
```json
{
  "id": "anisuge_megaplay_custom",
  "matches.add": ["*://anisuge.tv/*", ...],
  "subtitleRule": { "type": "text_track", ... }
}
```

**To**: Minimal extension to built-in rule
```json
[
  {
    "id": "common-vtt-jw",
    "matches.add": [
      "anisuge.tv",
      "*://anisuge.tv/*",
      "*://*.anisuge.tv/*"
    ]
  }
]
```

**Why**: 
- Built-in `common-vtt-jw` already has correct configuration with `subtitleRule.type: "subsrt"`
- Uses `.add` suffix to merge domains (CRITICAL — plain `matches` breaks IT icon)
- Bare-domain format matches existing built-in pattern

### 2. megaplay_patch.user.js (Step 2 + Step 5)

#### Added (Step 2): Early window.fetch Override
- **Location**: Lines 59-122 (right after anti-debug section)
- **Purpose**: Intercept VTT requests and inject Referer header via GM_xmlhttpRequest
- **Key Timing**: Runs at `@run-at document-start` BEFORE extension loads
  - When extension's inject script saves `globalThis.__originalFetch`, it captures our override
  - Extension's page-context fetch hook inherits our GM-backed fetch
  - Enables bypass of 403 Forbidden from 1oe.lostproject.club

**Code Pattern**:
```js
unsafeWindow.fetch = function (input, init) {
    const url = ...extract URL...;
    if (/lostproject\.club\/.+\.vtt/i.test(url)) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET', url,
                headers: { 'Referer': 'https://megaplay.buzz/' },
                onload: r => resolve(new Response(r.responseText, {...})),
                onerror: e => reject(new TypeError(...))
            });
        });
    }
    return _origFetch(input, init);
};
```

#### Removed (Step 5): Non-Functional Patches
1. **HTMLTrackElement.src DOM-level swap** (lines 377-451 in v8.1)
   - Reason: JWPlayer uses HLS subtitle path (cues via addCue), not `<track>` element
   - Extension doesn't read track.src to discover URL
   - Proven no-op — no log output ever triggered

2. **MutationObserver for track scanning** (lines 453-500 in v8.1)
   - Dependent on HTMLTrackElement.src patch
   - Unnecessary with new fetch override approach

3. **injectSubtitleTracks function** (lines 553-622 in v8.1)
   - Injected manual `<track>` elements that JWPlayer ignored
   - Not called by new v9.0 flow
   - Unnecessary DOM manipulation

4. **Polling engine** (lines 1120-1197 in v8.1)
   - 3-second continuous loop trying to inject tracks
   - Called `injectSubtitleTracks()` and other old functions
   - Replaced with more efficient IT translation monitor

#### Kept: Essential Components
- **Anti-debug** (section 0) — Prevents remote debugging
- **Preact XrayWrapper fix** (section 0.5) — Pre-defines Preact properties on Node.prototype
- **TextTrackCue.innerHTML patch** (section 0.6) — Captures extension's cue.innerHTML writes and copies to cue.text
- **GM_webRequest** (section 1) — Additional CORS header injection (defense-in-depth)
- **Bridge postMessage interceptor** (section 6) — Diagnostics and message tracking
- **IT Translation Monitor** (section 7) — Detects bilingual cues (EN\nVI) from extension
- **Google Translate Fallback** (section 8) — Fallback if IT fails
- **Bilingual Overlay Render** (section 9) — Displays EN + VI captions

## Version Changes
- **v8.1** → **v9.0**
- Lines: ~1250 → 943 (25% reduction)
- Cleaner architecture, fewer side effects

## Testing Checklist

After reloading both the extension user rules and the userscript, verify:

- [ ] **Console**: `[initPage] rule https://megaplay.buzz/stream/... common-vtt-jw` (parent page)
- [ ] **Console**: `[initPage] rule https://anisuge.tv/... common-vtt-jw` (parent page matches too)
- [ ] **Console**: Bridge messages appear: `isContentReady`, `requestSubtitle`, etc.
- [ ] **Console**: `[IT-Fix] fetch proxy: https://1oe.lostproject.club/...vtt`
- [ ] **Console**: NO `Error: request subtitle error` (success!)
- [ ] **Console**: `[IT-Fix] innerHTML → text: "..."` (extension writing translation)
- [ ] **UI**: EN + VI subtitles appear in JWPlayer caption area

## Open Paths for Step 3 (if needed)

If extension still fails to translate after Step 2:
- Verify if content-script's `_fetchSubtitle` uses `globalThis.__originalFetch` (depends on `Qe()` result on desktop)
- If it doesn't use `__originalFetch`, implement bridge message interception (Step 3) to swap URL to data:URI
- Use payload preview logs from bridge interceptor to identify exact message structure

## Known Risks for Step 4 (if needed)

If Preact crash reoccurs when extension activates UI:
- Use bridge message payload preview logs to identify crashing message type
- Add to block-list in bridge interceptor (keep `requestSubtitle`, block UI messages)
- Ensure cue.text still receives translation (via TextTrackCue.innerHTML patch)

## Commit Hash
`0511484` — feat: implement plan v2 Steps 1-2 for Immersive Translate fix
