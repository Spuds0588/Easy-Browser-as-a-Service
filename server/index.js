'use strict';

/**
 * [BOOT] Easy Browser-as-a-Service — HTTP + WebSocket entry point.
 *
 * Stateless by design: the container holds no durable session state, only the
 * live IncognitoBrowserContexts and short-lived /tmp files that expire.
 */

const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const { BrowserManager } = require('./browser');
const { FileStore, ROOT } = require('./files');
const { SessionManager } = require('./sessions');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const logger = {
  log: (...args) => console.log(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
};

async function main() {
  const files = new FileStore({ logger });
  const browser = new BrowserManager({ logger });
  const sessions = new SessionManager({ browser, files, logger });

  await browser.launch();

  const app = express();
  app.disable('x-powered-by');

  // Embeds live on other origins, so the HTTP bridges must be CORS-open.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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

  app.get('/api/sessions', (_req, res) => {
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

  // Download bridge: short-lived link the SDK triggers on the host page.
  app.get('/download/:id', (req, res) => {
    const entry = files.get(req.params.id);
    if (!entry || entry.kind !== 'download') return res.status(404).send('Download expired or not found');
    res.download(entry.path, entry.filename, (err) => {
      if (err && !res.headersSent) res.status(500).end();
    });
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
    sessions.handleConnection(ws);
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
