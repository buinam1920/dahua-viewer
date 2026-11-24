Dahua Viewer v2.1 (Standalone Portable - Windows 10/11)
=======================================================

Ung dung doc lap dung WebView2 co san tren Windows:
- KHONG can Chrome, KHONG can Node.js, KHONG can Python, KHONG can PowerShell.
- Tu bat go2rtc & proxy khi mo app, tu tat sach (Windows Job Object) khi dong app.
- Ho tro DPI cao (125%/150%), 1 cua so duy nhat, tu tam dung Live khi thu nho.
- Ghi nho bo cuc luoi, vi tri cua so; du lieu profile luu tai %LOCALAPPDATA%\DahuaViewer.

Cai dat tren may khac:
1. Giai nen thu muc nay vao mot noi co dinh (vi du: C:\DahuaViewer).
2. Chay `Install-Shortcuts.bat` de tao shortcut "Dahua Viewer" tren Desktop & Start Menu.
3. Mo `DahuaViewer.exe` (hoac shortcut Desktop), nhap mat khau dau ghi 1 lan -> bam Ket noi.

Tinh nang moi o v2.1:
- Xem lai muot: tua tuc thi +-10s trong buffer, zoom timeline 24h/6h/1h/10m, keo/lan chuot,
  nhay ngay truoc/sau, nhap gio chinh xac, nhay su kien Motion, hien "Ban ghi cu nhat",
  tu dong noi tiep doan sau 1 gio & xu ly doan qua 00:00 nua dem.
- Tai truc tiep doan clip (.dav) tu dau ghi (1 / 5 / 10 / 20 phut) ngay trong tab Xem lai.
- Bat/tat am thanh (ho tro FLAC/AAC/Opus tu go2rtc) o ca Live View va Xem lai.
- Kiem tra sai mat khau (401) truoc khi mo luong de tranh khoa tai khoan dau ghi.
- Tu tam dung Live View khi thu nho cua so de tiet kiem CPU va bang thong Tailscale.

Phim tat:
- 1 / 4 / 9 / 0     : Doi luoi 1 / 4 / 9 / 16 khung
- Double-click      : Phong to HD 1 khung / quay lai luoi
- Mui ten trai/phai : Chuyen trang (Live) hoac tua +-10s (Xem lai)
- Space             : Phat / Tam dung (Xem lai)
- B                 : An/hien danh sach camera
- F                 : Toan man hinh
- ?                 : Xem bang phim tat
