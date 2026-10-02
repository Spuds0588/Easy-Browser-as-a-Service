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
const { clientIpFromRequest } = require('./clientip');

// Like `Number(x || fallback)`, but 0 is a real value here (0 = unlimited).
function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

const DEFAULTS = {
  reconnectGraceMs: intEnv('RECONNECT_GRACE_MS', 60_000),
  idleTimeoutMs: intEnv('IDLE_TIMEOUT_MS', 10 * 60_000),
  hiddenTimeoutMs: intEnv('HIDDEN_TIMEOUT_MS', 3 * 60_000),
  maxSessions: intEnv('MAX_SESSIONS', 8),
  sweepMs: intEnv('SWEEP_MS', 15_000),
  // Concurrent sessions from a single client address. 0 = unlimited. Default 1,
  // because the product is one embedded app per user, not a tab farm.
  maxSessionsPerIp: intEnv('RBAS_MAX_SESSIONS_PER_IP', 1),
  // Trusted proxy hops, so the WS path resolves the real client IP like Express.
  trustProxy: intEnv('RBAS_TRUST_PROXY', 0),
};

class Connection extends EventEmitter {
  constructor(ws, logger = console, ip = null) {
    super();
    this.ws = ws;
    this.logger = logger;
    this.closed = false;
    this.remote = ws._socket && ws._socket.remoteAddress;
    this.ip = ip; // normalised client address (honours trust proxy)
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
  constructor({ browser, files, auth = null, targets = null, sessionLimiter = null, config = {}, logger = console }) {
    this.browser = browser;
    this.files = files;
    this.auth = auth;
    this.targets = targets;
    this.sessionLimiter = sessionLimiter;
    this.config = { ...DEFAULTS, ...config };
    this.logger = logger;
    this.sessions = new Map();
    this.reapTimers = new Map();
    this.sweeper = setInterval(() => this.sweepIdle(), this.config.sweepMs);
    if (this.sweeper.unref) this.sweeper.unref();
  }

  get stats() {
    return {
      active: this.sessions.size,
      max: this.config.maxSessions,
      maxPerIp: this.config.maxSessionsPerIp,
    };
  }

  /** Live (not closed) sessions owned by one client address. */
  countByIp(ip) {
    if (!ip) return 0;
    let count = 0;
    for (const session of this.sessions.values()) {
      if (!session.closed && session.ip === ip) count += 1;
    }
    return count;
  }

  /**
   * Entry point for a new WebSocket. The first message must be `init`.
   * Returns a cleanup function.
   */
  handleConnection(ws, req = null) {
    const ip = clientIpFromRequest(req, this.config.trustProxy);
    const connection = new Connection(ws, this.logger, ip);
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
        // Gate every session on a valid token *before* any browser context is
        // created, so an unauthenticated peer can never cost us a Chromium.
        const granted = this.auth ? this.auth.verifyInit(msg) : { ok: false, reason: 'auth not configured' };
        if (!granted.ok) {
          this.logger.warn(`[AUTH] rejected session init from ${connection.remote || 'unknown'}: ${granted.reason}`);
          connection.send(JSON.stringify({ type: 'error', code: 'unauthorized', message: 'Unauthorized' }));
          connection.close(1008, 'unauthorized');
          return;
        }
        bootstrapping = true;
        try {
          session = await this.initSession(msg, connection);
        } catch (err) {
          const limited = err && err.code === 'limit';
          if (limited) {
            this.logger.warn(`[SESSIONS] rejecting ${connection.ip || 'unknown'}: ${err.message}`);
          } else {
            this.logger.error(`[SESSIONS] init failed: ${err.stack || err.message}`);
          }
          connection.send(
            JSON.stringify({
              type: 'error',
              code: limited ? 'limit' : undefined,
              message: limited ? err.message : `Could not start session: ${err.message}`,
            })
          );
          // 1013 = Try Again Later; 1011 = internal error.
          connection.close(limited ? 1013 : 1011, limited ? 'session limit' : 'init failed');
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
      existing.attach(connection);
      existing.sendReady(true);
      // The live context is authoritative — never replay stale host state over
      // it. Instead push the live state back so the host catches up.
      existing.emitState({});
      return existing;
    }

    // Per-IP concurrency: the product is one embedded app per person, so a
    // second concurrent context from the same address is almost always a
    // mistake — and it always costs real memory. Checked before the global cap
    // so the client gets an actionable reason rather than "server full".
    const ip = connection.ip || null;
    if (this.config.maxSessionsPerIp > 0 && ip) {
      const mine = this.countByIp(ip);
      if (mine >= this.config.maxSessionsPerIp) {
        const err = new Error(
          this.config.maxSessionsPerIp === 1
            ? 'You already have an active session. Close it before starting another.'
            : `Too many active sessions from your address (${mine}/${this.config.maxSessionsPerIp}).`
        );
        err.code = 'limit';
        throw err;
      }
    }

    if (this.sessions.size >= this.config.maxSessions) {
      throw new Error(`capacity reached (${this.sessions.size}/${this.config.maxSessions}) — try again shortly`);
    }

    // New-session rate: stops close-then-reinit churn from minting contexts in a
    // tight loop. Reconnects and resumes never reach here, so this only bounds
    // genuinely new sessions.
    if (this.sessionLimiter && ip) {
      const gate = this.sessionLimiter.check(ip);
      if (!gate.allowed) {
        const err = new Error(
          `Too many new sessions — try again in ${Math.max(1, Math.ceil((gate.retryAfterMs || 0) / 1000))}s.`
        );
        err.code = 'limit';
        throw err;
      }
    }

    const id = `sess_${crypto.randomBytes(8).toString('hex')}`;
    const context = await this.browser.createContext();
    const session = new RemoteSession({
      id,
      context,
      files: this.files,
      targets: this.targets,
      config: msg.config || {},
      logger: this.logger,
    });
    session.ip = ip;

    this.wireSession(session);
    this.sessions.set(id, session);
    // Bind the socket before bootstrapping so setup-time messages reach the
    // client, and register the session first so a mid-bootstrap disconnect is
    // still reapable.
    session.attach(connection);

    try {
      await session.bootstrap({ url: msg.url, viewport: msg.viewport, state: msg.state });
    } catch (err) {
      await session.close().catch(() => {});
      this.forget(session);
      throw err;
    }

    session.sendReady(false);
    // The client may have vanished while the page was loading; start the
    // disconnect grace ourselves or the context would linger unreaped.
    if (!session.sink) this.beginGrace(session);
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
    session.on('closerequested', (reason) => this.closeById(session.id, reason || 'client requested'));
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

  async destroy(session, reason, { type = 'expired' } = {}) {
    if (!session || session.closed) return;
    this.logger.log(`[SESSIONS ${session.id}] reaping: ${reason}`);
    session.send({ type, reason });
    setTimeout(() => {
      if (session.sink) session.sink.close(1000, type === 'closed' ? 'session closed' : 'session expired');
    }, 250).unref?.();
    await session.close().catch(() => {});
  }

  /**
   * End a session now, by id. Used by the `close` WebSocket message and by
   * DELETE /api/sessions/:id — both bypass the reconnect grace on purpose:
   * the whole point is to stop paying for the context immediately.
   */
  async closeById(id, reason = 'client requested') {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.cancelGrace(session);
    await this.destroy(session, reason, { type: 'closed' });
    return true;
  }

  forget(session) {
    this.cancelGrace(session);
    if (this.sessions.get(session.id) === session) this.sessions.delete(session.id);
  }

  sweepIdle() {
    const now = Date.now();
    if (this.sessionLimiter) this.sessionLimiter.prune(now);
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
    if (this.sessionLimiter) this.sessionLimiter.buckets.clear();
    for (const timer of this.reapTimers.values()) clearTimeout(timer);
    this.reapTimers.clear();
    await Promise.all([...this.sessions.values()].map((session) => session.close().catch(() => {})));
    this.sessions.clear();
  }
}

module.exports = { SessionManager, Connection };
