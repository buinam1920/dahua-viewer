// Lightweight go2rtc MSE video player v2.1
// Supports H.265/HEVC, H.264, AAC, Opus, FLAC (for Dahua G.711 audio via go2rtc)
const MSE_CODECS = [
  'avc1.640029',      // H.264 High 4.1
  'avc1.64002A',      // H.264 High 4.2
  'avc1.4D4029',      // H.264 Main 4.1
  'avc1.42E01E',      // H.264 Baseline
  'hvc1.1.6.L93.B0',  // H.265 / HEVC (go2rtc default)
  'hev1.1.6.L93.B0',  // H.265 / HEVC alt
  'hvc1.1.6.L120.B0', // H.265 Level 4.0
  'hev1.1.6.L120.B0',
  'hvc1.1.6.L153.B0', // H.265 Level 5.1
  'mp4a.40.2',        // AAC
  'opus',             // Opus
  'flac',             // FLAC (go2rtc transcodes Dahua G.711/PCMA/PCMU to FLAC for MSE)
];

export function supportedMseCodecs() {
  if (!('MediaSource' in window)) return '';
  return MSE_CODECS.filter((c) => MediaSource.isTypeSupported(`video/mp4; codecs="${c}"`)).join(',');
}

export function supportsHevc() {
  return /hvc1|hev1/i.test(supportedMseCodecs());
}

export class Go2RtcPlayer {
  constructor(videoEl, srcName, { live = true, onState } = {}) {
    this.video = videoEl;
    this.srcName = srcName;
    this.live = live;
    this.onState = onState || (() => {});
    this.destroyed = false;
    this.ws = null;
    this.ms = null;
    this.sb = null;
    this.initSegment = null;
    this.initAppended = false;
    this.queue = [];
    this.queueBytes = 0;
    this.maxQueueBytes = live ? (4 * 1024 * 1024) : (16 * 1024 * 1024);
    this.reconnectTimer = null;
    this.watchdogTimer = null;
    this.retryMs = 1000;
    this.hasRenderedFrame = false;
    this.hasReceivedBinary = false;
    this.lastDataAt = 0;
    this.lastVideoTime = -1;
    this.stallTicks = 0;
    this.fatalError = false;
    this.objectUrl = null;
    this._onVideoFrame = () => this.markPlaying();
    this._onVideoError = () => this.handleVideoError();
    this.start();
  }

  wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/api/ws?src=${encodeURIComponent(this.srcName)}`;
  }

  markPlaying() {
    if (this.destroyed || this.hasRenderedFrame) return;
    if (this.video.videoWidth > 0 || this.video.readyState >= 2) {
      this.hasRenderedFrame = true;
      this.retryMs = 1000;
      this.onState('playing');
    }
  }

  handleVideoError() {
    if (this.destroyed || this.fatalError) return;
    const code = this.video?.error?.code || 0;
    this.onState('error', `Lỗi giải mã video (code ${code})`);
    if (this.live) this.scheduleReconnect();
  }

  start() {
    if (this.destroyed) return;
    this.cleanupConnection();
    this.hasRenderedFrame = false;
    this.hasReceivedBinary = false;
    this.initSegment = null;
    this.initAppended = false;
    this.fatalError = false;
    this.lastDataAt = Date.now();
    this.lastVideoTime = -1;
    this.stallTicks = 0;
    this.onState('connecting');

    const codecs = supportedMseCodecs();
    if (!codecs) {
      this.fatalError = true;
      this.onState('error', 'Trình duyệt không hỗ trợ MSE');
      return;
    }

    this.video.addEventListener('loadeddata', this._onVideoFrame);
    this.video.addEventListener('playing', this._onVideoFrame);
    this.video.addEventListener('timeupdate', this._onVideoFrame);
    this.video.addEventListener('error', this._onVideoError);

    const ws = this.ws = new WebSocket(this.wsUrl());
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      if (this.destroyed || this.ws !== ws) return;
      this.lastDataAt = Date.now();
      ws.send(JSON.stringify({ type: 'mse', value: codecs }));
      this.startWatchdog();
    };

    ws.onmessage = (ev) => {
      if (this.destroyed || this.ws !== ws) return;
      this.lastDataAt = Date.now();
      if (typeof ev.data === 'string') {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'mse' && msg.value) {
          this.initMse(msg.value);
        } else if (msg.type === 'error') {
          const errMsg = msg.value || 'Lỗi luồng video';
          if (/401|unauthorized|auth/i.test(errMsg)) {
            this.fatalError = true;
            this.onState('auth_error', 'Sai tài khoản/mật khẩu (401)');
            return;
          }
          if (/codecs not matched/i.test(errMsg)) {
            this.fatalError = true;
            this.onState('codec_error', errMsg);
            return;
          }
          this.onState('error', errMsg);
          if (this.live) this.scheduleReconnect();
        }
      } else {
        this.hasReceivedBinary = true;
        this.pushChunk(new Uint8Array(ev.data));
      }
    };

    ws.onerror = () => {
      if (this.destroyed || this.ws !== ws || this.fatalError) return;
      this.onState('error', 'Lỗi kết nối luồng');
    };

    ws.onclose = (ev) => {
      if (this.destroyed || this.ws !== ws || this.fatalError) return;
      if (this.live) {
        this.onState('reconnecting');
        this.scheduleReconnect();
      } else {
        // Distinguish real end-of-segment from premature network drop
        if (this.hasRenderedFrame && ev.wasClean) {
          this.onState('ended');
        } else if (this.hasRenderedFrame) {
          this.onState('ended', 'Đứt kết nối hoặc hết đoạn');
        } else {
          this.onState('error', 'Không nhận được dữ liệu bản ghi (kiểm tra mạng hoặc codec)');
        }
      }
    };
  }

  initMse(mime) {
    if (!MediaSource.isTypeSupported(mime)) {
      this.fatalError = true;
      this.onState('codec_error', `Codec không hỗ trợ: ${mime}`);
      return;
    }

    const ms = this.ms = new MediaSource();
    this.sb = null;
    this.initAppended = false;
    this.objectUrl = URL.createObjectURL(ms);
    this.video.src = this.objectUrl;

    ms.addEventListener('sourceopen', () => {
      if (this.destroyed || this.ms !== ms) return;
      if (this.objectUrl) {
        try { URL.revokeObjectURL(this.objectUrl); } catch {}
        this.objectUrl = null;
      }
      try {
        const sb = this.sb = ms.addSourceBuffer(mime);
        sb.mode = 'segments';
        sb.addEventListener('updateend', () => this.flush());
        sb.addEventListener('error', () => {
          if (this.destroyed) return;
          if (this.live) this.scheduleReconnect();
        });
        this.flush();
        this.video.play().catch(() => {});
      } catch (e) {
        this.fatalError = true;
        this.onState('error', `Không khởi tạo được MSE: ${mime}`);
      }
    }, { once: true });
  }

  pushChunk(chunk) {
    // First binary chunk after MSE negotiation is always the fMP4 init segment (ftyp+moov).
    // Preserve it separately so queue trimming NEVER drops it before sourceopen!
    if (!this.initSegment) {
      this.initSegment = chunk;
      if (this.sb && !this.sb.updating) this.flush();
      return;
    }

    this.queue.push(chunk);
    this.queueBytes += chunk.byteLength;

    // Bound queue by byte size while never touching initSegment
    while (this.queueBytes > this.maxQueueBytes && this.queue.length > 1) {
      const dropped = this.queue.shift();
      this.queueBytes -= dropped.byteLength;
    }

    if (this.sb && !this.sb.updating) this.flush();
  }

  trimBuffer(force = false) {
    if (!this.sb || this.sb.updating || !this.sb.buffered || this.sb.buffered.length === 0) return false;
    try {
      const start = this.sb.buffered.start(0);
      const end = this.sb.buffered.end(this.sb.buffered.length - 1);
      const cur = this.video.currentTime || 0;

      // Live latency catchup
      if (this.live && !this.video.paused && end - cur > 2.0) {
        this.video.currentTime = Math.max(start, end - 0.15);
      }

      // Keep 120s behind playhead in Playback for instant +-10s/+-1m local seek; 20s in Live
      const maxBehind = this.live ? 20 : 120;
      const keepBehind = this.live ? 5 : 45;

      if (cur - start > maxBehind) {
        const removeEnd = Math.max(start, cur - keepBehind);
        if (removeEnd > start + 0.5) {
          this.sb.remove(start, removeEnd);
          return true;
        }
      }

      if (force) {
        // Emergency eviction on QuotaExceededError (e.g. playback paused for a long time)
        if (cur - start > 5) {
          this.sb.remove(start, Math.max(start + 1, cur - 3));
          return true;
        }
        // If paused at start and forward buffer filled quota, trim far-future buffer so playback stays resumable
        if (end - cur > 30) {
          this.sb.remove(cur + 15, end);
          return true;
        }
        if (end - start > 4) {
          this.sb.remove(start, start + (end - start) / 2);
          return true;
        }
      }
    } catch {}
    return false;
  }

  flush() {
    if (this.destroyed || !this.sb || this.sb.updating) return;
    if (!this.ms || this.ms.readyState !== 'open') return;

    // 1. Always append initSegment first
    if (this.initSegment && !this.initAppended) {
      try {
        this.sb.appendBuffer(this.initSegment);
        this.initAppended = true;
      } catch {
        if (this.live) this.scheduleReconnect();
      }
      return;
    }

    if (!this.queue.length) return;

    // 2. Routine buffer housekeeping
    if (this.trimBuffer(false)) return;

    // 3. Coalesce queued chunks (capped to 2 MB per append to avoid spikes)
    const batch = [];
    let total = 0;
    while (this.queue.length && total < 2 * 1024 * 1024) {
      const q = this.queue.shift();
      this.queueBytes -= q.byteLength;
      batch.push(q);
      total += q.byteLength;
    }

    let merged;
    if (batch.length === 1) {
      merged = batch[0];
    } else {
      merged = new Uint8Array(total);
      let off = 0;
      for (let i = 0; i < batch.length; i++) {
        merged.set(batch[i], off);
        off += batch[i].byteLength;
      }
    }

    try {
      this.sb.appendBuffer(merged);
    } catch (e) {
      if (e && e.name === 'QuotaExceededError') {
        // Put chunk back at front of queue, evict buffer, and retry automatically on updateend
        this.queue.unshift(merged);
        this.queueBytes += merged.byteLength;
        if (!this.trimBuffer(true) && this.live) {
          this.scheduleReconnect();
        }
      } else {
        this.onState('error', 'Lỗi bộ đệm giải mã');
        if (this.live) this.scheduleReconnect();
      }
    }
  }

  startWatchdog() {
    clearInterval(this.watchdogTimer);
    this.watchdogTimer = setInterval(() => {
      if (this.destroyed || this.fatalError) return;
      const now = Date.now();

      // Catch up live edge smoothly
      if (this.live && this.video && !this.video.paused) {
        try {
          const b = this.video.buffered;
          if (b.length > 0) {
            const end = b.end(b.length - 1);
            if (end - this.video.currentTime > 1.5) {
              this.video.currentTime = end - 0.12;
            }
          }
        } catch {}
      }

      // Detect frozen / silent stream in Live mode (10s without binary data or frozen playback)
      if (this.live) {
        if (now - this.lastDataAt > 10000) {
          this.onState('reconnecting');
          this.scheduleReconnect();
          return;
        }
        if (this.hasRenderedFrame && !this.video.paused) {
          const ct = this.video.currentTime;
          if (Math.abs(ct - this.lastVideoTime) < 0.01) {
            this.stallTicks++;
            if (this.stallTicks >= 5) { // 10 seconds frozen
              this.onState('reconnecting');
              this.scheduleReconnect();
              return;
            }
          } else {
            this.lastVideoTime = ct;
            this.stallTicks = 0;
          }
        }
      } else {
        // Playback: detect stuck initial load (15s without first frame)
        if (!this.hasRenderedFrame && now - this.lastDataAt > 15000) {
          this.onState('error', 'Hết thời gian chờ khung hình đầu tiên');
        }
      }
    }, 2000);
  }

  scheduleReconnect() {
    if (this.destroyed || !this.live || this.fatalError) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.retryMs = Math.min(this.retryMs * 1.5, 8000);
      this.start();
    }, this.retryMs);
  }

  cleanupConnection() {
    clearTimeout(this.reconnectTimer);
    clearInterval(this.watchdogTimer);
    if (this.video) {
      this.video.removeEventListener('loadeddata', this._onVideoFrame);
      this.video.removeEventListener('playing', this._onVideoFrame);
      this.video.removeEventListener('timeupdate', this._onVideoFrame);
      this.video.removeEventListener('error', this._onVideoError);
    }
    if (this.ws) {
      const old = this.ws;
      this.ws = null;
      try { old.onclose = null; old.onerror = null; old.onmessage = null; old.close(); } catch {}
    }
    if (this.ms && this.ms.readyState === 'open') {
      try { this.ms.endOfStream(); } catch {}
    }
    if (this.objectUrl) {
      try { URL.revokeObjectURL(this.objectUrl); } catch {}
      this.objectUrl = null;
    }
    this.ms = null;
    this.sb = null;
    this.queue = [];
    this.queueBytes = 0;
    this.initSegment = null;
    this.initAppended = false;
    try {
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
    } catch {}
  }

  destroy() {
    this.destroyed = true;
    this.cleanupConnection();
  }
}
