/**
 * <remote-browser> — Easy Browser-as-a-Service client SDK.
 *
 * Drop-in replacement for an <iframe> when the target app blocks framing/CORS.
 * Vanilla JS Custom Element, no build step, no dependencies.
 *
 *   <script src="https://your-server/sdk.js"></script>
 *   <remote-browser src="https://crm.example.com" style="width:100%;height:640px"></remote-browser>
 *
 * Attributes:
 *   src          target URL to open in the remote session
 *   server       origin of the service (defaults to the script's own origin)
 *   storage-key  host localStorage key used to persist session state
 */

(() => {
  'use strict';

  const DEFAULT_STORAGE_KEY = 'rbas:session';
  const RECONNECT_DELAYS = [500, 1500, 3000, 6000, 10000];

  // Which script origin did we load from? Lets embeds on other origins work.
  const SCRIPT_ORIGIN = (() => {
    try {
      const script = document.currentScript || document.querySelector('script[src*="sdk.js"]');
      return script && script.src ? new URL(script.src).origin : window.location.origin;
    } catch {
      return window.location.origin;
    }
  })();

  // CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8.
  function modifierMask(event) {
    return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
  }

  function buttonName(button) {
    return ['left', 'middle', 'right', 'back', 'forward'][button] || 'none';
  }

  const template = document.createElement('template');
  template.innerHTML = `
    <style>
      :host { display: block; position: relative; contain: content; background: #0b0e14; }
      .stage { position: absolute; inset: 0; }
      canvas { display: block; width: 100%; height: 100%; outline: none; background: #0b0e14; }
      .overlay {
        position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
        font: 13px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; color: #c8d0dc;
        background: rgba(11, 14, 20, .82); text-align: center; padding: 16px; gap: 8px;
        flex-direction: column; transition: opacity .2s ease;
      }
      .overlay[hidden] { display: none; }
      .spinner {
        width: 18px; height: 18px; border: 2px solid #2a3444; border-top-color: #5b8cff;
        border-radius: 50%; animation: spin 1s linear infinite;
      }
      @keyframes spin { to { transform: rotate(360deg); } }
      .overlay.error .spinner { display: none; }
      .actions { display: flex; gap: 8px; }
      button {
        font: inherit; color: #eaf0fa; background: #1b2432; border: 1px solid #2f3a4d;
        border-radius: 6px; padding: 6px 12px; cursor: pointer;
      }
      button:hover { background: #24303f; }
    </style>
    <div class="stage">
      <canvas tabindex="0" aria-label="Remote browser viewport"></canvas>
    </div>
    <div class="overlay"><div class="spinner"></div><div class="msg">Connecting to remote browser…</div></div>
  `;

  class RemoteBrowser extends HTMLElement {
    static get observedAttributes() {
      return ['src', 'server'];
    }

    constructor() {
      super();
      this.attachShadow({ mode: 'open' }).appendChild(template.content.cloneNode(true));
      this.canvas = this.shadowRoot.querySelector('canvas');
      this.overlay = this.shadowRoot.querySelector('.overlay');
      this.message = this.shadowRoot.querySelector('.msg');

      this.ws = null;
      this.sessionId = null;
      this.ready = false;
      this.intentionalClose = false;
      this.reconnectAttempt = 0;
      this.viewport = { width: 0, height: 0 };
      this.sizes = { width: 0, height: 0 };
      this.pendingFrame = false;
      this.pendingChooserId = null;
    }

    // ------------------------------------------------------------ lifecycle

    connectedCallback() {
      if (this._connected) return;
      this._connected = true;
      this.bindInput();
      this.bindLifecycle();
      this.resizeObserver = new ResizeObserver(() => this.measure());
      this.resizeObserver.observe(this);
      this.measure();
      this.connect();
    }

    disconnectedCallback() {
      this._connected = false;
      this.intentionalClose = true;
      this.resizeObserver?.disconnect();
      this.closeSocket();
    }

    attributeChangedCallback(name, oldValue, newValue) {
      if (oldValue === newValue) return;
      if (name === 'src' && this._connected && this.ready) this.navigate(newValue);
      if (name === 'server' && this._connected && oldValue) this.reconnect(true);
    }

    get serverOrigin() {
      const attr = this.getAttribute('server');
      if (attr) {
        try {
          return new URL(attr, window.location.href).origin;
        } catch {
          /* fall through */
        }
      }
      return SCRIPT_ORIGIN;
    }

    get storageKey() {
      return this.getAttribute('storage-key') || DEFAULT_STORAGE_KEY;
    }

    // ---------------------------------------------------------- persistence

    loadStoredState() {
      try {
        const raw = window.localStorage.getItem(this.storageKey);
        return raw ? JSON.parse(raw) : {};
      } catch {
        return {};
      }
    }

    saveStoredState(patch) {
      const merged = { ...this.loadStoredState(), ...patch };
      try {
        window.localStorage.setItem(this.storageKey, JSON.stringify(merged));
      } catch {
        /* storage unavailable */
      }
    }

    // ----------------------------------------------------------- connection

    connect() {
      this.intentionalClose = false;
      const stored = this.loadStoredState();
      const url = this.getAttribute('src') || stored.url || 'about:blank';
      const scheme = this.serverOrigin.replace(/^http/, 'ws');
      const wsUrl = `${scheme}/ws`;

      this.setStatus(`Connecting to ${this.serverOrigin}…`);
      console.log(`[SDK] connecting ${wsUrl}`);

      let socket;
      try {
        socket = new WebSocket(wsUrl);
      } catch (err) {
        this.setStatus(`Could not open WebSocket: ${err.message}`, true);
        return;
      }
      this.ws = socket;

      socket.addEventListener('open', () => {
        console.log('[SDK] socket open');
        this.send({
          type: 'init',
          url,
          sessionId: stored.sessionId || null,
          viewport: this.viewport,
          state: { localStorage: stored.localStorage || {}, cookies: stored.cookies || [] },
        });
      });

      socket.addEventListener('message', (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        this.handleMessage(msg);
      });

      socket.addEventListener('close', () => {
        console.log('[SDK] socket closed');
        this.ready = false;
        if (this.intentionalClose || !this._connected) return;
        this.scheduleReconnect();
      });

      socket.addEventListener('error', () => {
        this.setStatus('Connection error — retrying…', true);
      });
    }

    closeSocket() {
      if (this.ws) {
        try {
          this.ws.close();
        } catch {
          /* ignore */
        }
      }
      this.ws = null;
    }

    reconnect(force) {
      if (force) this.closeSocket();
      this.connect();
    }

    scheduleReconnect() {
      const delay = RECONNECT_DELAYS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)];
      this.reconnectAttempt += 1;
      this.setStatus(`Reconnecting in ${Math.round(delay / 1000)}s…`, true);
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = setTimeout(() => this.connect(), delay);
    }

    send(payload) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
      this.ws.send(JSON.stringify(payload));
      return true;
    }

    // ------------------------------------------------------------- protocol

    handleMessage(msg) {
      switch (msg.type) {
        case 'ready': {
          const resumed = Boolean(msg.resumed);
          console.log(`[SDK] ready session=${msg.sessionId} resumed=${resumed} url=${msg.url}`);
          this.sessionId = msg.sessionId;
          this.ready = true;
          this.reconnectAttempt = 0;
          this.saveStoredState({ sessionId: msg.sessionId, url: msg.url });
          this.setStatus(resumed ? 'Resumed remote session…' : 'Loading remote session…');
          this.dispatchEvent(new CustomEvent('ready', { detail: { sessionId: msg.sessionId, url: msg.url, resumed } }));
          return;
        }
        case 'frame':
          this.drawFrame(msg);
          return;
        case 'url':
          this.saveStoredState({ url: msg.url });
          this.dispatchEvent(new CustomEvent('navigate', { detail: { url: msg.url } }));
          return;
        case 'state':
          this.saveStoredState({ localStorage: msg.localStorage, cookies: msg.cookies });
          return;
        case 'clipboard':
          this.writeHostClipboard(msg.text);
          return;
        case 'download':
          this.triggerDownload(msg.url, msg.filename);
          return;
        case 'upload:request':
          this.requestUpload(msg.id, msg.multiple);
          return;
        case 'expired':
          this.handleExpired(msg.reason);
          return;
        case 'pong':
          return;
        case 'error':
          console.warn(`[SDK] server error: ${msg.message}`);
          this.setStatus(msg.message, true, true);
          return;
        default:
          console.warn(`[SDK] unknown message`, msg);
      }
    }

    handleExpired(reason) {
      console.log(`[SDK] session expired: ${reason}`);
      this.ready = false;
      this.intentionalClose = false;
      this.saveStoredState({ sessionId: null });
      this.setStatus(`Session ended (${reason || 'expired'}).`, true, true);
      this.dispatchEvent(new CustomEvent('expired', { detail: { reason } }));
    }

    // ------------------------------------------------------------ rendering

    drawFrame(msg) {
      const meta = msg.metadata || {};
      const width = meta.deviceWidth || this.viewport.width;
      const height = meta.deviceHeight || this.viewport.height;
      if (width && height && (this.sizes.width !== width || this.sizes.height !== height)) {
        this.sizes = { width, height };
        this.canvas.width = width;
        this.canvas.height = height;
      }
      if (this.pendingFrame) return;
      this.pendingFrame = true;
      const image = new Image();
      image.onload = () => {
        this.pendingFrame = false;
        const ctx = this.canvas.getContext('2d');
        ctx.drawImage(image, 0, 0, this.canvas.width, this.canvas.height);
        this.hideOverlay();
      };
      image.onerror = () => {
        this.pendingFrame = false;
      };
      image.src = `data:image/jpeg;base64,${msg.data}`;
    }

    setStatus(text, isError = false, showActions = false) {
      this.message.textContent = text;
      this.overlay.hidden = false;
      this.overlay.classList.toggle('error', isError);
      let actions = this.overlay.querySelector('.actions');
      if (showActions) {
        if (!actions) {
          actions = document.createElement('div');
          actions.className = 'actions';
          actions.innerHTML = '<button class="reload">Reload session</button>';
          actions.querySelector('.reload').addEventListener('click', () => this.reconnect(true));
          this.overlay.appendChild(actions);
        }
        actions.hidden = false;
      } else if (actions) {
        actions.hidden = true;
      }
    }

    hideOverlay() {
      if (!this.overlay.hidden) this.overlay.hidden = true;
    }

    // --------------------------------------------------------------- input

    bindInput() {
      const canvas = this.canvas;
      canvas.addEventListener('contextmenu', (e) => e.preventDefault());
      canvas.addEventListener('mousemove', (e) => this.mouse(e, 'mouseMoved'));
      canvas.addEventListener('mousedown', (e) => {
        canvas.focus();
        this.mouse(e, 'mousePressed', e.detail || 1);
      });
      canvas.addEventListener('mouseup', (e) => this.mouse(e, 'mouseReleased', e.detail || 1));
      canvas.addEventListener(
        'wheel',
        (e) => {
          e.preventDefault();
          this.send({
            type: 'wheel',
            event: {
              x: this.scaleX(e.clientX),
              y: this.scaleY(e.clientY),
              deltaX: e.deltaX,
              deltaY: e.deltaY,
              modifiers: modifierMask(e),
            },
          });
        },
        { passive: false }
      );

      canvas.addEventListener('keydown', (e) => {
        if (this.isClipboardShortcut(e)) return; // let the host handle copy/paste
        e.preventDefault();
        e.stopPropagation();
        const printable = e.key.length === 1;
        this.send({
          type: 'key',
          event: {
            type: printable ? 'keyDown' : 'rawKeyDown',
            key: e.key,
            code: e.code,
            keyCode: e.keyCode,
            text: printable ? e.key : undefined,
            modifiers: modifierMask(e),
          },
        });
      });

      canvas.addEventListener('keyup', (e) => {
        if (this.isClipboardShortcut(e)) return;
        e.preventDefault();
        e.stopPropagation();
        this.send({
          type: 'key',
          event: {
            type: 'keyUp',
            key: e.key,
            code: e.code,
            keyCode: e.keyCode,
            modifiers: modifierMask(e),
          },
        });
      });

      // Bi-directional text clipboard.
      document.addEventListener('copy', () => this.pushSelectionToRemote());
      document.addEventListener('cut', () => this.pushSelectionToRemote());
      document.addEventListener('paste', (e) => {
        const text = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
        if (text) this.send({ type: 'paste', text });
      });
    }

    isClipboardShortcut(e) {
      return (e.ctrlKey || e.metaKey) && ['c', 'v', 'x'].includes(e.key.toLowerCase());
    }

    pushSelectionToRemote() {
      const text = String(window.getSelection() || '');
      if (text) this.send({ type: 'clipboard', text });
    }

    async writeHostClipboard(text) {
      this.lastClipboard = text;
      this.dispatchEvent(new CustomEvent('clipboard', { detail: { text } }));
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text);
      } catch {
        console.log('[SDK] host clipboard write blocked (needs user gesture/permission)');
      }
    }

    mouse(e, type, clickCount = 0) {
      this.send({
        type: 'mouse',
        event: {
          type,
          x: this.scaleX(e.clientX),
          y: this.scaleY(e.clientY),
          button: e.button >= 0 ? buttonName(e.button) : 'none',
          buttons: e.buttons || 0,
          clickCount: clickCount || (type === 'mouseMoved' ? 0 : 1),
          modifiers: modifierMask(e),
        },
      });
    }

    scaleX(clientX) {
      const rect = this.canvas.getBoundingClientRect();
      return Math.round(((clientX - rect.left) / Math.max(1, rect.width)) * this.canvas.width);
    }

    scaleY(clientY) {
      const rect = this.canvas.getBoundingClientRect();
      return Math.round(((clientY - rect.top) / Math.max(1, rect.height)) * this.canvas.height);
    }

    // ------------------------------------------------- file / UI lifecycle

    triggerDownload(url, filename) {
      const absolute = url.startsWith('http') ? url : `${this.serverOrigin}${url}`;
      const anchor = document.createElement('a');
      anchor.href = absolute;
      anchor.download = filename || 'download';
      anchor.rel = 'noopener';
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      setTimeout(() => anchor.remove(), 1000);
      this.dispatchEvent(new CustomEvent('download', { detail: { url: absolute, filename } }));
      console.log(`[SDK] download triggered: ${filename}`);
    }

    requestUpload(chooserId, multiple) {
      if (this.pendingChooserId) return; // one chooser at a time
      this.pendingChooserId = chooserId;
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = Boolean(multiple);
      input.style.display = 'none';
      input.addEventListener('change', async () => {
        const files = Array.from(input.files || []);
        try {
          const ids = [];
          for (const file of files) {
            const res = await fetch(`${this.serverOrigin}/upload?name=${encodeURIComponent(file.name)}`, {
              method: 'POST',
              body: file,
              headers: { 'Content-Type': 'application/octet-stream' },
            });
            if (!res.ok) throw new Error(`upload failed (${res.status})`);
            const data = await res.json();
            ids.push(data.id);
          }
          this.send({ type: 'upload:result', id: chooserId, fileIds: ids });
        } catch (err) {
          console.warn(`[SDK] upload bridge failed: ${err.message}`);
          this.send({ type: 'upload:result', id: chooserId, fileIds: [] });
        } finally {
          this.pendingChooserId = null;
          input.remove();
        }
      });
      document.body.appendChild(input);
      input.click();
    }

    measure() {
      const rect = this.getBoundingClientRect();
      const width = Math.round(rect.width) || 1024;
      const height = Math.round(rect.height) || 640;
      if (width === this.viewport.width && height === this.viewport.height) return;
      this.viewport = { width, height };
      if (this.ready) this.send({ type: 'resize', viewport: this.viewport });
    }

    bindLifecycle() {
      document.addEventListener('visibilitychange', () => {
        this.send({ type: 'visibility', visible: !document.hidden });
      });
      window.addEventListener('beforeunload', () => {
        // Session survives: the server holds it for the reconnect grace window.
        this.intentionalClose = true;
      });
    }

    // ---------------------------------------------------------- public API

    navigate(url) {
      this.saveStoredState({ url });
      this.send({ type: 'navigate', url });
    }

    reload() {
      this.send({ type: 'navigate', url: this.getAttribute('src') || this.loadStoredState().url });
    }

    get status() {
      return { ready: this.ready, sessionId: this.sessionId, url: this.loadStoredState().url };
    }
  }

  if (!customElements.get('remote-browser')) {
    customElements.define('remote-browser', RemoteBrowser);
  }
  console.log('[SDK] <remote-browser> registered');
})();
