// ==UserScript==
// @name         YouTube Always Show Controls (Brute Force)
// @namespace    http://tampermonkey.net/
// @version      1.4
// @description  Xóa bỏ hoàn toàn cơ chế tự ẩn thanh điều khiển YouTube (Play, Volume, Progress Bar, ...)
// @author       Antigravity
// @match        *://*.youtube.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // 1. Dùng CSS để ép hiển thị các thành phần điều khiển
    const css = `
        /* Buộc hiện thanh điều khiển và các nút bấm */
        .ytp-autohide .ytp-chrome-bottom, 
        .ytp-chrome-bottom[aria-hidden="true"],
        .ytp-chrome-bottom { 
            opacity: 1 !important; 
            visibility: visible !important; 
            display: block !important; 
            bottom: 0 !important;
        }

        /* Buộc hiện bóng mờ ở đáy video để nhìn rõ nút trắng */
        .ytp-autohide .ytp-gradient-bottom, 
        .ytp-gradient-bottom { 
            opacity: 1 !important; 
            display: block !important; 
            visibility: visible !important;
        }

        /* Giữ thanh tiến trình (Progress Bar) luôn dày, không bị biến thành sợi chỉ */
        .ytp-autohide .ytp-progress-bar-container,
        .ytp-progress-bar-container {
            height: 5px !important;
            bottom: 48px !important;
            transform: scaleY(1) !important;
        }

        .ytp-autohide .ytp-progress-bar,
        .ytp-progress-bar {
            height: 5px !important;
        }

        /* Luôn hiện con trỏ chuột trong vùng video */
        .ytp-autohide, 
        .ytp-autohide *, 
        #movie_player.ytp-autohide {
            cursor: default !important;
        }

        /* Đảm bảo icon Immersive Translate luôn hiện và có màu trắng */
        .immersive-translate-quick-button-container {
            opacity: 1 !important;
            visibility: visible !important;
            display: inline-flex !important;
            filter: brightness(0) invert(1) !important;
        }

        .ytp-right-controls .immersive-translate-quick-button-container {
            width: 36px !important;
            height: 36px !important;
            vertical-align: middle !important;
        }
    `;

    // Tiêm CSS vào trang web
    const injectCSS = () => {
        if (document.getElementById('yt-always-controls-style')) return;
        const style = document.createElement('style');
        style.id = 'yt-always-controls-style';
        style.textContent = css;
        (document.head || document.documentElement).appendChild(style);
    };

    // 2. Cơ chế Brute Force: Liên tục gỡ bỏ class ẩn của YouTube
    const stayVisible = () => {
        const player = document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
        if (player) {
            // Gỡ bỏ class kích hoạt việc ẩn
            if (player.classList.contains('ytp-autohide')) {
                player.classList.remove('ytp-autohide');
            }
            // Đánh lừa YouTube là chuột vẫn đang hoạt động để giữ UI ổn định
            player.dispatchEvent(new MouseEvent('mousemove'));
        }
        injectCSS();
    };

    // Chạy ngay khi có thể
    injectCSS();
    
    // Kiểm tra định kỳ để xử lý các thay đổi giao diện động (SPA)
    setInterval(stayVisible, 500);

    // Lắng nghe sự kiện chuyển trang của YouTube
    window.addEventListener('yt-navigate-finish', stayVisible);
})();
