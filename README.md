# Recorder Viewer

Ứng dụng desktop cho Windows 10/11 dùng **C# WinForms + Microsoft Edge WebView2 + go2rtc** để xem trực tiếp và xem lại video từ đầu ghi Dahua. Ứng dụng được tối ưu cho `DH-XVR4116HS-I` và truy cập từ xa qua Tailscale. Dự án được phát triển và phát hành độc lập với Dahua Technology.

## Cài và mở lần đầu

Bạn cần Windows 10/11 64-bit, Internet ở lần mở đầu và thông tin đăng nhập đầu ghi.

1. Tải [Recorder Viewer cho Windows](https://github.com/buinam1920/dahua-viewer/releases/latest/download/RecorderViewer-Windows-x64.zip).
2. Bấm chuột phải vào tệp ZIP, chọn **Giải nén tất cả / Extract All**, rồi mở thư mục vừa giải nén.
3. Mở `RecorderViewer.exe`. Khi ứng dụng hỏi tải go2rtc, bấm **Có / Yes** và đợi màn hình kết nối xuất hiện.
4. Nhập địa chỉ IP, tài khoản và mật khẩu **của đầu ghi**, điền số kênh theo cấu hình đầu ghi, rồi bấm **Kết nối**. Chọn **Xem lại** nếu muốn mở bản ghi.

**Nếu báo thiếu WebView2**, mở thư mục `redist`, chạy `MicrosoftEdgeWebview2Setup.exe` khi có Internet, rồi mở lại `RecorderViewer.exe`.

**Nếu không kết nối được**, kiểm tra máy đang cùng mạng với đầu ghi hoặc đã bật Tailscale/VPN mà bạn dùng để truy cập. Kiểm tra lại địa chỉ IP và tài khoản đầu ghi.

Gói ZIP có tệp [README.txt](README.txt) để xem hướng dẫn sau khi giải nén. Bạn có thể chạy `Install-Shortcuts.bat` để tạo lối tắt trên Desktop và Start Menu.

## Cấu trúc
- `src/DahuaViewerApp.cs` — vỏ WinForms + WebView2, tích hợp HTTP Digest proxy (`127.0.0.1:1985`, token phiên cục bộ, endpoint `/download` tải clip `.dav`), Windows Job Object tự dọn `go2rtc.exe`, single-instance Mutex, PerMonitorV2 DPI.
- `src/Build.bat` — biên dịch `RecorderViewer.exe` trực tiếp bằng `.NET Framework csc.exe` có sẵn trên Windows.
- `www/` (`index.html`, `style.css`, `player.js`, `app.js`) — giao diện tối, lưới `1/4/9/16`, xem lại với timeline 24h có zoom (`24h/6h/1h/10m`), tua tức thì trong buffer, nhảy sự kiện Motion, bật/tắt tiếng (`FLAC/AAC/Opus`), tải clip `.dav`, và tự tạm dừng Live khi thu nhỏ cửa sổ.
- `go2rtc.yaml` — cấu hình `go2rtc` cục bộ (`127.0.0.1:1984`, quản lý luồng trong RAM qua `PATCH /api/streams`).
- `Install-Shortcuts.bat` — tạo shortcut Desktop và Start Menu.

## Biên dịch từ mã nguồn
1. Chạy `src\Build.bat` để biên dịch `RecorderViewer.exe`.
2. Mở `RecorderViewer.exe` và làm theo hướng dẫn trên màn hình. Nếu đã tự tải go2rtc từ nguồn chính thức, có thể đặt `go2rtc.exe` vào `bin\go2rtc.exe`.

## Thành phần bên thứ ba

- [Microsoft WebView2 SDK 1.0.2903.40](https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.2903.40) cung cấp hai DLL .NET và `WebView2Loader.dll` x64. Repo và gói ZIP đều kèm [giấy phép](licenses/WebView2-SDK-LICENSE.txt) và [thông báo bản quyền](licenses/WebView2-SDK-NOTICE.txt) từ gói NuGet.
- Ứng dụng tải [go2rtc v1.9.15](https://github.com/AlexxIT/go2rtc/releases/tag/v1.9.15) từ bản phát hành chính thức khi người dùng bấm **Có**. Ứng dụng kiểm tra SHA-256 trước khi giải nén và lưu bản đã xác minh để dùng lần sau. [Giấy phép go2rtc](https://github.com/AlexxIT/go2rtc/blob/v1.9.15/LICENSE)
- [Microsoft Edge WebView2 Evergreen Bootstrapper](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution) được kèm trong ZIP để cài WebView2 Runtime khi cần.

Khi phát hành, dùng bản từ nhà cung cấp và giữ giấy phép, thông báo bản quyền của đúng phiên bản trong gói phân phối. Nếu kèm `go2rtc.exe`, cần kiểm tra cả các thư viện đã liên kết trong tệp thực thi và kèm thông báo tương ứng. Có thể để người dùng lấy `go2rtc` trực tiếp từ bản phát hành của dự án upstream.
