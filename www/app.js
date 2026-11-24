import { Go2RtcPlayer } from './player.js?v=2.2';

const PROXY_BASE = 'http://127.0.0.1:1985';
const STORAGE_KEY = 'dahua_viewer_cfg_v1';
const UI_STATE_KEY = 'dahua_viewer_ui_v2';

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');
const fmtTime = (sec) => {
  const s = Math.max(0, Math.min(86399, Math.floor(sec)));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
};
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const shiftDateStr = (dateStr, days) => {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
};

let cfg = null;
let cameras = []; // [{ channel, name }]
let activeTab = 'live';
let layout = 4;
let page = 0;
let prevLayout = 4;
let prevPage = 0;
let fitContain = false;
let globalHd = false;
let selectedChannel = null;
let tileEntries = []; // [{ cam, tile, video, status, hdBtn, muteBtn, player }]
let tileOverrides = new Map(); // channel -> 'hd' | 'sd'

// Auto-pause Live when minimized
let livePausedByMinimize = false;
let minimizePauseTimer = null;

// Playback state
let pbPlayer = null;
let pbSegments = []; // [{ startSec, endSec, motion, filePath }]
let pbPlayheadSec = 0;
let pbAnchorSec = 0;
let pbWindowEndSec = 0;
let pbFirstPts = null;
let pbClockTimer = null;
let pbSessionSeq = 0;
let pbLoadSeq = 0;
let pbSeekDebounce = null;
let pbZoomHours = 24;
let pbViewStartSec = 0;
let pbDayCache = new Map(); // `${ch}|${dateStr}` -> segments
let pbOldestDate = null;
let pbOldestQueried = false;
let pbDownloading = false;

// ---- Persistence ----
function loadCfg() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch { return null; }
}
function saveCfg(c) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(c));
}
function loadUiState() {
  try {
    const s = JSON.parse(localStorage.getItem(UI_STATE_KEY) || 'null');
    if (!s) return;
    if ([1, 4, 9, 16].includes(s.layout)) layout = s.layout;
    fitContain = !!s.fitContain;
    globalHd = !!s.globalHd;
    if (s.sidebarCollapsed) $('sidebar').classList.add('collapsed');
    $('btn-fit').classList.toggle('active', fitContain);
    $('btn-global-hd').textContent = globalHd ? 'HD' : 'SD';
    $('btn-global-hd').classList.toggle('active', globalHd);
    document.querySelectorAll('.lay-btn').forEach((b) => b.classList.toggle('active', Number(b.dataset.layout) === layout));
  } catch {}
}
function saveUiState() {
  try {
    localStorage.setItem(UI_STATE_KEY, JSON.stringify({
      layout,
      fitContain,
      globalHd,
      sidebarCollapsed: $('sidebar').classList.contains('collapsed'),
    }));
  } catch {}
}

// ---- Dahua CGI via local proxy (with per-session token) ----
function proxyHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (window.__DAHUA_PROXY_TOKEN__) {
    h['X-Dahua-Token'] = window.__DAHUA_PROXY_TOKEN__;
  }
  return h;
}

async function dahuaCgi(uri, { config = cfg, timeoutMs = 10000 } = {}) {
  const res = await fetch(`${PROXY_BASE}/cgi`, {
    method: 'POST',
    headers: proxyHeaders(),
    body: JSON.stringify({
      host: config.host,
      port: config.httpPort || 80,
      user: config.user,
      pass: config.pass,
      uri,
      timeoutMs,
    }),
  });
  const data = await res.json();
  if (!data.ok) {
    const err = new Error(`HTTP ${data.status || 'err'}: ${data.body || data.error || ''}`);
    err.status = data.status || res.status || 0;
    throw err;
  }
  return data.body || '';
}

function parseKV(body) {
  const out = {};
  for (const line of String(body).split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > -1) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

// ---- Register RTSP streams in go2rtc (PATCH only — safe in-memory, never calls DELETE) ----
function rtspUrl(channel, subtype) {
  const u = encodeURIComponent(cfg.user);
  const p = encodeURIComponent(cfg.pass);
  return `rtsp://${u}:${p}@${cfg.host}:${cfg.rtspPort || 554}/cam/realmonitor?channel=${channel}&subtype=${subtype}`;
}

async function registerStream(name, src) {
  // PATCH updates source in-memory via SetSource without touching go2rtc.yaml or concurrent DELETE bug
  const url = `/api/streams?name=${encodeURIComponent(name)}&src=${encodeURIComponent(src)}`;
  const res = await fetch(url, { method: 'PATCH' });
  if (!res.ok) throw new Error(`go2rtc stream error ${res.status}`);
}

async function registerAllLiveStreams() {
  // Sequential PATCH is ~30ms total on localhost and avoids concurrent map contention
  for (const cam of cameras) {
    await registerStream(`ch${cam.channel}_sd`, rtspUrl(cam.channel, 1));
    await registerStream(`ch${cam.channel}_hd`, rtspUrl(cam.channel, 0));
  }
}

// ---- Connect (verifies 401 BEFORE opening RTSP streams to prevent Dahua account lockout) ----
async function connectDevice(newCfg) {
  let devModel = '';
  const titles = {};
  let detectedCount = 0;

  // Verify credentials first via lightweight CGI call
  try {
    const devRaw = await dahuaCgi('/cgi-bin/magicBox.cgi?action=getDeviceType', { config: newCfg, timeoutMs: 6000 });
    devModel = parseKV(devRaw).type || '';
  } catch (err) {
    if (err.status === 401) {
      throw new Error('Sai tài khoản hoặc mật khẩu (401) — đã dừng để tránh khóa đầu ghi.');
    }
    // Non-401 (e.g. HTTP port closed/blocked): warn in console, still allow RTSP if user intends
    console.warn('getDeviceType failed:', err.message);
  }

  try {
    const titleRaw = await dahuaCgi('/cgi-bin/configManager.cgi?action=getConfig&name=ChannelTitle', { config: newCfg, timeoutMs: 6000 });
    for (const [k, v] of Object.entries(parseKV(titleRaw))) {
      const m = k.match(/table\.ChannelTitle\[(\d+)\]\.Name/);
      if (m && v) titles[+m[1]] = v;
    }
    detectedCount = Object.keys(titles).length;
  } catch (err) {
    if (err.status === 401) {
      throw new Error('Sai tài khoản hoặc mật khẩu (401) — đã dừng để tránh khóa đầu ghi.');
    }
  }

  cfg = newCfg;
  pbDayCache.clear();
  pbOldestDate = null;
  pbOldestQueried = false;
  $('pb-oldest').classList.add('hidden');

  const count = Math.max(1, Math.min(32, Number(cfg.channels) || detectedCount || 11));
  cameras = [];
  for (let i = 0; i < count; i++) {
    cameras.push({ channel: i + 1, name: titles[i] || `Kênh ${i + 1}` });
  }

  await registerAllLiveStreams();

  $('sb-dev-name').textContent = cfg.name || cfg.host;
  $('sb-cam-count').textContent = `${cameras.length}`;
  $('dev-pill').textContent = `${cfg.name || cfg.host}${devModel ? ` · ${devModel}` : ''} · ${cfg.host}`;

  $('pb-camera').replaceChildren(...cameras.map((c) => {
    const opt = document.createElement('option');
    opt.value = c.channel;
    opt.textContent = `${c.name} (CH${c.channel})`;
    return opt;
  }));

  renderSidebar();
  if (activeTab === 'live') {
    livePausedByMinimize = false;
    $('paused-banner').classList.add('hidden');
    renderLiveGrid();
  } else {
    loadPlaybackDay();
  }
}

// ---- Sidebar ----
function visibleChannels() {
  const start = page * layout;
  return new Set(cameras.slice(start, start + layout).map((c) => c.channel));
}

function renderSidebar() {
  const q = $('cam-search').value.trim().toLowerCase();
  const shown = visibleChannels();
  const list = $('cam-list');
  list.replaceChildren();

  for (const cam of cameras) {
    if (q && !`${cam.name} ch ${cam.channel}`.toLowerCase().includes(q)) continue;
    const item = document.createElement('div');
    item.className = 'cam-item' + (shown.has(cam.channel) ? ' on-screen' : '') + (selectedChannel === cam.channel ? ' selected' : '');

    const dot = document.createElement('span');
    dot.className = 'cam-dot';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'cam-name-txt';
    nameSpan.textContent = cam.name;
    const chSpan = document.createElement('span');
    chSpan.className = 'cam-ch';
    chSpan.textContent = `CH${cam.channel}`;
    item.append(dot, nameSpan, chSpan);

    item.onclick = () => {
      selectedChannel = cam.channel;
      if (activeTab === 'playback') {
        $('pb-camera').value = cam.channel;
        loadPlaybackDay();
      } else {
        const idx = cameras.findIndex((c) => c.channel === cam.channel);
        if (idx >= 0) {
          page = Math.floor(idx / layout);
          renderLiveGrid();
        }
      }
      renderSidebar();
    };
    item.ondblclick = () => {
      if (activeTab !== 'live') switchTab('live');
      maximizeChannel(cam.channel);
    };
    list.append(item);
  }
}
$('cam-search').addEventListener('input', renderSidebar);

// ---- Live Grid ----
function destroyLivePlayers() {
  for (const entry of tileEntries) {
    if (entry.player) entry.player.destroy();
    entry.player = null;
  }
  tileEntries = [];
}

function totalPages() {
  return Math.max(1, Math.ceil(cameras.length / layout));
}

function maximizeChannel(ch) {
  const idx = cameras.findIndex((c) => c.channel === ch);
  if (idx < 0) return;
  if (layout !== 1) {
    prevLayout = layout;
    prevPage = page;
    setLayout(1, idx);
  } else {
    setLayout(prevLayout || 4, prevPage || 0);
  }
}

function setLayout(newLayout, newPage = 0) {
  layout = newLayout;
  const maxP = totalPages() - 1;
  page = Math.max(0, Math.min(maxP, newPage));
  document.querySelectorAll('.lay-btn').forEach((b) => b.classList.toggle('active', Number(b.dataset.layout) === layout));
  saveUiState();
  if (activeTab === 'live') renderLiveGrid();
}

function captureSnapshot(videoEl, label) {
  if (!videoEl || !videoEl.videoWidth) return;
  const c = document.createElement('canvas');
  c.width = videoEl.videoWidth;
  c.height = videoEl.videoHeight;
  c.getContext('2d').drawImage(videoEl, 0, 0);
  const a = document.createElement('a');
  a.href = c.toDataURL('image/jpeg', 0.92);
  a.download = `${label.replace(/[^\w-]+/g, '_')}_${Date.now()}.jpg`;
  a.click();
}

function mountTilePlayer(entry) {
  if (entry.player) {
    entry.player.destroy();
    entry.player = null;
  }
  const useHd = tileOverrides.has(entry.cam.channel)
    ? tileOverrides.get(entry.cam.channel) === 'hd'
    : (layout === 1 || globalHd);
  const srcName = `ch${entry.cam.channel}_${useHd ? 'hd' : 'sd'}`;

  entry.hdBtn.textContent = useHd ? 'HD' : 'SD';
  entry.hdBtn.classList.toggle('hd', useHd);
  entry.status.classList.remove('hidden');
  entry.status.textContent = 'Đang kết nối…';

  entry.player = new Go2RtcPlayer(entry.video, srcName, {
    live: true,
    onState: (st, msg) => {
      if (st === 'playing') {
        entry.status.classList.add('hidden');
      } else if (st === 'connecting') {
        entry.status.classList.remove('hidden');
        entry.status.textContent = 'Đang kết nối…';
      } else if (st === 'reconnecting') {
        entry.status.classList.remove('hidden');
        entry.status.textContent = 'Đang kết nối lại…';
      } else if (st === 'auth_error') {
        entry.status.classList.remove('hidden');
        entry.status.textContent = 'Sai mật khẩu (401) — đã dừng kết nối lại';
      } else if (st === 'codec_error') {
        entry.status.classList.remove('hidden');
        entry.status.textContent = /H265/i.test(msg)
          ? 'Kênh đang dùng H.265 (bấm nút phía trên để đổi sang H.264)'
          : (/MJPEG/i.test(msg) ? 'Kênh đang dùng MJPEG (bấm nút phía trên để đổi sang H.264)' : msg);
        $('codec-banner')?.classList.remove('hidden');
      } else if (st === 'error') {
        entry.status.classList.remove('hidden');
        entry.status.textContent = msg || 'Mất tín hiệu';
      }
    },
  });
}

function renderLiveGrid() {
  destroyLivePlayers();
  $('codec-banner')?.classList.add('hidden');
  const grid = $('live-grid');
  grid.className = `live-grid g-${layout}`;
  grid.replaceChildren();

  const maxP = totalPages();
  if (page >= maxP) page = maxP - 1;
  $('pager-label').textContent = `${page + 1} / ${maxP}`;
  $('btn-prev-page').disabled = page <= 0;
  $('btn-next-page').disabled = page >= maxP - 1;

  const slice = cameras.slice(page * layout, page * layout + layout);

  for (let i = 0; i < layout; i++) {
    const cam = slice[i];
    const tile = document.createElement('div');
    tile.className = 'tile' + (fitContain ? ' fit-contain' : '') + (cam && selectedChannel === cam.channel ? ' active-tile' : '');

    if (!cam) {
      const empty = document.createElement('div');
      empty.className = 'tile-status';
      empty.style.opacity = '.25';
      empty.textContent = 'Trống';
      tile.append(empty);
      grid.append(tile);
      continue;
    }

    const video = document.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;

    const status = document.createElement('div');
    status.className = 'tile-status';
    status.textContent = livePausedByMinimize ? 'Đã tạm dừng khi thu nhỏ' : 'Đang kết nối…';

    const overlay = document.createElement('div');
    overlay.className = 'tile-overlay';
    const nameEl = document.createElement('span');
    nameEl.className = 'tile-name';
    nameEl.textContent = `${cam.name} · CH${cam.channel}`;

    const hdBtn = document.createElement('button');
    hdBtn.className = 'tile-badge';
    hdBtn.title = 'Đổi luồng chính (HD) / luồng phụ (SD) chỉ riêng kênh này';

    const muteBtn = document.createElement('button');
    muteBtn.className = 'tile-act';
    muteBtn.textContent = '🔇';
    muteBtn.title = 'Bật / tắt âm thanh';
    muteBtn.onclick = (e) => {
      e.stopPropagation();
      video.muted = !video.muted;
      muteBtn.textContent = video.muted ? '🔇' : '🔊';
      muteBtn.classList.toggle('active', !video.muted);
    };

    const pbBtn = document.createElement('button');
    pbBtn.className = 'tile-act';
    pbBtn.textContent = '⏪';
    pbBtn.title = 'Xem lại kênh này';
    pbBtn.onclick = (e) => {
      e.stopPropagation();
      selectedChannel = cam.channel;
      $('pb-camera').value = cam.channel;
      switchTab('playback');
    };

    const snapBtn = document.createElement('button');
    snapBtn.className = 'tile-act';
    snapBtn.textContent = '📷';
    snapBtn.title = 'Chụp ảnh';
    snapBtn.onclick = (e) => { e.stopPropagation(); captureSnapshot(video, cam.name); };

    const maxBtn = document.createElement('button');
    maxBtn.className = 'tile-act';
    maxBtn.textContent = layout === 1 ? '⊞' : '⤢';
    maxBtn.title = layout === 1 ? 'Quay lại lưới' : 'Phóng to HD';
    maxBtn.onclick = (e) => { e.stopPropagation(); maximizeChannel(cam.channel); };

    const sp = document.createElement('span');
    sp.className = 'spacer';
    overlay.append(nameEl, hdBtn, sp, muteBtn, pbBtn, snapBtn, maxBtn);

    const corner = document.createElement('div');
    corner.className = 'tile-corner';
    corner.textContent = cam.name;

    tile.append(video, status, overlay, corner);
    tile.onclick = () => {
      selectedChannel = cam.channel;
      grid.querySelectorAll('.tile').forEach((t) => t.classList.remove('active-tile'));
      tile.classList.add('active-tile');
      renderSidebar();
    };
    tile.ondblclick = () => maximizeChannel(cam.channel);

    grid.append(tile);

    const entry = { cam, tile, video, status, hdBtn, muteBtn, player: null };
    // Toggle HD/SD for ONLY this tile without resetting the other tiles
    hdBtn.onclick = (e) => {
      e.stopPropagation();
      const curHd = tileOverrides.has(cam.channel)
        ? tileOverrides.get(cam.channel) === 'hd'
        : (layout === 1 || globalHd);
      tileOverrides.set(cam.channel, curHd ? 'sd' : 'hd');
      mountTilePlayer(entry);
    };

    tileEntries.push(entry);
    if (!livePausedByMinimize) {
      mountTilePlayer(entry);
    }
  }
  renderSidebar();
}

// ---- Auto-pause Live when window is minimized (saves CPU & Tailscale bandwidth) ----
function handleAppMinimized(isMin) {
  clearTimeout(minimizePauseTimer);
  if (isMin) {
    if (activeTab !== 'live' || !cameras.length || livePausedByMinimize) return;
    minimizePauseTimer = setTimeout(() => {
      if (activeTab !== 'live') return;
      livePausedByMinimize = true;
      for (const entry of tileEntries) {
        if (entry.player) {
          entry.player.destroy();
          entry.player = null;
        }
        entry.status.classList.remove('hidden');
        entry.status.textContent = 'Đã tạm dừng khi thu nhỏ';
      }
      $('paused-banner').classList.remove('hidden');
    }, 2000);
  } else {
    if (livePausedByMinimize) {
      resumeLiveFromMinimize();
    }
  }
}

function resumeLiveFromMinimize() {
  livePausedByMinimize = false;
  $('paused-banner').classList.add('hidden');
  if (activeTab === 'live' && cameras.length) {
    for (const entry of tileEntries) {
      if (!entry.player) mountTilePlayer(entry);
    }
  }
}

window.addEventListener('app-minimized', (e) => handleAppMinimized(!!e.detail));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) handleAppMinimized(true);
  else handleAppMinimized(false);
});
$('btn-resume-live').onclick = resumeLiveFromMinimize;

// ---- Playback (Dahua RTSP Playback + CGI Timeline + Clip Export) ----
function stopPlayback() {
  pbSessionSeq++;
  clearTimeout(pbSeekDebounce);
  clearInterval(pbClockTimer);
  pbClockTimer = null;
  pbFirstPts = null;
  if (pbPlayer) {
    pbPlayer.destroy();
    pbPlayer = null;
  }
}

function parseDahuaDateTimeSec(str, targetDate) {
  // Format: "YYYY-MM-DD HH:MM:SS"
  const m = String(str || '').match(/(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{1,2}):(\d{1,2})/);
  if (!m) return null;
  const d = m[1];
  if (d < targetDate) return 0;
  if (d > targetDate) return 86399;
  return (+m[2]) * 3600 + (+m[3]) * 60 + (+m[4]);
}

async function findRecordings(channel, dateStr) {
  const createRes = parseKV(await dahuaCgi('/cgi-bin/mediaFileFind.cgi?action=factory.create'));
  const obj = (createRes.result || '').trim();
  if (!obj) throw new Error('Không tạo được phiên mediaFileFind');
  const start = `${dateStr} 00:00:00`;
  const end = `${dateStr} 23:59:59`;
  const items = [];
  try {
    // Dahua HTTP API §4.10.5: condition.Channel is 1-based, Types[0]=dav filters out jpg snapshots
    const q = `/cgi-bin/mediaFileFind.cgi?action=findFile&object=${encodeURIComponent(obj)}`
      + `&condition.Channel=${channel}`
      + `&condition.StartTime=${encodeURIComponent(start)}`
      + `&condition.EndTime=${encodeURIComponent(end)}`
      + `&condition.Types[0]=dav`;
    await dahuaCgi(q);
    for (let g = 0; g < 100; g++) {
      const kv = parseKV(await dahuaCgi(`/cgi-bin/mediaFileFind.cgi?action=findNextFile&object=${encodeURIComponent(obj)}&count=100`));
      const found = parseInt(kv.found, 10) || 0;
      if (!found) break;
      const byIdx = {};
      for (const [k, v] of Object.entries(kv)) {
        const m = k.match(/items\[(\d+)\]\.(.+)/);
        if (m) (byIdx[m[1]] ||= {})[m[2]] = v;
      }
      for (const it of Object.values(byIdx)) {
        if (!it.StartTime || !it.EndTime) continue;
        const s = parseDahuaDateTimeSec(it.StartTime, dateStr);
        const e = parseDahuaDateTimeSec(it.EndTime, dateStr);
        if (s === null || e === null) continue;
        const endSec = Math.max(s + 1, e);
        const evs = Object.keys(it)
          .filter((k) => k.startsWith('Events[') || k.startsWith('Flags['))
          .map((k) => it[k]);
        const filePath = it.FilePath || '';
        items.push({
          startSec: s,
          endSec,
          motion: evs.some((ev) => /motion|smartmotion|^MD$|alarm|event/i.test(ev)) || /\[M\]|\[A\]/i.test(filePath),
          filePath,
        });
      }
      if (found < 100) break;
    }
  } finally {
    // Run close then destroy sequentially
    try { await dahuaCgi(`/cgi-bin/mediaFileFind.cgi?action=close&object=${encodeURIComponent(obj)}`, { timeoutMs: 4000 }); } catch {}
    try { await dahuaCgi(`/cgi-bin/mediaFileFind.cgi?action=destroy&object=${encodeURIComponent(obj)}`, { timeoutMs: 4000 }); } catch {}
  }
  items.sort((a, b) => a.startSec - b.startSec);
  return items;
}

async function queryOldestRecordingDate(channel) {
  if (pbOldestQueried || !cfg) return;
  pbOldestQueried = true;
  let obj = '';
  try {
    const createRes = parseKV(await dahuaCgi('/cgi-bin/mediaFileFind.cgi?action=factory.create', { timeoutMs: 5000 }));
    obj = (createRes.result || '').trim();
    if (!obj) return;
    const end = `${todayStr()} 23:59:59`;
    const q = `/cgi-bin/mediaFileFind.cgi?action=findFile&object=${encodeURIComponent(obj)}`
      + `&condition.Channel=${channel}`
      + `&condition.StartTime=${encodeURIComponent('2015-01-01 00:00:00')}`
      + `&condition.EndTime=${encodeURIComponent(end)}`
      + `&condition.Types[0]=dav`;
    await dahuaCgi(q, { timeoutMs: 8000 });
    const kv = parseKV(await dahuaCgi(`/cgi-bin/mediaFileFind.cgi?action=findNextFile&object=${encodeURIComponent(obj)}&count=1`, { timeoutMs: 6000 }));
    const st = kv['items[0].StartTime'] || '';
    const m = st.match(/(\d{4}-\d{2}-\d{2})/);
    if (m) {
      pbOldestDate = m[1];
      const btn = $('pb-oldest');
      btn.textContent = `Cũ nhất: ${pbOldestDate}`;
      btn.classList.remove('hidden');
    }
  } catch {
    // Non-critical helper
  } finally {
    if (obj) {
      try { await dahuaCgi(`/cgi-bin/mediaFileFind.cgi?action=close&object=${encodeURIComponent(obj)}`, { timeoutMs: 3000 }); } catch {}
      try { await dahuaCgi(`/cgi-bin/mediaFileFind.cgi?action=destroy&object=${encodeURIComponent(obj)}`, { timeoutMs: 3000 }); } catch {}
    }
  }
}

function centerTimelineOn(sec) {
  const span = pbZoomHours * 3600;
  if (span >= 86400) {
    pbViewStartSec = 0;
  } else {
    pbViewStartSec = Math.max(0, Math.min(86400 - span, sec - span / 2));
  }
}

function drawTimeline() {
  const canvas = $('timeline-canvas');
  if (!canvas || !canvas.parentElement) return;
  const rect = canvas.parentElement.getBoundingClientRect();
  if (rect.width < 10 || rect.height < 10) return;

  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const w = rect.width;
  const h = rect.height;

  const viewSpan = pbZoomHours * 3600;
  const viewStart = pbViewStartSec;
  const viewEnd = viewStart + viewSpan;
  const toX = (s) => ((s - viewStart) / viewSpan) * w;

  ctx.fillStyle = '#0c0f14';
  ctx.fillRect(0, 0, w, h);

  // Recorded segments
  for (const seg of pbSegments) {
    if (seg.endSec < viewStart || seg.startSec > viewEnd) continue;
    const x1 = Math.max(0, toX(seg.startSec));
    const x2 = Math.min(w, Math.max(x1 + 1.5, toX(seg.endSec)));
    ctx.fillStyle = seg.motion ? '#f59e0b' : '#2563eb';
    ctx.fillRect(x1, 16, x2 - x1, h - 20);
  }

  // Adaptive ticks
  ctx.fillStyle = '#64748b';
  ctx.font = '10px Consolas, monospace';
  const step = pbZoomHours >= 24 ? 7200 : pbZoomHours >= 6 ? 1800 : pbZoomHours >= 1 ? 300 : 60;
  const firstTick = Math.ceil(viewStart / step) * step;
  for (let s = firstTick; s <= viewEnd; s += step) {
    const x = Math.round(toX(s));
    ctx.fillRect(x, 0, 1, 11);
    if (x < w - 36) {
      const lbl = pbZoomHours < 1 ? fmtTime(s) : fmtTime(s).slice(0, 5);
      ctx.fillText(lbl, x + 3, 11);
    }
  }

  // Playhead
  if (pbPlayheadSec >= viewStart && pbPlayheadSec <= viewEnd && pbPlayheadSec >= 0) {
    const px = toX(pbPlayheadSec);
    ctx.fillStyle = '#ef4444';
    ctx.fillRect(px - 1, 0, 2, h);
  }
}

function renderSegmentDrawer() {
  $('pb-seg-count').textContent = String(pbSegments.length);
  const list = $('pb-seg-list');
  list.replaceChildren();
  for (const seg of pbSegments) {
    const row = document.createElement('div');
    row.className = 'seg-item' + (seg.motion ? ' motion' : '');
    const lbl = document.createElement('span');
    lbl.textContent = `${fmtTime(seg.startSec)} → ${fmtTime(seg.endSec)}`;
    const tag = document.createElement('span');
    tag.className = 'seg-tag';
    tag.textContent = seg.motion ? 'Motion' : 'Ghi';
    const dl = document.createElement('button');
    dl.className = 'seg-dl';
    dl.textContent = '⬇';
    dl.title = 'Tải đoạn này (.dav)';
    dl.onclick = (e) => {
      e.stopPropagation();
      downloadClipRange(seg.startSec, Math.min(seg.endSec, seg.startSec + 1200));
    };
    row.append(lbl, tag, dl);
    row.onclick = () => requestSeek(seg.startSec, true);
    list.append(row);
  }
}

async function loadPlaybackDay(forceRefresh = false) {
  if (!cfg) return;
  const myLoadSeq = ++pbLoadSeq;
  stopPlayback();

  const ch = Number($('pb-camera').value) || 1;
  const dateStr = $('pb-date').value || todayStr();
  const cacheKey = `${ch}|${dateStr}`;
  const isPastDay = dateStr < todayStr();

  $('pb-info').textContent = 'Đang tải lịch sử…';
  pbSegments = [];
  renderSegmentDrawer();
  drawTimeline();

  queryOldestRecordingDate(ch);

  try {
    let segs;
    if (!forceRefresh && isPastDay && pbDayCache.has(cacheKey)) {
      segs = pbDayCache.get(cacheKey);
    } else {
      segs = await findRecordings(ch, dateStr);
      if (myLoadSeq !== pbLoadSeq) return; // stale request
      if (isPastDay) pbDayCache.set(cacheKey, segs);
    }
    if (myLoadSeq !== pbLoadSeq) return;

    pbSegments = segs;
    const motionCnt = segs.filter((s) => s.motion).length;
    $('pb-info').textContent = segs.length
      ? `${segs.length} đoạn${motionCnt ? ` (${motionCnt} motion)` : ''}`
      : 'Không có bản ghi (vẫn có thể click timeline để thử)';
  } catch (e) {
    if (myLoadSeq !== pbLoadSeq) return;
    $('pb-info').textContent = e.status === 401
      ? 'Sai mật khẩu (401)'
      : 'Lỗi đọc danh sách file — vẫn có thể click timeline để phát RTSP';
  }
  renderSegmentDrawer();
  drawTimeline();
}

function snapToNearestSegment(sec) {
  if (!pbSegments.length) return { sec, snapped: false };
  // Inside a segment?
  for (const seg of pbSegments) {
    if (sec >= seg.startSec && sec <= seg.endSec) return { sec, snapped: false };
  }
  // Otherwise jump to next available segment (or last segment if past all)
  for (const seg of pbSegments) {
    if (seg.startSec > sec) return { sec: seg.startSec, snapped: true };
  }
  const last = pbSegments[pbSegments.length - 1];
  return { sec: Math.max(last.startSec, last.endSec - 30), snapped: true };
}

function tryBufferedSeek(targetSec) {
  if (!pbPlayer || pbFirstPts === null) return false;
  const video = $('pb-video');
  if (!video || !video.buffered || video.buffered.length === 0) return false;
  const desiredVideoTime = pbFirstPts + (targetSec - pbAnchorSec);
  for (let i = 0; i < video.buffered.length; i++) {
    const bStart = video.buffered.start(i);
    const bEnd = video.buffered.end(i);
    if (desiredVideoTime >= bStart + 0.15 && desiredVideoTime <= bEnd - 0.5) {
      video.currentTime = desiredVideoTime;
      pbPlayheadSec = targetSec;
      const dateStr = $('pb-date').value || todayStr();
      $('pb-clock').textContent = `${dateStr} ${fmtTime(pbPlayheadSec)}`;
      $('pb-jump-time').value = fmtTime(pbPlayheadSec);
      drawTimeline();
      return true;
    }
  }
  return false;
}

function requestSeek(sec, immediate = false) {
  const clamped = Math.max(0, Math.min(86390, Math.floor(sec)));
  // Instant 0ms seek inside already-buffered MSE range!
  if (tryBufferedSeek(clamped)) return;

  pbPlayheadSec = clamped;
  $('pb-jump-time').value = fmtTime(clamped);
  const dateStr = $('pb-date').value || todayStr();
  $('pb-clock').textContent = `${dateStr} ${fmtTime(clamped)}`;
  drawTimeline();

  clearTimeout(pbSeekDebounce);
  const delay = immediate ? 0 : 250;
  pbSeekDebounce = setTimeout(() => playAt(clamped), delay);
}

async function playAt(rawSec) {
  if (!cfg || activeTab !== 'playback') return;
  stopPlayback();
  const mySeq = ++pbSessionSeq;

  const { sec, snapped } = snapToNearestSegment(Math.max(0, Math.min(86390, Math.floor(rawSec))));
  const ch = Number($('pb-camera').value) || 1;
  const dateStr = $('pb-date').value || todayStr();
  pbPlayheadSec = sec;
  pbAnchorSec = sec;
  pbFirstPts = null;
  pbWindowEndSec = Math.min(86399, sec + 3600);
  $('pb-jump-time').value = fmtTime(sec);
  centerTimelineOn(sec);
  drawTimeline();

  const [Y, M, D] = dateStr.split('-');
  const startFmt = `${Y}_${M}_${D}_${fmtTime(sec).replace(/:/g, '_')}`;
  const endFmt = `${Y}_${M}_${D}_${fmtTime(pbWindowEndSec).replace(/:/g, '_')}`;

  const u = encodeURIComponent(cfg.user);
  const p = encodeURIComponent(cfg.pass);
  const src = `rtsp://${u}:${p}@${cfg.host}:${cfg.rtspPort || 554}/cam/playback?channel=${ch}&subtype=0&starttime=${startFmt}&endtime=${endFmt}`;
  const streamName = 'pb_active';

  const status = $('pb-status');
  status.classList.remove('hidden');
  status.textContent = snapped
    ? `Nhảy tới đoạn ghi gần nhất ${fmtTime(sec)}…`
    : `Đang mở ${fmtTime(sec)}…`;
  $('pb-clock').textContent = `${dateStr} ${fmtTime(sec)}`;

  try {
    await registerStream(streamName, src);
  } catch (e) {
    if (mySeq !== pbSessionSeq || activeTab !== 'playback') return;
    status.textContent = `Lỗi kết nối go2rtc: ${e.message}`;
    return;
  }

  // Abort if user seeked again or switched tab while awaiting PATCH
  if (mySeq !== pbSessionSeq || activeTab !== 'playback') return;

  const video = $('pb-video');
  pbPlayer = new Go2RtcPlayer(video, streamName, {
    live: false,
    onState: (st, msg) => {
      if (mySeq !== pbSessionSeq) return;
      if (st === 'playing') {
        status.classList.add('hidden');
        if (pbFirstPts === null && !isNaN(video.currentTime)) {
          pbFirstPts = video.currentTime;
        }
      } else if (st === 'auth_error') {
        status.classList.remove('hidden');
        status.textContent = 'Sai mật khẩu (401) — kiểm tra lại cài đặt đầu ghi';
      } else if (st === 'codec_error') {
        status.classList.remove('hidden');
        status.textContent = 'Bản ghi này là H.265 — cần đổi Main stream sang H.264 (áp dụng cho bản ghi mới) hoặc bật HEVC trên Windows.';
      } else if (st === 'error') {
        status.classList.remove('hidden');
        status.textContent = msg || 'Không phát được đoạn này';
      } else if (st === 'ended') {
        // Auto-continue to next window or next segment if not at end of day
        if (pbPlayheadSec < 86385) {
          const nextSeg = pbSegments.find((s) => s.startSec > pbPlayheadSec + 2);
          const nextSec = (pbPlayheadSec >= pbWindowEndSec - 15)
            ? pbWindowEndSec + 1
            : (nextSeg ? nextSeg.startSec : null);
          if (nextSec !== null && nextSec < 86390) {
            playAt(nextSec);
            return;
          }
        }
        status.classList.remove('hidden');
        status.textContent = msg || 'Hết đoạn phát';
      }
    },
  });

  pbClockTimer = setInterval(() => {
    if (mySeq !== pbSessionSeq) return;
    if (!video.paused && !isNaN(video.currentTime)) {
      if (pbFirstPts === null && video.readyState >= 2) pbFirstPts = video.currentTime;
      const elapsed = pbFirstPts !== null ? Math.max(0, video.currentTime - pbFirstPts) : video.currentTime;
      pbPlayheadSec = Math.min(86399, pbAnchorSec + elapsed);
      $('pb-clock').textContent = `${dateStr} ${fmtTime(pbPlayheadSec)}`;
      drawTimeline();
    }
  }, 500);
}

// ---- Clip Download (.dav streaming via DahuaProxy /download) ----
async function downloadClipRange(startSec, endSec) {
  if (!cfg || pbDownloading) return;
  const ch = Number($('pb-camera').value) || 1;
  const dateStr = $('pb-date').value || todayStr();
  const s = Math.max(0, Math.min(86390, Math.floor(startSec)));
  const e = Math.max(s + 5, Math.min(86399, Math.floor(endSec)));

  const startTime = `${dateStr} ${fmtTime(s)}`;
  const endTime = `${dateStr} ${fmtTime(e)}`;
  const uri = `/cgi-bin/loadfile.cgi?action=startLoad&channel=${ch}`
    + `&startTime=${encodeURIComponent(startTime)}`
    + `&endTime=${encodeURIComponent(endTime)}&subtype=0`;
  const filename = `CH${ch}_${dateStr}_${fmtTime(s).replace(/:/g, '-')}_to_${fmtTime(e).replace(/:/g, '-')}.dav`;

  const btn = $('pb-download');
  const info = $('pb-info');
  pbDownloading = true;
  btn.disabled = true;
  btn.textContent = 'Đang tải…';
  info.textContent = `Đang tải clip ${fmtTime(s)} → ${fmtTime(e)}…`;

  try {
    const res = await fetch(`${PROXY_BASE}/download`, {
      method: 'POST',
      headers: proxyHeaders(),
      body: JSON.stringify({
        host: cfg.host,
        port: cfg.httpPort || 80,
        user: cfg.user,
        pass: cfg.pass,
        uri,
        filename,
      }),
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const j = await res.json(); msg = j.error || msg; } catch {}
      throw new Error(msg);
    }
    const blob = await res.blob();
    if (!blob.size) throw new Error('Đầu ghi trả về file rỗng (không có bản ghi trong khoảng này)');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    const mb = (blob.size / (1024 * 1024)).toFixed(1);
    info.textContent = `Đã tải ${filename} (${mb} MB)`;
  } catch (err) {
    info.textContent = `Lỗi tải clip: ${err.message}`;
  } finally {
    pbDownloading = false;
    btn.disabled = false;
    btn.textContent = '⬇ Tải clip';
  }
}

// ---- Timeline Mouse, Zoom & Drag Interaction ----
const tlWrap = $('timeline-wrap');
const tlTip = $('timeline-tip');
let tlDragging = false;
let tlDragMoved = false;
let tlDragStartX = 0;
let tlDragStartView = 0;

function secFromEvent(e) {
  const r = tlWrap.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  return Math.floor(pbViewStartSec + ratio * pbZoomHours * 3600);
}

tlWrap.addEventListener('mousedown', (e) => {
  if (pbZoomHours < 24) {
    tlDragging = true;
    tlDragMoved = false;
    tlDragStartX = e.clientX;
    tlDragStartView = pbViewStartSec;
  }
});
window.addEventListener('mousemove', (e) => {
  if (!tlDragging) return;
  const dx = e.clientX - tlDragStartX;
  if (Math.abs(dx) > 4) tlDragMoved = true;
  const r = tlWrap.getBoundingClientRect();
  const span = pbZoomHours * 3600;
  const deltaSec = -(dx / Math.max(1, r.width)) * span;
  pbViewStartSec = Math.max(0, Math.min(86400 - span, tlDragStartView + deltaSec));
  drawTimeline();
});
window.addEventListener('mouseup', () => { tlDragging = false; });

tlWrap.addEventListener('mousemove', (e) => {
  const sec = secFromEvent(e);
  const r = tlWrap.getBoundingClientRect();
  tlTip.textContent = fmtTime(sec);
  tlTip.style.left = `${Math.max(32, Math.min(r.width - 32, e.clientX - r.left))}px`;
  tlTip.classList.remove('hidden');
});
tlWrap.addEventListener('mouseleave', () => tlTip.classList.add('hidden'));
tlWrap.addEventListener('click', (e) => {
  if (tlDragMoved) { tlDragMoved = false; return; }
  requestSeek(secFromEvent(e), true);
});
tlWrap.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (pbZoomHours >= 24) return;
  const span = pbZoomHours * 3600;
  const shift = (e.deltaY > 0 ? 1 : -1) * Math.max(60, span * 0.15);
  pbViewStartSec = Math.max(0, Math.min(86400 - span, pbViewStartSec + shift));
  drawTimeline();
}, { passive: false });

document.querySelectorAll('.zoom-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.zoom-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    pbZoomHours = Number(btn.dataset.zoom) || 24;
    centerTimelineOn(pbPlayheadSec || 43200);
    drawTimeline();
  });
});

// ---- Playback Control Bindings ----
$('pb-load').onclick = () => loadPlaybackDay(true);
$('pb-camera').onchange = () => loadPlaybackDay(false);
$('pb-date').onchange = () => loadPlaybackDay(false);
$('pb-prev-day').onclick = () => {
  $('pb-date').value = shiftDateStr($('pb-date').value || todayStr(), -1);
  loadPlaybackDay(false);
};
$('pb-next-day').onclick = () => {
  const next = shiftDateStr($('pb-date').value || todayStr(), 1);
  if (next <= todayStr()) {
    $('pb-date').value = next;
    loadPlaybackDay(false);
  }
};
$('pb-today').onclick = () => {
  $('pb-date').value = todayStr();
  loadPlaybackDay(true);
};
$('pb-oldest').onclick = () => {
  if (!pbOldestDate) return;
  $('pb-date').value = pbOldestDate;
  loadPlaybackDay(false);
};

$('pb-toggle').onclick = () => {
  const v = $('pb-video');
  if (v.paused) v.play().catch(() => {}); else v.pause();
};
$('pb-back10').onclick = () => requestSeek(pbPlayheadSec - 10);
$('pb-fwd10').onclick = () => requestSeek(pbPlayheadSec + 10);
$('pb-back60').onclick = () => requestSeek(pbPlayheadSec - 60);
$('pb-fwd60').onclick = () => requestSeek(pbPlayheadSec + 60);

$('pb-prev-seg').onclick = () => {
  const prev = [...pbSegments].reverse().find((s) => s.startSec < pbPlayheadSec - 3);
  if (prev) requestSeek(prev.startSec, true);
};
$('pb-next-seg').onclick = () => {
  const next = pbSegments.find((s) => s.startSec > pbPlayheadSec + 3);
  if (next) requestSeek(next.startSec, true);
};
$('pb-prev-motion').onclick = () => {
  const prev = [...pbSegments].reverse().find((s) => s.motion && s.startSec < pbPlayheadSec - 3);
  if (prev) requestSeek(prev.startSec, true);
  else $('pb-info').textContent = 'Không có sự kiện chuyển động trước mốc này';
};
$('pb-next-motion').onclick = () => {
  const next = pbSegments.find((s) => s.motion && s.startSec > pbPlayheadSec + 3);
  if (next) requestSeek(next.startSec, true);
  else $('pb-info').textContent = 'Không có sự kiện chuyển động sau mốc này';
};

$('pb-jump-btn').onclick = () => {
  const val = $('pb-jump-time').value || '00:00:00';
  const parts = val.split(':').map((x) => parseInt(x, 10) || 0);
  const sec = parts[0] * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
  requestSeek(sec, true);
};

$('pb-mute').onclick = () => {
  const v = $('pb-video');
  v.muted = !v.muted;
  $('pb-mute').textContent = v.muted ? '🔇' : '🔊';
};
$('pb-snap').onclick = () => captureSnapshot($('pb-video'), `playback_ch${$('pb-camera').value}`);
$('pb-download').onclick = () => {
  const mins = Number($('pb-export-mins').value) || 5;
  downloadClipRange(pbPlayheadSec, pbPlayheadSec + mins * 60);
};
$('pb-clips-btn').onclick = () => {
  $('pb-drawer').classList.toggle('hidden');
  setTimeout(drawTimeline, 50);
};
$('pb-drawer-close').onclick = () => {
  $('pb-drawer').classList.add('hidden');
  setTimeout(drawTimeline, 50);
};

// ---- Tabs & Global Controls ----
function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('view-live').classList.toggle('hidden', tab !== 'live');
  $('view-playback').classList.toggle('hidden', tab !== 'playback');
  if (tab === 'live') {
    stopPlayback();
    livePausedByMinimize = false;
    $('paused-banner').classList.add('hidden');
    if (cameras.length) renderLiveGrid();
  } else {
    destroyLivePlayers();
    if (!$('pb-date').value) $('pb-date').value = todayStr();
    if (cameras.length) loadPlaybackDay(false);
    setTimeout(drawTimeline, 50);
  }
}
document.querySelectorAll('.tab-btn').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

$('btn-sidebar').onclick = () => {
  $('sidebar').classList.toggle('collapsed');
  saveUiState();
  if (activeTab === 'playback') setTimeout(drawTimeline, 160);
};
$('btn-prev-page').onclick = () => { if (page > 0) { page--; renderLiveGrid(); } };
$('btn-next-page').onclick = () => { if (page < totalPages() - 1) { page++; renderLiveGrid(); } };
document.querySelectorAll('.lay-btn').forEach((b) => b.addEventListener('click', () => setLayout(Number(b.dataset.layout), 0)));

$('btn-fit').onclick = () => {
  fitContain = !fitContain;
  $('btn-fit').classList.toggle('active', fitContain);
  document.querySelectorAll('.tile').forEach((t) => t.classList.toggle('fit-contain', fitContain));
  saveUiState();
};
$('btn-global-hd').onclick = () => {
  globalHd = !globalHd;
  tileOverrides.clear();
  $('btn-global-hd').textContent = globalHd ? 'HD' : 'SD';
  $('btn-global-hd').classList.toggle('active', globalHd);
  saveUiState();
  if (activeTab === 'live') renderLiveGrid();
};
$('btn-fullscreen').onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
};

async function convertStreamsToH264(includeMain) {
  const bSub = $('btn-fix-h264-sub');
  const bAll = $('btn-fix-h264-all');
  const txt = $('codec-banner-text');
  const defaultTxt = 'Đầu ghi đang phát H.265/MJPEG mà Windows chưa có codec HEVC.';
  if (bSub) bSub.disabled = true;
  if (bAll) bAll.disabled = true;
  let okCount = 0;
  let lastErr = '';
  try {
    for (let i = 0; i < cameras.length; i++) {
      if (txt) txt.textContent = `Đang chuyển Kênh ${i + 1}/${cameras.length} sang H.264…`;
      let uri = `/cgi-bin/configManager.cgi?action=setConfig`
        + `&Encode[${i}].ExtraFormat[0].Video.Compression=H.264`
        + `&Encode[${i}].ExtraFormat[0].Video.FPS=15`
        + `&Encode[${i}].ExtraFormat[0].Video.BitRate=512`;
      if (includeMain) {
        uri += `&Encode[${i}].MainFormat[0].Video.Compression=H.264`;
      }
      try {
        await dahuaCgi(uri);
        okCount++;
      } catch (e) {
        lastErr = e?.message || '';
      }
    }
    if (okCount === 0) {
      if (txt) txt.textContent = 'Không đổi được cấu hình đầu ghi: ' + (lastErr || 'kiểm tra quyền tài khoản admin');
      return;
    }
    if (txt) txt.textContent = 'Đang khởi động lại luồng trên đầu ghi…';
    await new Promise((r) => setTimeout(r, 1500));
    await registerAllLiveStreams();
    $('codec-banner')?.classList.add('hidden');
    if (txt) txt.textContent = defaultTxt;
    renderLiveGrid();
  } finally {
    if (bSub) bSub.disabled = false;
    if (bAll) bAll.disabled = false;
  }
}

$('btn-fix-h264-sub').onclick = () => convertStreamsToH264(false);
$('btn-fix-h264-all').onclick = () => convertStreamsToH264(true);

// ---- Settings & Hotkeys Modals ----
function openSettings(errMsg = '') {
  if (cfg) {
    $('cfg-name').value = cfg.name || '';
    $('cfg-host').value = cfg.host || '';
    $('cfg-channels').value = cfg.channels || 11;
    $('cfg-http').value = cfg.httpPort || 80;
    $('cfg-rtsp').value = cfg.rtspPort || 554;
    $('cfg-user').value = cfg.user || 'admin';
    $('cfg-pass').value = cfg.pass || '';
  }
  $('cfg-err').textContent = errMsg;
  $('modal-settings').classList.remove('hidden');
  $('cfg-pass').focus();
}

$('btn-settings').onclick = () => openSettings();
$('cfg-cancel').onclick = () => $('modal-settings').classList.add('hidden');
$('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('cfg-err').textContent = '';
  const btn = $('cfg-save');
  btn.disabled = true; btn.textContent = 'Đang kết nối…';
  try {
    const newCfg = {
      name: $('cfg-name').value.trim() || 'Dahua NVR',
      host: $('cfg-host').value.trim(),
      channels: Number($('cfg-channels').value) || 11,
      httpPort: Number($('cfg-http').value) || 80,
      rtspPort: Number($('cfg-rtsp').value) || 554,
      user: $('cfg-user').value.trim(),
      pass: $('cfg-pass').value,
    };
    await connectDevice(newCfg);
    saveCfg(newCfg);
    $('modal-settings').classList.add('hidden');
  } catch (err) {
    const m = err?.message || '';
    $('cfg-err').textContent = /Failed to fetch/i.test(m)
      ? 'go2rtc hoặc proxy chưa chạy. Hãy đóng cửa sổ và mở lại RecorderViewer.exe.'
      : (m || 'Không kết nối được');
  } finally {
    btn.disabled = false; btn.textContent = 'Kết nối';
  }
});

$('btn-hotkeys').onclick = () => $('modal-hotkeys').classList.remove('hidden');
$('hk-close').onclick = () => $('modal-hotkeys').classList.add('hidden');
$('modal-hotkeys').onclick = (e) => { if (e.target.id === 'modal-hotkeys') $('modal-hotkeys').classList.add('hidden'); };

// ---- Keyboard Shortcuts ----
document.addEventListener('keydown', (e) => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
  if (e.key === 'Escape') {
    $('modal-hotkeys').classList.add('hidden');
    if (cfg) $('modal-settings').classList.add('hidden');
    if (activeTab === 'live' && layout === 1) setLayout(prevLayout || 4, prevPage || 0);
    return;
  }
  if (e.key === '?') { $('modal-hotkeys').classList.toggle('hidden'); return; }
  if (e.key === 'b' || e.key === 'B') { $('btn-sidebar').click(); return; }
  if (e.key === 'f' || e.key === 'F') { $('btn-fullscreen').click(); return; }

  if (activeTab === 'live') {
    if (e.key === '1') setLayout(1, page * layout);
    else if (e.key === '4') setLayout(4, 0);
    else if (e.key === '9') setLayout(9, 0);
    else if (e.key === '0') setLayout(16, 0);
    else if (e.key === 'ArrowLeft') $('btn-prev-page').click();
    else if (e.key === 'ArrowRight') $('btn-next-page').click();
  } else {
    if (e.key === ' ') { e.preventDefault(); $('pb-toggle').click(); }
    else if (e.key === 'ArrowLeft') requestSeek(pbPlayheadSec - 10);
    else if (e.key === 'ArrowRight') requestSeek(pbPlayheadSec + 10);
  }
});

window.addEventListener('resize', () => { if (activeTab === 'playback') drawTimeline(); });

// ---- Boot ----
loadUiState();
const saved = loadCfg();
if (saved && saved.host && saved.user) {
  connectDevice(saved).catch((err) => openSettings(err?.message || ''));
} else {
  openSettings();
}
