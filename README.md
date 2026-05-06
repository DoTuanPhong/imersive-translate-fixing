# Immersive Translate Video Fix

Hướng dẫn khắc phục sự cố mất icon Immersive Translate trên YouTube và các trang xem phim (Anisuge/Megaplay).

## 1. Cài đặt User Rules (Quy tắc người dùng)
Vào **Thiết lập nhà phát triển** -> **Sửa quy tắc người dùng (JSON)**. Copy và dán toàn bộ nội dung sau:

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
    "id": "anisuge_custom_v4",
    "matches": ["anisuge.tv", "megaplay.buzz", "kwik.cx", "kwik.si", "kwik.sh", "vidstream.pro", "1anime.site", "hianime.to"],
    "isNativeVideo": true,
    "videoSelector": "video",
    "mainFrameSelector": ".artplayer-app, .jwplayer, .jw-wrapper, #player, .video-content, #megaplay-player",
    "subtitlesContainer": ".art-subtitles, .art-subtitle, .jw-captions, .jw-subtitles-text, .jw-text-track-container",
    "injectBy": "track",
    "autoEnabledBilingualSubtitles": true,
    "quickButtonRule": {
      "appendSelector": ".art-controls-right, .jw-controlbar-right-group",
      "insertBeforeSelector": ".art-control-setting, .jw-icon-fullscreen, .jw-icon-settings"
    },
    "sourceLanguageUrlPattern": {
      "en": { "matches": ["anisuge.tv", "megaplay.buzz", "kwik.cx", "vidstream.pro"] }
    },
    "additionalInjectedCss": [
      ".immersive-translate-quick-button-container { display: inline-flex !important; opacity: 1 !important; visibility: visible !important; filter: brightness(0) invert(1) !important; z-index: 2147483647 !important; }",
      ".art-controls-right .immersive-translate-quick-button-container, .jw-controlbar-right-group .immersive-translate-quick-button-container { float: left !important; width: 24px !important; height: 24px !important; margin: 0 6px !important; }",
      ".immersive-translate-quick-button-container img { width: 24px !important; height: 24px !important; object-fit: contain !important; }"
    ]
  }
]
```

## 2. Cài đặt Injected CSS (CSS tiêm vào)
Vào **Thiết lập nhà phát triển** -> **Inject CSS**. Copy và dán nội dung sau để icon hiển thị màu trắng chuẩn UI:

```css
.immersive-translate-quick-button-container {
    opacity: 1 !important;
    visibility: visible !important;
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
    z-index: 2147483647 !important;
    vertical-align: middle !important;
    margin: 0 4px !important;
}

.ytp-right-controls .immersive-translate-quick-button-container {
    width: 36px !important;
    height: 36px !important;
    filter: brightness(0) invert(1) !important; 
}

.art-controls-right .immersive-translate-quick-button-container {
    width: 24px !important;
    height: 24px !important;
    filter: brightness(0) invert(1) !important;
}

.immersive-translate-quick-button-container img {
    width: 24px !important;
    height: 24px !important;
    object-fit: contain !important;
}
```

## 3. Lưu ý quan trọng
- **YouTube Always Visible**: Nếu bạn dùng script giữ thanh điều khiển YouTube luôn hiện, icon sẽ vẫn xuất hiện bình thường trong thanh `.ytp-right-controls`.
- **Anisuge**: Nếu icon không hiện, hãy kiểm tra xem bạn đã cho phép extension chạy trên iframe của `vidstream.pro` hoặc `megaplay.buzz` chưa.
- **Float Ball**: Bạn có thể tắt "Bóng nổi" trong cài đặt chung, icon trong thanh điều khiển vẫn sẽ hoạt động độc lập.
