'use strict';

/**
 * [BOOT] Easy Browser-as-a-Service — HTTP + WebSocket entry point.
 *
 * Stateless by design: the container holds no durable session state, only the
 * live IncognitoBrowserContexts and short-lived /tmp files that expire.
 */

const fsp = require('fs/promises');
const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const { createAuth, parseDuration } = require('./auth');
const { BrowserManager } = require('./browser');
const { FileStore, ROOT } = require('./files');
const { SessionManager } = require('./sessions');
const { evaluateBrowserTrust, parseNetworks, parseOrigins } = require('./trust');
const { parseDomains, describeDomains } = require('./targets');
const { parseRate, createRateLimiter } = require('./ratelimit');
const { clientIpFromRequest } = require('./clientip');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// No-backend browsers may mint for themselves from these origins/networks. Empty
// by default, which leaves the master key as the only way in.
const TRUSTED_ORIGINS = parseOrigins(process.env.RBAS_TRUSTED_ORIGINS);
const TRUSTED_NETWORKS = parseNetworks(process.env.RBAS_TRUSTED_NETWORKS);
const BROWSER_TOKEN_TTL_MS = parseDuration(process.env.RBAS_BROWSER_TOKEN_TTL_MS, 15 * 60 * 1000);

// Resource policy. Default: one concurrent session per address (this is a
// one-embedded-app product, not a tab farm) and an open target list.
const TRUST_PROXY = (() => {
  const value = Number(process.env.RBAS_TRUST_PROXY);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
})();
const MAX_SESSIONS_PER_IP = (() => {
  const raw = process.env.RBAS_MAX_SESSIONS_PER_IP;
  if (raw === undefined || raw === '') return 1;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 1;
})();
const SESSION_RATE = parseRate(process.env.RBAS_SESSION_RATE, { limit: 20, windowMs: 60_000 });
const ALLOWED_DOMAINS = parseDomains(process.env.RBAS_ALLOWED_DOMAINS);

const logger = {
  log: (...args) => console.log(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
};

async function main() {
  const auth = createAuth({ logger });
  const files = new FileStore({ logger });
  const browser = new BrowserManager({ logger });
  const sessionLimiter = createRateLimiter(SESSION_RATE);
  const sessions = new SessionManager({
    browser,
    files,
    auth,
    targets: ALLOWED_DOMAINS,
    sessionLimiter,
    config: { maxSessionsPerIp: MAX_SESSIONS_PER_IP, trustProxy: TRUST_PROXY },
    logger,
  });

  await browser.launch();

  const app = express();
  app.disable('x-powered-by');

  // Behind a proxy the socket address is the proxy's, so let the operator say
  // how many hops to trust. Wrong values make the IP allow-list meaningless.
  if (TRUST_PROXY > 0) app.set('trust proxy', TRUST_PROXY);

  // Embeds live on other origins, so the HTTP bridges must be CORS-open.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  });

  // ---------------------------------------------------------------- HTTP API

  app.get('/healthz', (_req, res) => {
    res.json({
      ok: true,
      uptime: Math.round(process.uptime()),
      sessions: sessions.stats,
      browser: browser.browser ? { connected: browser.browser.connected, version: browser.version } : { connected: false },
      tmp: ROOT,
    });
  });

  // Token mint, two ways in:
  //   1. the master signing key (server-to-server) — full trust, any TTL;
  //   2. a trusted origin + trusted network (a browser with no backend) —
  //      short-lived token only. See server/trust.js for what each proves.
  app.post('/api/token', (req, res) => {
    // Minting is cheap, but an open trusted-origin endpoint should not be a free
    // flood target. Bucketed separately from session creation so a page that
    // mints on load never eats into its owner's session budget.
    if (sessionLimiter) {
      const ip = clientIpFromRequest(req, TRUST_PROXY);
      if (ip) {
        const gate = sessionLimiter.check(`token:${ip}`);
        if (!gate.allowed) {
          res.setHeader('Retry-After', String(Math.max(1, Math.ceil((gate.retryAfterMs || 0) / 1000))));
          return res.status(429).json({ error: 'rate_limited', retryAfterMs: gate.retryAfterMs });
        }
      }
    }

    const provided = auth.tokenFromRequest(req);
    const ttl = parseDuration(req.query.ttl, auth.defaultTtlMs);

    if (auth.verifyMasterKey(provided)) {
      const { token, expiresAt } = auth.sign({ sub: req.query.sub || 'api', ttlMs: ttl });
      return res.json({ token, expiresAt, via: 'master-key' });
    }

    const trust = evaluateBrowserTrust(req, { origins: TRUSTED_ORIGINS, networks: TRUSTED_NETWORKS });
    if (trust.ok) {
      const capped = Math.min(ttl, BROWSER_TOKEN_TTL_MS);
      const { token, expiresAt } = auth.sign({ sub: `origin:${trust.origin}`, ttlMs: capped });
      return res.json({ token, expiresAt, via: 'trusted-origin' });
    }

    res.setHeader('WWW-Authenticate', 'Bearer realm="rbas"');
    return res.status(401).json({ error: 'unauthorized', reason: trust.reason });
  });

  // Ops teardown: end one session now instead of waiting for a timeout.
  app.delete('/api/sessions/:id', auth.httpGuard(), async (req, res) => {
    const closed = await sessions.closeById(req.params.id, 'requested over HTTP');
    if (!closed) return res.status(404).json({ error: 'no such session', id: req.params.id });
    return res.json({ closed: true, id: req.params.id });
  });

  app.get('/api/sessions', auth.httpGuard(), (_req, res) => {
    res.json({
      ...sessions.stats,
      items: [...sessions.sessions.values()].map((s) => ({
        id: s.id,
        url: s.lastUrl,
        visible: s.visible,
        idleMs: Date.now() - s.lastActivity,
      })),
    });
  });

  // Upload bridge: the SDK POSTs the raw bytes it got from the host file picker.
  app.post(
    '/upload',
    auth.httpGuard(),
    express.raw({ type: () => true, limit: process.env.MAX_UPLOAD || '200mb' }),
    async (req, res) => {
      try {
        const filename = String(req.query.name || 'upload');
        const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
        if (!body.length) return res.status(400).json({ error: 'empty body' });
        const entry = await files.storeUpload(filename, body);
        res.json({ id: entry.id, filename: entry.filename, bytes: body.length });
      } catch (err) {
        logger.error(`[UPLOAD] failed: ${err.message}`);
        res.status(500).json({ error: err.message });
      }
    }
  );

  // Download bridge: short-lived link the SDK triggers on the host page. The
  // SDK appends ?token= because a click-through navigation cannot set headers.
  app.get('/download/:id', auth.httpGuard(), (req, res) => {
    const entry = files.get(req.params.id);
    if (!entry || entry.kind !== 'download') return res.status(404).send('Download expired or not found');
    res.download(entry.path, entry.filename, (err) => {
      if (err && !res.headersSent) res.status(500).end();
    });
  });

  // Bundled demo: hand it a freshly minted token so a local install needs no
  // configuration. The token is injected into the sdk.js URL, which the SDK
  // reads back off its own <script> tag.
  app.get(['/demo.html', '/demo'], async (_req, res, next) => {
    try {
      const html = await fsp.readFile(path.join(PUBLIC_DIR, 'demo.html'), 'utf8');
      const { token } = auth.sign({ sub: 'demo' });
      res.type('html').send(html.replace('src="/sdk.js"', `src="/sdk.js?token=${encodeURIComponent(token)}"`));
    } catch (err) {
      next(err);
    }
  });

  app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
  app.get('/', (_req, res) => res.redirect('/demo.html'));

  app.use((err, _req, res, _next) => {
    logger.error(`[HTTP] ${err.message}`);
    res.status(500).json({ error: err.message });
  });

  // ---------------------------------------------------------------- WebSocket

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 * 1024 });

  wss.on('connection', (ws, req) => {
    logger.log(`[WS] client connected from ${req.socket.remoteAddress}`);
    sessions.handleConnection(ws, req);
  });

  browser.onCrash = async () => {
    logger.error('[BOOT] attempting master browser relaunch…');
    try {
      await browser.launch();
      logger.log('[BOOT] master browser relaunched');
    } catch (err) {
      logger.error(`[BOOT] relaunch failed: ${err.message}`);
    }
  };

  server.listen(PORT, HOST, () => {
    logger.log(
      `[BOOT] auth: enforcing signed tokens (key id ${auth.keyId}, ttl ${Math.round(auth.defaultTtlMs / 1000)}s)`
    );
    logger.log(
      `[BOOT] limits: max ${MAX_SESSIONS_PER_IP > 0 ? `${MAX_SESSIONS_PER_IP} concurrent session(s)/IP` : 'unlimited sessions/IP'}` +
        `${sessionLimiter ? `, ${sessionLimiter.describe()}/IP` : ''}`
    );
    logger.log(`[BOOT] targets: ${describeDomains(ALLOWED_DOMAINS)}`);
    if (ALLOWED_DOMAINS.invalid && ALLOWED_DOMAINS.invalid.length) {
      logger.warn(
        `[TARGETS] could not parse these RBAS_ALLOWED_DOMAINS entries and ignored them: ${ALLOWED_DOMAINS.invalid.join(', ')}`
      );
    }
    if (TRUSTED_ORIGINS.length) {
      logger.log(
        `[BOOT] auth: browsers may self-mint from ${TRUSTED_ORIGINS.join(', ')} ` +
          `(ttl ${Math.round(BROWSER_TOKEN_TTL_MS / 1000)}s, networks: ${TRUSTED_NETWORKS.map((n) => n.raw).join(', ') || 'ANY'})`
      );
      if (!TRUSTED_NETWORKS.length) {
        logger.warn(
          '[AUTH] RBAS_TRUSTED_ORIGINS is set without RBAS_TRUSTED_NETWORKS. The Origin header is not\n' +
            '[AUTH] a secret: a non-browser client that can reach this port can forge it and mint tokens.\n' +
            '[AUTH] Set RBAS_TRUSTED_NETWORKS to the addresses your browsers come from.'
        );
      }
    }
    logger.log(`[BOOT] Easy Browser-as-a-Service listening on http://localhost:${PORT} (bind ${HOST})`);
    logger.log(`[BOOT] SDK:   http://localhost:${PORT}/sdk.js`);
    logger.log(`[BOOT] Demo:  http://localhost:${PORT}/demo.html`);
    logger.log(`[BOOT] WS:    ws://localhost:${PORT}/ws`);
  });

  const shutdown = async (signal) => {
    logger.log(`[BOOT] ${signal} received, shutting down…`);
    wss.close();
    server.close();
    await sessions.shutdown();
    await browser.close();
    files.dispose();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(`[BOOT] fatal: ${err.stack || err.message}`);
  process.exit(1);
});
