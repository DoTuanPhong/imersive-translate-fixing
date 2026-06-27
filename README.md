# Immersive Translate Video Fix

Hướng dẫn khắc phục sự cố dịch phụ đề phim anime bằng Immersive Translate (Firefox extension) trên các site JWPlayer iframe (Anisuge / Megaplay / Vidtube / Nekostream, v.v.).

## 1. Cài đặt User Rules (Quy tắc người dùng)

Vào **Thiết lập nhà phát triển** -> **Sửa quy tắc người dùng (JSON)**. Copy và dán toàn bộ nội dung của `user_rules.json` trong repo này:

```json
[
  {
    "id": "common-vtt-jw",
    "matches.add": [
      "anisuge.tv", "*.anisuge.tv",
      "anisuge.se", "*.anisuge.se",
      "animesuge.re", "*.animesuge.re",
      "animesuge.cz", "*.animesuge.cz",
      "animesugez.tv", "*.animesugez.tv",
      "animesalt.cz", "*.animesalt.cz",
      "animesalt.to", "*.animesalt.to",
      "animesogo.to", "*.animesogo.to",
      "animesugetv.bz", "*.animesugetv.bz",
      "animekai.se", "*.animekai.se",
      "animekaitv.to", "*.animekaitv.to",
      "animepahetv.to", "*.animepahetv.to",
      "anikai.se", "*.anikai.se",
      "anikaitv.to", "*.anikaitv.to",
      "anikoto.bz", "*.anikoto.bz",
      "anikoto.cz", "*.anikoto.cz",
      "anikoto.me", "*.anikoto.me",
      "anikoto.net", "*.anikoto.net",
      "anikototv.se", "*.anikototv.se",
      "anikototv.to", "*.anikototv.to",
      "animewave.to", "*.animewave.to",
      "animixplay.cz", "*.animixplay.cz",
      "animixplay.tube", "*.animixplay.tube",
      "aniwatch.ch", "*.aniwatch.ch",
      "aniwave.cz", "*.aniwave.cz",
      "aniwave.id", "*.aniwave.id",
      "anixtv.me", "*.anixtv.me",
      "gogoanime.com.by", "*.gogoanime.com.by",
      "hianimes.re", "*.hianimes.re",
      "hianimetv.si", "*.hianimetv.si",
      "hianimez.org", "*.hianimez.org",
      "zorotv.cz", "*.zorotv.cz",
      "9anime.skin", "*.9anime.skin",
      "9animez.org", "*.9animez.org",
      "megaplay.buzz", "*.megaplay.buzz",
      "vidwish.live", "*.vidwish.live",
      "1anime.site", "*.1anime.site",
      "vidtube.site", "*.vidtube.site"
    ],
    "subtitleRule.add": {
      "allowHideModeTextTrack": true
    }
  }
]
```

## 2. Cài đặt Userscript (Tampermonkey / Violentmonkey)

Repo cung cấp 3 biến thể:

| File | Mục đích |
|------|---------|
| `megaplay_patch.user_firefox.js` (`11.6.5`) | Bản chính cho Firefox (có anti-debug + Preact XrayWrapper fix). |
| `megaplay_patch.user_firefox_experiment.js` (`11.6-exp14-site-coverage`) | Bản thử nghiệm có flag `EXPERIMENT_DOCUMENT_MODE` (giữ ở `false` để chạy giống v11.6). |
| `megaplay_patch.no_antidebug.user.js` (`11.6.5`) | Bản không có anti-debug hook, dùng khi script có anti-debug bị xung đột. |

Chỉ bật **một** script cùng `@match` để tránh xung đột.

## 3. Cài đặt Translation Service

Trong IT Settings -> Translation Services, với service Gemini/Gemma custom đang dùng, sửa:

```json
"requestTimeout": "20000",
"retry": "0",
"maxTextGroupLengthPerRequestForSubtitle": "1"
```

(`Full_User_config.json` đã có sẵn thiết lập này. Import file đó vào IT.)

## 4. Đã làm được

- JWPlayer trong iframe `megaplay.buzz` nhận được VTT tiếng Anh từ `1oe.lostproject.club` qua `GM_xmlhttpRequest` với header `Referer` đúng.
- VTT được inject thành `<track kind="subtitles" default src="data:text/vtt;base64,...">` để IT đọc cue trực tiếp từ DOM và dịch đúng (đường duy nhất hoạt động ổn định trên Firefox trong setup này).
- Translation sync guard tự pause/resume video khi IT đang dịch và kẹt quá lâu.
- Stale-loading recovery + Untranslated-cue recovery: nếu một cue bị kẹt ở state error, script tự reinject track để reset state.

## 5. Lưu ý quan trọng

- **Nếu mất 1-2 câu mỗi vài phút**: đây là giới hạn kiến trúc của chế độ dịch realtime. Để giảm, dùng model nhanh (Gemini Flash Lite) và đặt `maxTextGroupLengthPerRequestForSubtitle: "1"`.
- **Reload trang** là cách reset React state của IT nếu cue kẹt quá lâu.
- **Log đáng chú ý**:
  - `Translation sync guard paused video while IT catches up.` → đang pause vì IT chậm.
  - `Translation sync guard resumed video.` → bản dịch về, video chạy tiếp.
  - `Translation sync guard reinjected track after stale loading on cue: ...` → recovery do loading treo.
  - `Translation sync guard reinjected track for stuck untranslated active cue.` → recovery do cue bị lỗi vĩnh viễn.