# Next Steps: Testing v9.0 Implementation

## Prerequisites
1. Firefox with Immersive Translate extension installed
2. Tampermonkey with megaplay_patch.user.js v9.0
3. Access to anisuge.tv or megaplay.buzz with English subtitles

## Step 0: Update Configuration
1. **Reload Immersive Translate user rules**:
   - Open IT extension settings → User Rules
   - Upload/paste updated `user_rules.json` (now 9 lines, very simple)
   - Save and enable

2. **Reload userscript**:
   - Go to Tampermonkey dashboard
   - Find "Megaplay.buzz Immersive Translate Fix v9.0"
   - Click refresh or reload page with script active

## Step 1: Navigate to Video
Open: https://anisuge.tv/watch/anime-slug/ep-1

## Step 2: Open DevTools Console
- **Firefox**: Press `F12` → Console tab
- Keep it open during video playback

## Step 3: Watch for Critical Logs

### Expected Sequence (SUCCESS):
```
[IT-Fix] Anti-debug active.
[IT-Fix] Early window.fetch override installed for VTT Referer injection.
[IT-Fix] Preact XrayWrapper fix: 17 properties pre-defined...
[IT-Fix] TextTrackCue.prototype.innerHTML monkey-patch installed.
[IT-Fix] GM_webRequest registered.
[IT-Fix] VTT Discovery...
[IT-Fix] Starting TextTrack monitor for IT translations...
[initPage] rule https://megaplay.buzz/stream/... common-vtt-jw ✓
[IT-Fix] Bridge message type seen: isContentReady
[IT-Fix] fetch proxy: https://1oe.lostproject.club/anime/.../subtitles/en.vtt ✓
[IT-Fix] Bridge message type seen: requestSubtitle
[IT-Fix] innerHTML → text: "Line 1 from IT translation..." ✓
[IT-Fix] Bridge messages seen: isContentReady:1, requestSubtitle:1, ... ✓
```

### Red Flags (FAILURE):
```
[IT-Fix] BRIDGE INACTIVE - Zero messages intercepted after script start.
  → Extension not activating, rule didn't match
  
Error: request subtitle error
  → fetch() failed, Referer still missing

[initPage] rule https://anisuge.tv/... undefined
  → Rule didn't match (check user_rules.json reload)
```

## Step 4: Check Video UI
1. **IT Extension Icon**: Should be visible in top-right corner
2. **Subtitles**: Should show EN + VI (bilingual format)
3. **Duration**: First translation may take 5-10 seconds

## Step 5: Common Issues

### Issue 1: Icon disappeared / No bridge messages
- **Cause**: user_rules.json not reloaded or has wrong format
- **Fix**: 
  - Verify `matches.add` (not plain `matches`)
  - Verify `id: "common-vtt-jw"` (not custom ID)
  - Hard refresh browser (Ctrl+Shift+R)

### Issue 2: "Error: request subtitle error" in console
- **Cause**: fetch() call in content-script still failing (Step 3 needed)
- **Expected behavior for v9.0**: Should NOT see this error if page-level fetch hooks work
- **If still seeing it**: Implement Step 3 (bridge message interception with data:URI swap)

### Issue 3: Preact XrayWrapper crash
```
Error: Not allowed to define cross-origin object as property on [Object] or [Array]
```
- **Expected**: May see this if extension renders UI components from content-script
- **Mitigation**: Our Node.prototype patch should prevent it (Step 4 handles if it reoccurs)
- **If still crashes**: Identify message type in payload preview logs, add to block-list

### Issue 4: No translation appears
- **Possible causes**:
  - VTT URL not detected (check `[IT-Fix] VTT Discovery` logs)
  - Translation taking too long (wait 10+ seconds)
  - Extension's engine failure (check IT extension's own console)
- **Fallback**: Should see Google Translate (fallback enabled)

## Step 6: If All Looks Good
✓ Logs show successful flow  
✓ Subtitles display EN + VI  
✓ No errors in console  

**You've successfully implemented Plan v2 Step 1-2!**

Next phases (if needed):
- **Step 3**: Bridge message interception (if content-script fetch still fails)
- **Step 4**: XrayWrapper crash handler (if crash reoccurs on UI render)

## Step 7: If Issues Persist
1. Check Plan v2 document for detailed diagnostics
2. Enable more verbose logging (modify log function to include stack traces)
3. Compare against v8.0 logs (in original conversation) to see differences
4. Run Step 3 (bridge interception) as preemptive measure

---

**Commit**: 0511484 - feat: implement plan v2 Steps 1-2  
**Files Modified**: user_rules.json, megaplay_patch.user.js (v9.0)  
**Plan Reference**: C:\Users\Admin\.claude\plans\ti-p-t-c-functional-milner.md
