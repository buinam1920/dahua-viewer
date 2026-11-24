# Dahua Viewer (v2.1)

Ứng dụng desktop gọn nhẹ cho Windows 10/11 dùng **C# WinForms + Microsoft Edge WebView2 + go2rtc** thay thế SmartPSS Lite để xem trực tiếp và xem lại đầu ghi Dahua (đã tối ưu cho `DH-XVR4116HS-I` và truy cập từ xa qua Tailscale).

## Cấu trúc
- `src/DahuaViewerApp.cs` — vỏ WinForms + WebView2, tích hợp HTTP Digest proxy (`127.0.0.1:1985`, token phiên cục bộ, endpoint `/download` tải clip `.dav`), Windows Job Object tự dọn `go2rtc.exe`, single-instance Mutex, PerMonitorV2 DPI.
- `src/Build.bat` — biên dịch `DahuaViewer.exe` trực tiếp bằng `.NET Framework csc.exe` có sẵn trên Windows.
- `www/` (`index.html`, `style.css`, `player.js`, `app.js`) — giao diện tối kiểu SmartPSS, lưới `1/4/9/16`, xem lại với timeline 24h có zoom (`24h/6h/1h/10m`), tua tức thì trong buffer, nhảy sự kiện Motion, bật/tắt tiếng (`FLAC/AAC/Opus`), tải clip `.dav`, và tự tạm dừng Live khi thu nhỏ cửa sổ.
- `go2rtc.yaml` — cấu hình `go2rtc` cục bộ (`127.0.0.1:1984`, quản lý luồng trong RAM qua `PATCH /api/streams`).
- `Install-Shortcuts.bat` — tạo shortcut Desktop và Start Menu.

## Chạy & Build
1. Tải `go2rtc_win64.zip` từ [AlexxIT/go2rtc](https://github.com/AlexxIT/go2rtc/releases) và giải nén `go2rtc.exe` vào `bin/go2rtc.exe`.
2. Chạy `src\Build.bat` để biên dịch `DahuaViewer.exe`.
3. Mở `DahuaViewer.exe`, nhập IP đầu ghi, tài khoản, mật khẩu và bấm **Kết nối**.
