'use strict';

/**
 * [SESSION] One isolated remote browser session.
 *
 * A session owns exactly one IncognitoBrowserContext + Page from the master
 * browser, and bridges it to a client SDK over a small JSON protocol:
 *
 *   client -> server: init, navigate, mouse, wheel, key, paste, clipboard,
 *                     resize, visibility, upload:result, ping
 *   server -> client: ready, frame, url, state, clipboard, upload:request,
 *                     download, error, expired
 *
 * Everything session-scoped lives on the client (stateless backend): the SDK
 * persists {sessionId, url, localStorage, cookies} in host localStorage and
 * replays it on reconnect.
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { ROOT } = require('./files');

const DEFAULTS = {
  quality: Number(process.env.SCREENCAST_QUALITY || 70),
  maxWidth: Number(process.env.SCREENCAST_MAX_WIDTH || 1280),
  maxHeight: Number(process.env.SCREENCAST_MAX_HEIGHT || 800),
  storagePollMs: Number(process.env.STORAGE_POLL_MS || 5000),
  downloadPollMs: Number(process.env.DOWNLOAD_POLL_MS || 400),
  navigationTimeoutMs: Number(process.env.NAV_TIMEOUT_MS || 45000),
};

class RemoteSession extends EventEmitter {
  constructor({ id, context, files, config = {}, logger = console }) {
    super();
    this.id = id;
    this.context = context;
    this.files = files;
    this.config = { ...DEFAULTS, ...config };
    this.logger = logger;

    this.page = null;
    this.client = null;
    this.sink = null;
    this.closed = false;
    this.navigated = false;
    this.visible = true;
    this.lastActivity = Date.now();
    this.lastUrl = 'about:blank';
    this.targetUrl = 'about:blank';
    this.state = { localStorage: {}, cookies: [] };
    this.pendingChoosers = new Map();
    this.uploadSeq = 0;
    this.knownFiles = new Set();
    this.screencasting = false;
    this.timers = [];
  }

  // ---------------------------------------------------------------- lifecycle

  async bootstrap({ url, viewport, state }) {
    const vp = normalizeViewport(viewport, this.config);
    this.state = normalizeState(state);

    this.page = await this.context.newPage();
    await this.page.setViewport(vp);

    this.client = await this.page.target().createCDPSession();
    await this.client.send('Page.enable');
    await this.client.send('Network.enable');
    await this.client.send('Runtime.enable');
    await this.client.send('DOM.enable').catch(() => {});
    await this.client.send('Log.enable').catch(() => {});

    this.wireExposedFunctions();
    this.wireScreencast();
    this.wireNavigation();
    this.wireFileChooser();
    this.wireConsole();

    this.injectSeedScript(this.state);

    await this.setDownloadBehavior();

    if (this.state.cookies.length) await this.applyCookies(this.state.cookies);
    this.targetUrl = url || 'about:blank';
    // Only screencast a page we actually reached; otherwise the client would get
    // a confusing "Not attached to an active page" on top of the real error.
    this.navigated = await this.navigate(this.targetUrl);
    if (this.navigated) await this.startScreencast(vp);

    this.startStoragePoll();
    this.startDownloadPoll();

    this.logger.log(`[SESSION ${this.id}] bootstrapped url=${this.targetUrl}`);
    return this;
  }

  /**
   * Bind a socket. Must happen BEFORE bootstrap for a new session so that
   * messages produced while the page is being set up (the navigation result,
   * the resolved URL) are not dropped on the floor.
   */
  attach(sink) {
    this.sink = sink;
    sink.on('close', () => this.detach(sink));
    // A fresh socket means a visible client: make sure frames are flowing again
    // (a reload may have hidden us and stopped the screencast). Skipped while a
    // brand new session is still bootstrapping — bootstrap starts it itself.
    if (!this.page || !this.screencastSizes) return;
    if (!this.visible) {
      this.setVisibility(true).catch(() => {});
    } else {
      this.startScreencast(this.screencastSizes).catch(() => {});
    }
  }

  sendReady(resumed) {
    this.send({ type: 'ready', sessionId: this.id, url: this.lastUrl, resumed, navigated: this.navigated });
  }

  detach(sink) {
    if (this.sink === sink) this.sink = null;
  }

  send(message) {
    if (!this.sink) return false;
    if (!this.sink.isOpen()) return false;
    try {
      this.sink.send(JSON.stringify(message));
      return true;
    } catch (err) {
      this.logger.warn(`[SESSION ${this.id}] send failed: ${err.message}`);
      return false;
    }
  }

  touch() {
    this.lastActivity = Date.now();
    this.emit('activity', this);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    try {
      if (this.client) await this.client.send('Page.stopScreencast').catch(() => {});
    } catch {
      /* ignore */
    }
    try {
      await this.context.close();
    } catch (err) {
      this.logger.warn(`[SESSION ${this.id}] context close failed: ${err.message}`);
    }
    this.emit('closed', this);
    this.logger.log(`[SESSION ${this.id}] closed`);
  }

  // ------------------------------------------------------------------- wiring

  wireExposedFunctions() {
    this.page
      .exposeFunction('__rbasStorage', (json) => {
        try {
          this.state.localStorage = JSON.parse(json) || {};
          this.emitState({ localStorage: this.state.localStorage });
        } catch (err) {
          this.logger.warn(`[SESSION ${this.id}] storage payload invalid: ${err.message}`);
        }
      })
      .catch((err) => this.logger.warn(`[SESSION ${this.id}] expose __rbasStorage: ${err.message}`));

    this.page
      .exposeFunction('__rbasClipboardWrite', (text) => {
        if (typeof text !== 'string' || !text) return;
        this.send({ type: 'clipboard', text });
      })
      .catch((err) => this.logger.warn(`[SESSION ${this.id}] expose __rbasClipboardWrite: ${err.message}`));

    this.page
      .exposeFunction('__rbasOpenUrl', (url) => {
        if (typeof url === 'string' && /^https?:/i.test(url)) {
          this.logger.log(`[SESSION ${this.id}] window.open intercepted -> ${url}`);
          this.navigate(url);
        }
      })
      .catch(() => {});
  }

  wireScreencast() {
    this.client.on('Page.screencastFrame', async (frame) => {
      this.send({ type: 'frame', data: frame.data, metadata: frame.metadata });
      try {
        await this.client.send('Page.screencastFrameAck', { sessionId: frame.sessionId });
      } catch {
        /* frame already superseded */
      }
    });
  }

  wireNavigation() {
    this.client.on('Page.frameNavigated', (event) => {
      if (!event.frame.parentId) {
        this.lastUrl = event.frame.url;
        this.send({ type: 'url', url: this.lastUrl });
        this.emitState({ cookies: this.state.cookies });
      }
    });
    this.page.on('close', () => {
      if (!this.closed) this.emit('pageclosed', this);
    });
    this.page.on('error', (err) => {
      this.logger.error(`[SESSION ${this.id}] page crashed: ${err.message}`);
      this.send({ type: 'error', message: 'Remote browser crashed; reconnecting…' });
      this.emit('pageclosed', this);
    });
  }

  /**
   * Upload bridge. Chrome's native picker is suppressed at the CDP level; the
   * remote <input type=file> node is remembered and fed from the host later.
   */
  wireFileChooser() {
    this.client.on('Page.fileChooserOpened', (event) => {
      const uploadId = `up_${++this.uploadSeq}`;
      this.pendingChoosers.set(uploadId, { backendNodeId: event.backendNodeId, mode: event.mode });
      const multiple = event.mode === 'selectMultiple';
      this.logger.log(`[SESSION ${this.id}] remote file chooser intercepted id=${uploadId} multiple=${multiple}`);
      const sent = this.send({ type: 'upload:request', id: uploadId, multiple });
      if (!sent) this.pendingChoosers.delete(uploadId);
    });

    this.client
      .send('Page.setInterceptFileChooserDialog', { enabled: true })
      .catch((err) => this.logger.warn(`[SESSION ${this.id}] cannot intercept file chooser: ${err.message}`));
  }

  wireConsole() {
    this.page.on('console', (msg) => this.logger.log(`[CDP ${this.id}] ${msg.type()}: ${msg.text()}`));
    this.client.on('Runtime.exceptionThrown', (event) => {
      const text = event.exceptionDetails?.exception?.description || event.exceptionDetails?.text;
      if (text) this.logger.warn(`[CDP ${this.id}] exception: ${text}`);
    });
  }

  injectSeedScript(seed) {
    // Runs before any page script on every document. Seeding is guarded so that
    // later client-side mutations made *inside* the remote page are not reset.
    this.page.evaluateOnNewDocument((payload) => {
      try {
        if (!window.sessionStorage.getItem('__rbas_seeded')) {
          for (const key of Object.keys(payload.localStorage || {})) {
            try {
              window.localStorage.setItem(key, payload.localStorage[key]);
            } catch {
              /* storage disabled for this origin */
            }
          }
          window.sessionStorage.setItem('__rbas_seeded', '1');
        }
      } catch {
        /* ignore */
      }

      // Stream localStorage mutations back to the host.
      try {
        const notify = () => {
          try {
            const snapshot = {};
            for (let i = 0; i < window.localStorage.length; i += 1) {
              const key = window.localStorage.key(i);
              snapshot[key] = window.localStorage.getItem(key);
            }
            if (window.__rbasStorage) window.__rbasStorage(JSON.stringify(snapshot));
          } catch {
            /* ignore */
          }
        };
        const proto = Object.getPrototypeOf(window.localStorage);
        for (const method of ['setItem', 'removeItem', 'clear']) {
          const original = proto[method];
          if (!original || original.__rbas) continue;
          const patched = function (...args) {
            const result = original.apply(this, args);
            notify();
            return result;
          };
          patched.__rbas = true;
          proto[method] = patched;
        }
      } catch {
        /* ignore */
      }

      // Bi-directional text clipboard: copy/cut out, paste in.
      try {
        const capture = (event) => {
          try {
            const text =
              (event.clipboardData && event.clipboardData.getData('text/plain')) ||
              String(window.getSelection() || '');
            if (text && window.__rbasClipboardWrite) window.__rbasClipboardWrite(text);
          } catch {
            /* ignore */
          }
        };
        document.addEventListener('copy', capture, true);
        document.addEventListener('cut', capture, true);
      } catch {
        /* ignore */
      }

      // window.open / target=_blank should navigate the embedded session.
      try {
        const nativeOpen = window.open;
        window.open = function (url) {
          if (url && window.__rbasOpenUrl) {
            window.__rbasOpenUrl(String(url));
            return null;
          }
          return nativeOpen.apply(window, arguments);
        };
      } catch {
        /* ignore */
      }
    }, seed);
  }

  /**
   * Download behavior MUST be scoped to this session's incognito context, or
   * files land in the browser-wide default directory and never reach the host.
   */
  async setDownloadBehavior() {
    this.downloadDir = path.join(ROOT, 'downloads', this.id);
    fs.mkdirSync(this.downloadDir, { recursive: true });

    try {
      if (typeof this.context.setDownloadBehavior === 'function') {
        await this.context.setDownloadBehavior({ policy: 'allow', downloadPath: this.downloadDir });
        this.logger.log(`[SESSION ${this.id}] download behavior (context) -> ${this.downloadDir}`);
        return;
      }
    } catch (err) {
      this.logger.warn(`[SESSION ${this.id}] context download behavior failed: ${err.message}`);
    }

    try {
      await this.client.send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: this.downloadDir,
        browserContextId: this.context._id,
      });
      this.logger.log(`[SESSION ${this.id}] download behavior (cdp) -> ${this.downloadDir}`);
    } catch (err) {
      this.logger.warn(`[SESSION ${this.id}] download bridge unavailable: ${err.message}`);
    }
  }

  // --------------------------------------------------------------- operations

  async navigate(url, { reload = false } = {}) {
    if (!this.page) return false;
    this.targetUrl = url;
    try {
      this.logger.log(`[SESSION ${this.id}] navigate -> ${url}`);
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.config.navigationTimeoutMs });
      this.navigated = true;
      return true;
    } catch (err) {
      this.logger.warn(`[SESSION ${this.id}] navigation issue: ${err.message}`);
      this.send({ type: 'error', message: `Navigation problem: ${err.message}` });
      if (reload) throw err;
      this.navigated = false;
      return false;
    }
  }

  async startScreencast(viewport, { force = false } = {}) {
    if (this.closed) return; // the context is gone; there is nothing to stream
    const vp = viewport || { width: this.config.maxWidth, height: this.config.maxHeight };
    this.screencastSizes = { width: Math.round(vp.width), height: Math.round(vp.height) };
    if (this.screencasting && !force) return;
    try {
      await this.client.send('Page.startScreencast', {
        format: 'jpeg',
        quality: this.config.quality,
        maxWidth: this.screencastSizes.width,
        maxHeight: this.screencastSizes.height,
        everyNthFrame: 1,
      });
      this.screencasting = true;
      this.logger.log(`[SESSION ${this.id}] screencast started ${this.screencastSizes.width}x${this.screencastSizes.height}`);
    } catch (err) {
      this.logger.error(`[SESSION ${this.id}] startScreencast failed: ${err.message}`);
      this.send({ type: 'error', message: `Screencast failed: ${err.message}` });
    }
  }

  async applyCookies(cookies) {
    const sanitized = sanitizeCookies(cookies);
    if (!sanitized.length) return;
    try {
      await this.client.send('Network.setCookies', { cookies: sanitized });
      this.logger.log(`[SESSION ${this.id}] injected ${sanitized.length} cookies`);
    } catch (err) {
      this.logger.warn(`[SESSION ${this.id}] cookie injection failed: ${err.message}`);
    }
  }

  async snapshotCookies() {
    try {
      const { cookies } = await this.client.send('Network.getCookies');
      return cookies || [];
    } catch {
      return this.state.cookies;
    }
  }

  emitState(partial) {
    if (partial.localStorage) this.state.localStorage = partial.localStorage;
    if (partial.cookies) this.state.cookies = partial.cookies;
    this.send({ type: 'state', localStorage: this.state.localStorage, cookies: this.state.cookies });
  }

  startStoragePoll() {
    const timer = setInterval(async () => {
      if (this.closed || !this.client) return;
      const cookies = await this.snapshotCookies();
      const changed = JSON.stringify(cookies) !== JSON.stringify(this.state.cookies);
      if (changed) {
        this.state.cookies = cookies;
        this.emitState({ cookies });
      }
    }, this.config.storagePollMs);
    this.timers.push(timer);
  }

  /**
   * Download bridge. Chrome writes into a per-session directory; we watch it,
   * wait for a stable file, and hand the host a `/download/:id` link.
   */
  startDownloadPoll() {
    const timer = setInterval(async () => {
      if (this.closed || !this.downloadDir) return;
      let names;
      try {
        names = await fs.promises.readdir(this.downloadDir);
      } catch {
        return;
      }
      for (const name of names) {
        if (name.startsWith('.') || name.endsWith('.crdownload') || name.endsWith('.tmp')) continue;
        const full = path.join(this.downloadDir, name);
        if (this.knownFiles.has(full)) continue;
        let stat1;
        try {
          stat1 = await fs.promises.stat(full);
        } catch {
          continue;
        }
        // Stability check: unchanged size a tick later means the write is done.
        await delay(this.config.downloadPollMs);
        let stat2;
        try {
          stat2 = await fs.promises.stat(full);
        } catch {
          continue;
        }
        if (stat1.size !== stat2.size) continue;
        this.knownFiles.add(full);
        const entry = await this.files.trackDownload(full, name);
        this.logger.log(`[FILES ${this.id}] download ready ${name} (${stat2.size} bytes)`);
        this.send({ type: 'download', url: `/download/${entry.id}`, filename: name, bytes: stat2.size });
      }
    }, this.config.downloadPollMs);
    this.timers.push(timer);
  }

  // ----------------------------------------------------------- client messages

  async handleMessage(msg) {
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'mouse':
        this.touch();
        return this.dispatchMouse(msg.event);
      case 'wheel':
        this.touch();
        return this.dispatchWheel(msg.event);
      case 'key':
        this.touch();
        return this.dispatchKey(msg.event);
      case 'navigate':
        this.touch();
        return this.navigate(String(msg.url));
      case 'clipboard':
        // Host copied text -> push it into the remote clipboard.
        this.touch();
        return this.remoteClipboardWrite(msg.text);
      case 'paste':
        // Host pasted text -> insert into the focused remote element.
        this.touch();
        return this.remoteInsertText(msg.text);
      case 'upload:result':
        return this.resolveUpload(msg);
      case 'resize':
        this.touch();
        return this.resize(msg.viewport);
      case 'visibility':
        return this.setVisibility(Boolean(msg.visible));
      case 'ping':
        return this.send({ type: 'pong', t: Date.now() });
      case 'close':
        // Explicit teardown: no reconnect grace, the caller is done with it.
        this.emit('closerequested', typeof msg.reason === 'string' ? msg.reason : null);
        return undefined;
      default:
        this.logger.warn(`[SESSION ${this.id}] unknown message type=${msg.type}`);
    }
  }

  async dispatchMouse(event = {}) {
    const params = {
      type: event.type,
      x: Number(event.x) || 0,
      y: Number(event.y) || 0,
      button: event.button || 'none',
      buttons: Number(event.buttons) || 0,
      clickCount: Number(event.clickCount) || 0,
      modifiers: Number(event.modifiers) || 0,
    };
    if (event.type === 'mouseWheel') {
      params.deltaX = Number(event.deltaX) || 0;
      params.deltaY = Number(event.deltaY) || 0;
    }
    try {
      await this.client.send('Input.dispatchMouseEvent', params);
    } catch (err) {
      this.logger.warn(`[SESSION ${this.id}] mouse dispatch failed: ${err.message}`);
    }
  }

  dispatchWheel(event = {}) {
    return this.dispatchMouse({
      type: 'mouseWheel',
      x: event.x,
      y: event.y,
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      modifiers: event.modifiers,
    });
  }

  async dispatchKey(event = {}) {
    const key = event.key || '';
    const type = event.type || 'keyDown';
    const params = {
      type,
      key,
      code: event.code || '',
      windowsVirtualKeyCode: Number(event.keyCode) || 0,
      nativeVirtualKeyCode: Number(event.keyCode) || 0,
      modifiers: Number(event.modifiers) || 0,
      autoRepeat: Boolean(event.autoRepeat),
    };
    if (event.text) params.text = event.text;
    if (event.unmodifiedText) params.unmodifiedText = event.unmodifiedText;
    // Chromium only runs implicit form submission — and only inserts a newline
    // into a textarea — when Enter arrives as a character event. The SDK sends
    // every non-printable key as rawKeyDown with no text, so a bare Enter fires
    // keydown/keypress but does nothing: search boxes never submit, logins never
    // submit, and Enter in a textarea inserts nothing. Carry the carriage return
    // ourselves on the key-down half; the key-up is left alone.
    if ((key === 'Enter' || key === 'Return') && type !== 'keyUp' && !params.text) {
      params.text = '\r';
      params.unmodifiedText = '\r';
      if (params.type === 'rawKeyDown') params.type = 'keyDown';
    }
    try {
      await this.client.send('Input.dispatchKeyEvent', params);
    } catch (err) {
      this.logger.warn(`[SESSION ${this.id}] key dispatch failed: ${err.message}`);
    }
  }

  async remoteInsertText(text) {
    if (typeof text !== 'string' || !text) return;
    try {
      await this.client.send('Input.insertText', { text });
    } catch (err) {
      this.logger.warn(`[SESSION ${this.id}] insertText failed: ${err.message}`);
    }
  }

  async remoteClipboardWrite(text) {
    if (typeof text !== 'string') return;
    try {
      await this.page.evaluate((value) => {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          return navigator.clipboard.writeText(value).catch(() => {});
        }
        return undefined;
      }, text);
    } catch {
      /* clipboard permission not granted in headless; host copy still targeted */
    }
  }

  async resolveUpload(msg) {
    const pending = this.pendingChoosers.get(msg.id);
    if (!pending) {
      this.logger.warn(`[SESSION ${this.id}] upload:result for unknown id=${msg.id}`);
      return;
    }
    this.pendingChoosers.delete(msg.id);
    const ids = Array.isArray(msg.fileIds) ? msg.fileIds : [msg.fileId].filter(Boolean);
    const paths = ids.map((fileId) => this.files.get(fileId)).filter(Boolean).map((entry) => entry.path);
    if (!paths.length) {
      this.logger.warn(`[SESSION ${this.id}] upload files missing ids=${ids.join(',')}`);
      return;
    }
    try {
      await this.client.send('DOM.setFileInputFiles', {
        files: paths,
        backendNodeId: pending.backendNodeId,
      });
      this.logger.log(`[SESSION ${this.id}] ${paths.length} file(s) handed to remote browser`);
    } catch (err) {
      this.logger.warn(`[SESSION ${this.id}] DOM.setFileInputFiles failed: ${err.message}`);
    }
  }

  async resize(viewport) {
    const vp = normalizeViewport(viewport, this.config);
    try {
      await this.page.setViewport(vp);
      await this.startScreencast(vp, { force: true });
    } catch (err) {
      this.logger.warn(`[SESSION ${this.id}] resize failed: ${err.message}`);
    }
  }

  async setVisibility(visible) {
    if (this.closed || this.visible === visible) return;
    this.visible = visible;
    this.emit('visibility', visible, this);
    try {
      if (visible) {
        await this.startScreencast({ width: this.screencastSizes.width, height: this.screencastSizes.height }, { force: true });
      } else {
        await this.client.send('Page.stopScreencast');
        this.screencasting = false;
      }
    } catch (err) {
      // A teardown that races a visibility change is expected, not a fault.
      if (this.closed) return;
      this.logger.warn(`[SESSION ${this.id}] visibility switch failed: ${err.message}`);
    }
  }
}

// ------------------------------------------------------------------- helpers

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeViewport(viewport, config) {
  const width = Math.max(240, Math.min(2560, Number(viewport?.width) || config.maxWidth));
  const height = Math.max(240, Math.min(1600, Number(viewport?.height) || config.maxHeight));
  return { width: Math.round(width), height: Math.round(height), deviceScaleFactor: 1 };
}

function normalizeState(state) {
  const out = { localStorage: {}, cookies: [] };
  if (state && typeof state.localStorage === 'object' && state.localStorage) {
    for (const [key, value] of Object.entries(state.localStorage)) {
      if (typeof value === 'string') out.localStorage[key] = value;
    }
  }
  if (Array.isArray(state?.cookies)) out.cookies = state.cookies;
  return out;
}

function sanitizeCookies(cookies) {
  const allowed = ['name', 'value', 'domain', 'path', 'secure', 'httpOnly', 'sameSite', 'expires', 'url'];
  return (Array.isArray(cookies) ? cookies : [])
    .filter((cookie) => cookie && typeof cookie.name === 'string' && typeof cookie.value === 'string')
    .map((cookie) => {
      const clean = {};
      for (const key of allowed) {
        if (cookie[key] !== undefined && cookie[key] !== null) clean[key] = cookie[key];
      }
      if (!clean.domain && !clean.url) clean.url = 'about:blank';
      return clean;
    });
}

module.exports = { RemoteSession, sanitizeCookies, normalizeViewport };
