# Dahua Viewer (v2.1)

Ứng dụng desktop cho Windows 10/11 dùng **C# WinForms + Microsoft Edge WebView2 + go2rtc** để xem trực tiếp và xem lại video từ đầu ghi Dahua. Ứng dụng được tối ưu cho `DH-XVR4116HS-I` và truy cập từ xa qua Tailscale. Dự án được phát triển và phát hành độc lập với Dahua Technology.

## Tải bản portable cho Windows 10/11 x64

1. Tải [DahuaViewer-v2.1-Windows-x64.zip](https://github.com/buinam1920/dahua-viewer/releases/download/v2.1/DahuaViewer-v2.1-Windows-x64.zip) và giải nén toàn bộ vào một thư mục.
2. Mở `DahuaViewer.exe`, nhập IP đầu ghi, tài khoản và mật khẩu, rồi bấm **Kết nối**.
3. Nếu máy báo thiếu WebView2 Runtime, chạy `redist\MicrosoftEdgeWebview2Setup.exe` khi có Internet, sau đó mở lại ứng dụng.

Gói ZIP đã có sẵn ứng dụng và go2rtc. Chạy `Install-Shortcuts.bat` nếu muốn tạo lối tắt trên Desktop và Start Menu.

## Cấu trúc
- `src/DahuaViewerApp.cs` — vỏ WinForms + WebView2, tích hợp HTTP Digest proxy (`127.0.0.1:1985`, token phiên cục bộ, endpoint `/download` tải clip `.dav`), Windows Job Object tự dọn `go2rtc.exe`, single-instance Mutex, PerMonitorV2 DPI.
- `src/Build.bat` — biên dịch `DahuaViewer.exe` trực tiếp bằng `.NET Framework csc.exe` có sẵn trên Windows.
- `www/` (`index.html`, `style.css`, `player.js`, `app.js`) — giao diện tối, lưới `1/4/9/16`, xem lại với timeline 24h có zoom (`24h/6h/1h/10m`), tua tức thì trong buffer, nhảy sự kiện Motion, bật/tắt tiếng (`FLAC/AAC/Opus`), tải clip `.dav`, và tự tạm dừng Live khi thu nhỏ cửa sổ.
- `go2rtc.yaml` — cấu hình `go2rtc` cục bộ (`127.0.0.1:1984`, quản lý luồng trong RAM qua `PATCH /api/streams`).
- `Install-Shortcuts.bat` — tạo shortcut Desktop và Start Menu.

## Biên dịch từ mã nguồn
1. Tải `go2rtc_win64.zip` từ [AlexxIT/go2rtc](https://github.com/AlexxIT/go2rtc/releases) và giải nén `go2rtc.exe` vào `bin/go2rtc.exe`.
2. Chạy `src\Build.bat` để biên dịch `DahuaViewer.exe`.
3. Mở `DahuaViewer.exe`, nhập IP đầu ghi, tài khoản, mật khẩu và bấm **Kết nối**.

## Thành phần bên thứ ba

- [Microsoft WebView2 SDK 1.0.2903.40](https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.2903.40) cung cấp hai DLL .NET và `WebView2Loader.dll` x64. Repo và gói ZIP đều kèm [giấy phép](licenses/WebView2-SDK-LICENSE.txt) và [thông báo bản quyền](licenses/WebView2-SDK-NOTICE.txt) từ gói NuGet.
- [go2rtc v1.9.15](https://github.com/AlexxIT/go2rtc/releases/tag/v1.9.15) được đóng gói trong ZIP cùng [giấy phép MIT](https://github.com/AlexxIT/go2rtc/blob/v1.9.15/LICENSE) tại `licenses/go2rtc-LICENSE.txt`.
- [Microsoft Edge WebView2 Evergreen Bootstrapper](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution) được kèm trong ZIP để cài WebView2 Runtime khi cần.

Khi phát hành, dùng bản từ nhà cung cấp và giữ giấy phép, thông báo bản quyền của đúng phiên bản trong gói phân phối. Nếu kèm `go2rtc.exe`, cần kiểm tra cả các thư viện đã liên kết trong tệp thực thi và kèm thông báo tương ứng. Có thể để người dùng lấy `go2rtc` trực tiếp từ bản phát hành của dự án upstream.
