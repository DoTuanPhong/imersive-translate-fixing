# Next Steps: Operating v11.6.5 Build

## Prerequisites
- Firefox 132+
- Immersive Translate extension (extension ID `8c297b69-...` in user's logs) installed as an extension, not userscript
- Tampermonkey (or Violentmonkey) with **one** of:
  - `megaplay_patch.user_firefox.js` `11.6.5` (recommended)
  - `megaplay_patch.no_antidebug.user.js` `11.6.5` (if anti-debug hook conflicts with another extension)
- Access to one of the supported anime sites (see `README.md` for full domain list)

## Step 0: Apply Configuration

1. **Import user rules**:
   - IT extension → Settings → Developer → "Edit user rules (JSON)"
   - Paste the entire contents of `user_rules.json`
   - Save

2. **Import translation service config**:
   - IT extension → Settings → Developer → "Import / Export config"
   - Import `Full_User_config.json`
   - This applies `requestTimeout: 20000`, `retry: 0`, `maxTextGroupLengthPerRequestForSubtitle: 1` to:
     - `google`
     - `bing`
     - `gemini-67auesAZ` (Gemma 4 31B)

3. **Reload Tampermonkey script**:
   - Open Tampermonkey dashboard
   - Confirm script version is `11.6.5` (or `11.6-exp14-site-coverage` for the experiment variant)
   - Hard-reload the page

## Step 1: Open an Episode

Navigate to any anime episode on a supported site, e.g. `https://anisuge.se/watch/<slug>/ep-1`. Click play. The video loads in an iframe (`megaplay.buzz`, `vidtube.site`, etc.) with JWPlayer + HLS.

## Step 2: Confirm Translation Is Running

In DevTools console (focus on the **iframe** frame for technical detail; top frame for the `[TOP]` userscript logs):

### Healthy sequence

```
[IFRAME:...] Injected with VTT data:URI (26KB, reason=initial fetch).
[IFRAME:...] Translation sync guard reinjected track for stuck untranslated active cue.
```

The first message confirms the English VTT was proxied and re-injected as a `<track>` element IT can read. The second message means the sync guard detected a stuck cue and reinjected.

### Red flags

| Symptom | Likely cause |
|---|---|
| `[IFRAME:...] No IT extension globals found on window.` | Expected. The extension's UI lives in content-script context, not the page. |
| `Immersive Translate WARN: [merge_rule] 跳过非纯数据对象…` | Harmless IT config warning. |
| `Immersive Translate ERROR: request failed fetchError: Request timeout after 20000ms` | The translation API is slow. With 20s timeout and 0 retry, the cue is marked errored; the untranslated-cue recovery reinjects ~3.5s later. |
| `BRIDGE INACTIVE - No new bridge messages in last 15s.` | Means an old script is still running. Confirm version is `11.6.5`. |

## Step 3: If a Cue Is Still Stuck After Reload

Manual recovery:
1. Press `F5` to reload the page.
2. Subtitle cues re-process from scratch (fresh React state in IT).

Automatic recovery (already in v11.6.5):
- Untranslated-cue recovery detects stuck cues and reinjects every 10s when cooldown allows.
- If you want to force recovery immediately: pause the video, seek back ~10s, resume. IT will re-evaluate cues in that range.

## Step 4: Switch Translation Service

To use a faster model:
- IT Settings → Translation Service → pick a faster option (e.g. `gemini-flash-lite-latest`).
- If switching **subtitle** service separately, set `subtitleTranslateService` to that service's id.

To disable the untranslated-cue recovery (e.g. for debugging):
- Edit `megaplay_patch.user_firefox.js`, set `const ENABLE_TRANSLATION_SYNC_GUARD = false`.

## Step 5: Performance Tips

- Use `gemini-flash-lite-latest` or similar fast model for subtitles.
- Keep `maxTextGroupLengthPerRequestForSubtitle: 1` (already set in `Full_User_config.json`).
- Keep `requestTimeout: 20000` (already set).
- If you have a Pro IT account, consider using built-in premium services for lowest latency.

## Step 6: Known Limitations

- The untranslated-cue detector works best when target language contains non-ASCII characters (Vietnamese, Chinese, Japanese, Thai, etc.). For pure-Latin targets the fallback only catches `translateFail` literal.
- During recovery, the video pauses for 80ms to let IT catch up. This is intentional to avoid skipping cues.
- 3-consecutive-line misses were the original symptom. After v11.6.5, single-cue misses are recovered within ~3.5s.

## Step 7: If Issues Persist

1. Verify script version in Tampermonkey dashboard.
2. Verify `user_rules.json` was reloaded in IT.
3. Verify `Full_User_config.json` was imported (check IT Settings → Translation Services → gemma-4-31b-it → timeout should be 20000).
4. Run `node --check megaplay_patch.user_firefox.js` to confirm script syntax is valid (sanity check after manual edits).
5. Compare against the most recent log in `FIX_DOCUMENTATION.md` §15.5 to see expected behavior.