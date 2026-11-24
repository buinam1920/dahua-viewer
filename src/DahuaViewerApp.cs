using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

static class NativeWin {
  [DllImport("dwmapi.dll")]
  private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);

  [DllImport("user32.dll")]
  private static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);

  [DllImport("shcore.dll")]
  private static extern int SetProcessDpiAwareness(int awareness);

  [DllImport("user32.dll")]
  private static extern bool SetProcessDPIAware();

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

  [DllImport("user32.dll")]
  private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

  [DllImport("user32.dll")]
  private static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

  [DllImport("kernel32.dll")]
  private static extern bool SetInformationJobObject(IntPtr hJob, int infoType, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

  [DllImport("kernel32.dll")]
  private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

  [DllImport("kernel32.dll")]
  private static extern bool CloseHandle(IntPtr hObject);

  [StructLayout(LayoutKind.Sequential)]
  private struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct IO_COUNTERS {
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }

  private const int JobObjectExtendedLimitInformation = 9;
  private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

  public static void EnablePerMonitorDpi() {
    try {
      // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4
      if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return;
    } catch { }
    try {
      SetProcessDpiAwareness(2);
      return;
    } catch { }
    try { SetProcessDPIAware(); } catch { }
  }

  public static void EnableDarkTitleBar(IntPtr hwnd) {
    try {
      int useDark = 1;
      DwmSetWindowAttribute(hwnd, 20, ref useDark, sizeof(int));
    } catch { }
  }

  public static void FocusExistingWindow(string title) {
    try {
      IntPtr h = FindWindow(null, title);
      if (h != IntPtr.Zero) {
        ShowWindow(h, 9); // SW_RESTORE
        SetForegroundWindow(h);
      }
    } catch { }
  }

  public static IntPtr CreateKillOnCloseJob() {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) return IntPtr.Zero;

    var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    int len = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
    IntPtr ptr = Marshal.AllocHGlobal(len);
    try {
      Marshal.StructureToPtr(info, ptr, false);
      SetInformationJobObject(job, JobObjectExtendedLimitInformation, ptr, (uint)len);
    } finally {
      Marshal.FreeHGlobal(ptr);
    }
    return job;
  }

  public static void AttachProcessToJob(IntPtr job, Process proc) {
    if (job == IntPtr.Zero || proc == null) return;
    try { AssignProcessToJobObject(job, proc.Handle); } catch { }
  }

  public static void CloseJob(IntPtr job) {
    if (job != IntPtr.Zero) {
      try { CloseHandle(job); } catch { }
    }
  }
}

class DahuaProxy : IDisposable {
  private readonly HttpListener _listener = new HttpListener();
  private readonly string _token;
  private readonly ConcurrentDictionary<string, CredentialCache> _credCaches = new ConcurrentDictionary<string, CredentialCache>();
  private volatile bool _running;

  public string Token { get { return _token; } }
  public string StartupError { get; private set; }

  public DahuaProxy(string token) {
    _token = token;
  }

  public bool Start(int port = 1985) {
    ServicePointManager.DefaultConnectionLimit = 16;
    ServicePointManager.Expect100Continue = false;
    _listener.Prefixes.Add("http://127.0.0.1:" + port + "/");
    try {
      _listener.Start();
      _running = true;
      Task.Run(() => Loop());
      return true;
    } catch (Exception ex) {
      StartupError = ex.Message;
      return false;
    }
  }

  private async Task Loop() {
    while (_running && _listener.IsListening) {
      HttpListenerContext ctx;
      try { ctx = await _listener.GetContextAsync(); }
      catch { break; }
      var _ = Task.Run(() => Handle(ctx));
    }
  }

  private static JavaScriptSerializer NewJson() {
    return new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 };
  }

  private bool IsAllowedOrigin(HttpListenerRequest req) {
    string origin = req.Headers["Origin"];
    if (string.IsNullOrEmpty(origin)) return true;
    return string.Equals(origin, "http://127.0.0.1:1984", StringComparison.OrdinalIgnoreCase)
        || string.Equals(origin, "http://localhost:1984", StringComparison.OrdinalIgnoreCase);
  }

  private void ApplyCors(HttpListenerRequest req, HttpListenerResponse res) {
    string origin = req.Headers["Origin"];
    if (!string.IsNullOrEmpty(origin) && IsAllowedOrigin(req)) {
      res.Headers["Access-Control-Allow-Origin"] = origin;
    } else {
      res.Headers["Access-Control-Allow-Origin"] = "http://127.0.0.1:1984";
    }
    res.Headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    res.Headers["Access-Control-Allow-Headers"] = "Content-Type, X-Dahua-Token";
    res.Headers["Vary"] = "Origin";
  }

  private void WriteJson(HttpListenerRequest req, HttpListenerResponse res, int status, object obj) {
    try {
      res.StatusCode = status;
      ApplyCors(req, res);
      res.Headers["Cache-Control"] = "no-store";
      res.ContentType = "application/json; charset=utf-8";
      byte[] bytes = Encoding.UTF8.GetBytes(NewJson().Serialize(obj));
      res.ContentLength64 = bytes.Length;
      res.OutputStream.Write(bytes, 0, bytes.Length);
      res.OutputStream.Close();
    } catch { }
  }

  private CredentialCache GetCredentialCache(string scheme, string host, int port, string user, string pass) {
    string key = scheme + "|" + host + "|" + port + "|" + user + "|" + pass;
    return _credCaches.GetOrAdd(key, _ => {
      var cred = new NetworkCredential(user, pass);
      var cache = new CredentialCache();
      var baseUri = new Uri(scheme + "://" + host + ":" + port + "/");
      cache.Add(baseUri, "Digest", cred);
      cache.Add(baseUri, "Basic", cred);
      return cache;
    });
  }

  private static bool IsSafeCgiUri(string uri) {
    if (string.IsNullOrEmpty(uri)) return false;
    if (!uri.StartsWith("/cgi-bin/", StringComparison.OrdinalIgnoreCase)) return false;
    if (uri.Contains("..") || uri.Contains("\r") || uri.Contains("\n")) return false;
    return true;
  }

  private static string SanitizeFileName(string name) {
    if (string.IsNullOrWhiteSpace(name)) return "clip.dav";
    var sb = new StringBuilder();
    foreach (char c in name) {
      if (char.IsLetterOrDigit(c) || c == '-' || c == '_' || c == '.') sb.Append(c);
      else sb.Append('_');
    }
    string res = sb.ToString();
    return res.Length == 0 ? "clip.dav" : res;
  }

  private void Handle(HttpListenerContext ctx) {
    var req = ctx.Request;
    var res = ctx.Response;
    try {
      if (!IsAllowedOrigin(req)) {
        WriteJson(req, res, 403, new Dictionary<string, object> { { "ok", false }, { "error", "Origin not allowed" } });
        return;
      }

      if (req.HttpMethod == "OPTIONS") {
        res.StatusCode = 204;
        ApplyCors(req, res);
        res.OutputStream.Close();
        return;
      }

      if (req.Url.AbsolutePath == "/health") {
        WriteJson(req, res, 200, new Dictionary<string, object> { { "ok", true } });
        return;
      }

      // Authenticate local app token
      string headerTok = req.Headers["X-Dahua-Token"];
      string queryTok = req.QueryString["token"];
      if (!string.Equals(headerTok, _token, StringComparison.Ordinal) &&
          !string.Equals(queryTok, _token, StringComparison.Ordinal)) {
        WriteJson(req, res, 403, new Dictionary<string, object> { { "ok", false }, { "error", "Invalid local token" } });
        return;
      }

      if (req.Url.AbsolutePath == "/cgi" && req.HttpMethod == "POST") {
        string bodyText;
        using (var sr = new StreamReader(req.InputStream, Encoding.UTF8)) bodyText = sr.ReadToEnd();
        var payload = NewJson().Deserialize<Dictionary<string, object>>(bodyText);

        string scheme = payload.ContainsKey("scheme") && payload["scheme"] != null ? payload["scheme"].ToString() : "http";
        if (scheme != "http" && scheme != "https") scheme = "http";
        string host = payload["host"].ToString().Trim();
        int port = payload.ContainsKey("port") && payload["port"] != null ? Convert.ToInt32(payload["port"]) : 80;
        string user = payload.ContainsKey("user") && payload["user"] != null ? payload["user"].ToString() : "";
        string pass = payload.ContainsKey("pass") && payload["pass"] != null ? payload["pass"].ToString() : "";
        string uri = payload["uri"].ToString();
        if (!uri.StartsWith("/")) uri = "/" + uri;
        int timeoutMs = payload.ContainsKey("timeoutMs") && payload["timeoutMs"] != null ? Convert.ToInt32(payload["timeoutMs"]) : 10000;
        if (timeoutMs < 2000) timeoutMs = 2000;
        if (timeoutMs > 30000) timeoutMs = 30000;

        if (!IsSafeCgiUri(uri)) {
          WriteJson(req, res, 400, new Dictionary<string, object> { { "ok", false }, { "error", "Only /cgi-bin/ paths are allowed" } });
          return;
        }

        string targetUrl = scheme + "://" + host + ":" + port + uri;
        try {
          var webReq = (HttpWebRequest)WebRequest.Create(targetUrl);
          webReq.Method = "GET";
          webReq.Timeout = timeoutMs;
          webReq.ReadWriteTimeout = timeoutMs;
          webReq.KeepAlive = false;
          webReq.Credentials = GetCredentialCache(scheme, host, port, user, pass);
          webReq.PreAuthenticate = true;

          using (var webRes = (HttpWebResponse)webReq.GetResponse())
          using (var sr = new StreamReader(webRes.GetResponseStream(), Encoding.UTF8)) {
            string respText = sr.ReadToEnd();
            WriteJson(req, res, 200, new Dictionary<string, object> {
              { "ok", true }, { "status", (int)webRes.StatusCode }, { "body", respText }
            });
          }
        } catch (WebException wex) {
          int statusCode = 0;
          string errBody = wex.Message;
          var hr = wex.Response as HttpWebResponse;
          if (hr != null) {
            statusCode = (int)hr.StatusCode;
            try { using (var sr = new StreamReader(hr.GetResponseStream(), Encoding.UTF8)) errBody = sr.ReadToEnd(); } catch { }
          }
          WriteJson(req, res, 200, new Dictionary<string, object> {
            { "ok", false }, { "status", statusCode }, { "body", errBody }
          });
        }
        return;
      }

      // Streaming binary download endpoint for Dahua clip export (.dav)
      if (req.Url.AbsolutePath == "/download" && req.HttpMethod == "POST") {
        string bodyText;
        using (var sr = new StreamReader(req.InputStream, Encoding.UTF8)) bodyText = sr.ReadToEnd();
        var payload = NewJson().Deserialize<Dictionary<string, object>>(bodyText);

        string scheme = payload.ContainsKey("scheme") && payload["scheme"] != null ? payload["scheme"].ToString() : "http";
        if (scheme != "http" && scheme != "https") scheme = "http";
        string host = payload["host"].ToString().Trim();
        int port = payload.ContainsKey("port") && payload["port"] != null ? Convert.ToInt32(payload["port"]) : 80;
        string user = payload.ContainsKey("user") && payload["user"] != null ? payload["user"].ToString() : "";
        string pass = payload.ContainsKey("pass") && payload["pass"] != null ? payload["pass"].ToString() : "";
        string uri = payload["uri"].ToString();
        string filename = payload.ContainsKey("filename") && payload["filename"] != null ? payload["filename"].ToString() : "clip.dav";
        if (!uri.StartsWith("/")) uri = "/" + uri;

        if (!IsSafeCgiUri(uri)) {
          WriteJson(req, res, 400, new Dictionary<string, object> { { "ok", false }, { "error", "Only /cgi-bin/ paths are allowed" } });
          return;
        }

        string targetUrl = scheme + "://" + host + ":" + port + uri;
        try {
          var webReq = (HttpWebRequest)WebRequest.Create(targetUrl);
          webReq.Method = "GET";
          webReq.Timeout = 20000;
          webReq.ReadWriteTimeout = 60000;
          webReq.KeepAlive = false;
          webReq.Credentials = GetCredentialCache(scheme, host, port, user, pass);
          webReq.PreAuthenticate = true;

          using (var webRes = (HttpWebResponse)webReq.GetResponse())
          using (var srcStream = webRes.GetResponseStream()) {
            res.StatusCode = 200;
            ApplyCors(req, res);
            res.ContentType = "application/octet-stream";
            res.Headers["Content-Disposition"] = "attachment; filename=\"" + SanitizeFileName(filename) + "\"";
            if (webRes.ContentLength > 0) res.ContentLength64 = webRes.ContentLength;

            byte[] buffer = new byte[65536];
            int read;
            while ((read = srcStream.Read(buffer, 0, buffer.Length)) > 0) {
              res.OutputStream.Write(buffer, 0, read);
            }
            res.OutputStream.Close();
          }
        } catch (WebException wex) {
          int statusCode = 502;
          string errBody = wex.Message;
          var hr = wex.Response as HttpWebResponse;
          if (hr != null) {
            statusCode = (int)hr.StatusCode;
            try { using (var sr = new StreamReader(hr.GetResponseStream(), Encoding.UTF8)) errBody = sr.ReadToEnd(); } catch { }
          }
          WriteJson(req, res, statusCode, new Dictionary<string, object> { { "ok", false }, { "status", statusCode }, { "error", errBody } });
        }
        return;
      }

      WriteJson(req, res, 404, new Dictionary<string, object> { { "ok", false }, { "error", "Not found" } });
    } catch (Exception ex) {
      WriteJson(req, res, 500, new Dictionary<string, object> { { "ok", false }, { "error", ex.Message } });
    }
  }

  public void Dispose() {
    _running = false;
    try { _listener.Stop(); _listener.Close(); } catch { }
  }
}

class MainForm : Form {
  internal const string AppTitle = "Recorder Viewer";
  internal const string DownloadTitle = AppTitle + " — Đang tải go2rtc…";
  private const string Go2RtcVersion = "v1.9.15";
  private const string Go2RtcArchiveUrl = "https://github.com/AlexxIT/go2rtc/releases/download/" + Go2RtcVersion + "/go2rtc_win64.zip";
  private const int Go2RtcArchiveSize = 8123970;
  private const string Go2RtcArchiveSha256 = "5B448FC90F15C925406D8DA0984301985E385050222C1C2BBDF0A76FE4B1E9CB";
  private const string Go2RtcExeSha256 = "994AA42768D2D6E1BBCF561C85BF9C46CAFA705A90A13537CD38BE2FAEE287DE";
  private readonly string _root;
  private readonly string _dataDir;
  private readonly WebView2 _webView;
  private readonly DahuaProxy _proxy;
  private IntPtr _jobHandle = IntPtr.Zero;
  private Process _go2rtcProc;
  private FormWindowState _prevState = FormWindowState.Normal;
  private Rectangle _prevBounds;
  private bool _wasMinimized;
  private bool _webViewReady;

  public MainForm() {
    _root = AppDomain.CurrentDomain.BaseDirectory;
    _dataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DahuaViewer");
    Directory.CreateDirectory(_dataDir);

    _proxy = new DahuaProxy(Guid.NewGuid().ToString("N"));

    Text = AppTitle;
    BackColor = Color.FromArgb(12, 15, 20);
    Width = 1360;
    Height = 820;
    StartPosition = FormStartPosition.CenterScreen;
    RestoreWindowBounds();
    try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

    _webView = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.FromArgb(12, 15, 20) };
    Controls.Add(_webView);

    Load += async (s, e) => {
      NativeWin.EnableDarkTitleBar(Handle);
      await BootAsync();
    };
    Resize += (s, e) => HandleWindowStateChange();
    FormClosing += (s, e) => {
      SaveWindowBounds();
      Shutdown();
    };
  }

  private string BoundsFile { get { return Path.Combine(_dataDir, "window.json"); } }

  private void RestoreWindowBounds() {
    try {
      if (!File.Exists(BoundsFile)) return;
      var js = new JavaScriptSerializer();
      var d = js.Deserialize<Dictionary<string, object>>(File.ReadAllText(BoundsFile, Encoding.UTF8));
      if (d == null) return;
      int x = Convert.ToInt32(d["x"]);
      int y = Convert.ToInt32(d["y"]);
      int w = Math.Max(800, Convert.ToInt32(d["w"]));
      int h = Math.Max(520, Convert.ToInt32(d["h"]));
      var rect = new Rectangle(x, y, w, h);
      bool onScreen = false;
      foreach (var scr in Screen.AllScreens) {
        if (scr.WorkingArea.IntersectsWith(rect)) { onScreen = true; break; }
      }
      if (onScreen) {
        StartPosition = FormStartPosition.Manual;
        Bounds = rect;
      }
      if (d.ContainsKey("max") && Convert.ToBoolean(d["max"])) {
        WindowState = FormWindowState.Maximized;
      }
    } catch { }
  }

  private void SaveWindowBounds() {
    try {
      Rectangle r = (WindowState == FormWindowState.Normal) ? Bounds : RestoreBounds;
      var d = new Dictionary<string, object> {
        { "x", r.X }, { "y", r.Y }, { "w", r.Width }, { "h", r.Height },
        { "max", WindowState == FormWindowState.Maximized }
      };
      File.WriteAllText(BoundsFile, new JavaScriptSerializer().Serialize(d), new UTF8Encoding(false));
    } catch { }
  }

  private void HandleWindowStateChange() {
    if (!_webViewReady || _webView.CoreWebView2 == null) return;
    bool isMin = (WindowState == FormWindowState.Minimized);
    if (isMin == _wasMinimized) return;
    _wasMinimized = isMin;
    try {
      string js = "window.dispatchEvent(new CustomEvent('app-minimized',{detail:" + (isMin ? "true" : "false") + "}));";
      var _ = _webView.CoreWebView2.ExecuteScriptAsync(js);
    } catch { }
  }

  private static bool IsGo2RtcReady() {
    try {
      var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:1984/api/streams");
      req.Method = "GET";
      req.Timeout = 400;
      req.ReadWriteTimeout = 400;
      using (var res = (HttpWebResponse)req.GetResponse()) {
        return (int)res.StatusCode == 200;
      }
    } catch {
      return false;
    }
  }

  private static string Sha256Hex(Stream contents) {
    using (var sha = SHA256.Create()) {
      return BitConverter.ToString(sha.ComputeHash(contents)).Replace("-", "");
    }
  }

  private static void DownloadGo2Rtc(string exe) {
    byte[] bytes;
    using (var client = new HttpClient(new HttpClientHandler { SslProtocols = SslProtocols.Tls12 })) {
      client.Timeout = TimeSpan.FromSeconds(30);
      client.MaxResponseContentBufferSize = Go2RtcArchiveSize;
      bytes = client.GetByteArrayAsync(Go2RtcArchiveUrl).GetAwaiter().GetResult();
    }
    if (bytes.Length != Go2RtcArchiveSize) {
      throw new InvalidDataException("Tệp tải về không đúng kích thước.");
    }

    Directory.CreateDirectory(Path.GetDirectoryName(exe));
    string staged = exe + "." + Guid.NewGuid().ToString("N") + ".tmp";
    try {
      using (var contents = new MemoryStream(bytes, false)) {
        if (Sha256Hex(contents) != Go2RtcArchiveSha256) {
          throw new InvalidDataException("Không xác minh được tệp tải về.");
        }
        contents.Position = 0;
        using (var archive = new ZipArchive(contents, ZipArchiveMode.Read)) {
          using (var input = archive.GetEntry("go2rtc.exe").Open())
          using (var output = File.Create(staged)) {
            input.CopyTo(output);
          }
        }
      }
      if (File.Exists(exe)) File.Replace(staged, exe, null);
      else File.Move(staged, exe);
    } finally {
      File.Delete(staged);
    }
  }

  private async Task<bool> EnsureGo2RtcAsync() {
    if (IsGo2RtcReady()) return true;

    string cfgPath = Path.Combine(_root, "go2rtc.yaml");
    string exe = Path.Combine(_root, "bin", "go2rtc.exe");
    if (!File.Exists(exe)) {
      exe = Path.Combine(_dataDir, "bin", "go2rtc-" + Go2RtcVersion + ".exe");
      bool verified = false;
      if (File.Exists(exe)) {
        using (var cached = File.OpenRead(exe)) {
          verified = Sha256Hex(cached) == Go2RtcExeSha256;
        }
      }
      if (!verified) {
        var choice = MessageBox.Show(this,
          "Lần đầu mở ứng dụng cần tải go2rtc (khoảng 8 MB) từ GitHub của dự án go2rtc.\n\nBấm Có để tải và tiếp tục.",
          AppTitle, MessageBoxButtons.YesNo, MessageBoxIcon.Information);
        if (choice != DialogResult.Yes) return false;

        Text = DownloadTitle;
        try {
          await Task.Run(() => DownloadGo2Rtc(exe));
        } catch (Exception ex) {
          if (!IsDisposed) MessageBox.Show(this,
            "Không tải được go2rtc. Hãy kiểm tra kết nối Internet rồi mở lại ứng dụng.\n\n" + ex.Message,
            AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Error);
          return false;
        } finally {
          if (!IsDisposed) Text = AppTitle;
        }
        if (IsDisposed) return false;
      }
    }

    _jobHandle = NativeWin.CreateKillOnCloseJob();
    _go2rtcProc = Process.Start(new ProcessStartInfo {
      FileName = exe,
      Arguments = "-c \"" + cfgPath + "\"",
      WorkingDirectory = _root,
      UseShellExecute = false,
      CreateNoWindow = true,
      WindowStyle = ProcessWindowStyle.Hidden
    });
    NativeWin.AttachProcessToJob(_jobHandle, _go2rtcProc);
    return true;
  }

  private async Task BootAsync() {
    try {
      try {
        string ver = CoreWebView2Environment.GetAvailableBrowserVersionString();
        if (string.IsNullOrEmpty(ver)) throw new Exception("Empty version");
      } catch {
        string setup = Path.Combine(_root, "redist", "MicrosoftEdgeWebview2Setup.exe");
        string help = File.Exists(setup)
          ? "Chạy redist\\MicrosoftEdgeWebview2Setup.exe trong thư mục vừa giải nén, rồi mở lại ứng dụng."
          : "Tải tại https://go.microsoft.com/fwlink/p/?LinkId=2124703 rồi mở lại ứng dụng.";
        MessageBox.Show(this, "Máy chưa cài Microsoft Edge WebView2 Runtime.\n\n" + help,
          AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Warning);
        return;
      }

      if (!await EnsureGo2RtcAsync() || IsDisposed) return;

      if (!_proxy.Start(1985)) {
        MessageBox.Show("Cảnh báo: Không khởi động được proxy cục bộ (cổng 1985): " + _proxy.StartupError,
          AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Warning);
      }

      // Wait up to 15 seconds for go2rtc HTTP API (handles first-run Defender scan)
      bool ready = false;
      for (int i = 0; i < 75; i++) {
        if (IsGo2RtcReady()) { ready = true; break; }
        await Task.Delay(200);
      }
      if (!ready) {
        MessageBox.Show("go2rtc chưa phản hồi trên cổng 1984 sau 15 giây.\nHãy đóng ứng dụng rồi mở lại.",
          AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Error);
        return;
      }

      string userData = Path.Combine(_dataDir, "WebView2Profile");
      var opts = new CoreWebView2EnvironmentOptions("--autoplay-policy=no-user-gesture-required --enable-features=PlatformHEVCDecoderSupport");
      var env = await CoreWebView2Environment.CreateAsync(null, userData, opts);
      await _webView.EnsureCoreWebView2Async(env);

      _webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
      _webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
      await _webView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(
        "window.__DAHUA_PROXY_TOKEN__ = '" + _proxy.Token + "';"
      );

      _webView.CoreWebView2.ContainsFullScreenElementChanged += (s, e) => {
        if (_webView.CoreWebView2.ContainsFullScreenElement) {
          _prevState = WindowState;
          _prevBounds = Bounds;
          FormBorderStyle = FormBorderStyle.None;
          WindowState = FormWindowState.Normal;
          Bounds = Screen.FromControl(this).Bounds;
        } else {
          FormBorderStyle = FormBorderStyle.Sizable;
          Bounds = _prevBounds;
          WindowState = _prevState;
        }
      };

      _webViewReady = true;
      _webView.CoreWebView2.Navigate("http://127.0.0.1:1984/?v=2.2");
    } catch (Exception ex) {
      if (!IsDisposed) MessageBox.Show(this, "Lỗi khởi động " + AppTitle + ": " + ex.Message,
        AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Error);
    }
  }

  private void Shutdown() {
    _proxy.Dispose();
    try {
      if (_go2rtcProc != null && !_go2rtcProc.HasExited) _go2rtcProc.Kill();
    } catch { }
    NativeWin.CloseJob(_jobHandle);
    _jobHandle = IntPtr.Zero;
  }
}

static class Program {
  private static Mutex _singleInstance;

  [STAThread]
  static void Main() {
    NativeWin.EnablePerMonitorDpi();

    bool createdNew;
    _singleInstance = new Mutex(true, "Local\\DahuaViewer_SingleInstance_v2", out createdNew);
    if (!createdNew) {
      NativeWin.FocusExistingWindow("Dahua Viewer");
      NativeWin.FocusExistingWindow(MainForm.AppTitle);
      NativeWin.FocusExistingWindow(MainForm.DownloadTitle);
      return;
    }

    try {
      Application.EnableVisualStyles();
      Application.SetCompatibleTextRenderingDefault(false);
      Application.Run(new MainForm());
    } finally {
      try { _singleInstance.ReleaseMutex(); } catch { }
      _singleInstance.Dispose();
    }
  }
}
