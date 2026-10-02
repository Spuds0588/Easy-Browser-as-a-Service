'use strict';

/**
 * [SESSIONS] Session registry, deep-link resume, and zombie reaping.
 *
 * Tiered timeouts (all env-tunable):
 *   - RECONNECT_GRACE_MS: after a socket drops we keep the context warm so a
 *     parent-page reload can resume the exact same remote session.
 *   - IDLE_TIMEOUT_MS: no input for this long -> free the container resources.
 *   - HIDDEN_TIMEOUT_MS: the embedding tab stayed hidden (visibility API) ->
 *     reap sooner, because an invisible session is burning money.
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');
const { RemoteSession } = require('./session');

const DEFAULTS = {
  reconnectGraceMs: Number(process.env.RECONNECT_GRACE_MS || 60_000),
  idleTimeoutMs: Number(process.env.IDLE_TIMEOUT_MS || 10 * 60_000),
  hiddenTimeoutMs: Number(process.env.HIDDEN_TIMEOUT_MS || 3 * 60_000),
  maxSessions: Number(process.env.MAX_SESSIONS || 8),
  sweepMs: Number(process.env.SWEEP_MS || 15_000),
};

class Connection extends EventEmitter {
  constructor(ws, logger = console) {
    super();
    this.ws = ws;
    this.logger = logger;
    this.closed = false;
    ws.on('close', () => {
      this.closed = true;
      this.emit('close', this);
    });
    ws.on('error', (err) => this.logger.warn(`[WS] socket error: ${err.message}`));
  }

  isOpen() {
    return !this.closed && this.ws.readyState === 1; // ws.OPEN
  }

  send(data) {
    if (!this.isOpen()) return false;
    this.ws.send(data);
    return true;
  }

  close(code, reason) {
    try {
      this.ws.close(code, reason);
    } catch {
      /* already closing */
    }
  }
}

class SessionManager {
  constructor({ browser, files, config = {}, logger = console }) {
    this.browser = browser;
    this.files = files;
    this.config = { ...DEFAULTS, ...config };
    this.logger = logger;
    this.sessions = new Map();
    this.reapTimers = new Map();
    this.sweeper = setInterval(() => this.sweepIdle(), this.config.sweepMs);
    if (this.sweeper.unref) this.sweeper.unref();
  }

  get stats() {
    return { active: this.sessions.size, max: this.config.maxSessions };
  }

  /**
   * Entry point for a new WebSocket. The first message must be `init`.
   * Returns a cleanup function.
   */
  handleConnection(ws) {
    const connection = new Connection(ws, this.logger);
    let session = null;
    let bootstrapping = false;

    const onMessage = async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        this.logger.warn('[WS] dropped malformed message');
        return;
      }

      if (!session) {
        if (msg.type !== 'init') {
          connection.send(JSON.stringify({ type: 'error', message: 'First message must be init' }));
          return;
        }
        if (bootstrapping) return;
        bootstrapping = true;
        try {
          session = await this.initSession(msg, connection);
        } catch (err) {
          this.logger.error(`[SESSIONS] init failed: ${err.stack || err.message}`);
          connection.send(JSON.stringify({ type: 'error', message: `Could not start session: ${err.message}` }));
          connection.close(1011, 'init failed');
        } finally {
          bootstrapping = false;
        }
        return;
      }

      try {
        await session.handleMessage(msg);
      } catch (err) {
        this.logger.warn(`[SESSIONS ${session.id}] message ${msg.type} failed: ${err.message}`);
        session.send({ type: 'error', message: err.message });
      }
    };

    ws.on('message', onMessage);
    connection.on('close', () => {
      ws.off('message', onMessage);
      if (session) this.beginGrace(session);
    });

    return () => connection.close();
  }

  async initSession(msg, connection) {
    const sessionId = typeof msg.sessionId === 'string' && this.sessions.has(msg.sessionId) ? msg.sessionId : null;
    const existing = sessionId ? this.sessions.get(sessionId) : null;

    if (existing && !existing.closed) {
      this.logger.log(`[SESSIONS] resuming ${existing.id} (deep-link resilience)`);
      this.cancelGrace(existing);
      existing.attach(connection, { resumed: true });
      // The live context is authoritative — never replay stale host state over
      // it. Instead push the live state back so the host catches up.
      existing.emitState({});
      return existing;
    }

    if (this.sessions.size >= this.config.maxSessions) {
      throw new Error(`capacity reached (${this.sessions.size}/${this.config.maxSessions}) — try again shortly`);
    }

    const id = `sess_${crypto.randomBytes(8).toString('hex')}`;
    const context = await this.browser.createContext();
    const session = new RemoteSession({
      id,
      context,
      files: this.files,
      config: msg.config || {},
      logger: this.logger,
    });

    this.wireSession(session);

    try {
      await session.bootstrap({ url: msg.url, viewport: msg.viewport, state: msg.state });
    } catch (err) {
      await session.close().catch(() => {});
      throw err;
    }

    this.sessions.set(id, session);
    session.attach(connection, { resumed: false });
    this.logger.log(`[SESSIONS] created ${id} (active=${this.sessions.size})`);
    return session;
  }

  wireSession(session) {
    session.on('activity', () => {
      session.hiddenSince = null;
    });
    session.on('visibility', (visible) => {
      session.hiddenSince = visible ? null : Date.now();
      this.logger.log(`[SESSIONS ${session.id}] visibility=${visible ? 'visible' : 'hidden'}`);
    });
    session.on('closed', () => this.forget(session));
    session.on('pageclosed', () => this.destroy(session, 'remote browser closed'));
  }

  /** Socket dropped: keep the context warm for a short reconnect window. */
  beginGrace(session) {
    if (session.closed) return;
    this.logger.log(`[SESSIONS ${session.id}] socket closed; grace ${this.config.reconnectGraceMs}ms`);
    this.cancelGrace(session);
    const timer = setTimeout(() => this.destroy(session, 'disconnect grace expired'), this.config.reconnectGraceMs);
    if (timer.unref) timer.unref();
    this.reapTimers.set(session.id, timer);
  }

  cancelGrace(session) {
    const timer = this.reapTimers.get(session.id);
    if (timer) {
      clearTimeout(timer);
      this.reapTimers.delete(session.id);
    }
  }

  async destroy(session, reason) {
    if (!session || session.closed) return;
    this.logger.log(`[SESSIONS ${session.id}] reaping: ${reason}`);
    session.send({ type: 'expired', reason });
    setTimeout(() => {
      if (session.sink) session.sink.close(1000, 'session expired');
    }, 250).unref?.();
    await session.close().catch(() => {});
  }

  forget(session) {
    this.cancelGrace(session);
    if (this.sessions.get(session.id) === session) this.sessions.delete(session.id);
  }

  sweepIdle() {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (session.closed || !session.sink) continue; // only reap attached sessions
      const idleFor = now - session.lastActivity;
      const limit = session.visible === false ? this.config.hiddenTimeoutMs : this.config.idleTimeoutMs;
      if (idleFor > limit) {
        this.destroy(session, `idle for ${Math.round(idleFor / 1000)}s (${session.visible ? 'visible' : 'hidden'})`);
      }
    }
  }

  async shutdown() {
    clearInterval(this.sweeper);
    for (const timer of this.reapTimers.values()) clearTimeout(timer);
    this.reapTimers.clear();
    await Promise.all([...this.sessions.values()].map((session) => session.close().catch(() => {})));
    this.sessions.clear();
  }
}

module.exports = { SessionManager, Connection };
