'use strict';

/**
 * Zombie-session probe. Connects a raw WebSocket, starts a session, then sends
 * nothing and waits to be told the session expired.
 *
 *   node test/idle-probe.js 8131
 */

const WebSocket = require('ws');
const { TOKEN } = require('./auth-helper');

function probeIdleExpiry(port, { timeoutMs = 15000, host = 'localhost', url = 'about:blank', token = TOKEN } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = new WebSocket(`ws://${host}:${port}/ws`);
    let expired = false;
    let reason = null;

    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'init', token, url, viewport: { width: 640, height: 480 } }));
    });

    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'expired') {
          expired = true;
          reason = msg.reason || null;
        }
      } catch {
        /* ignore non-JSON */
      }
    });

    socket.on('error', (err) => resolve({ expired: false, error: err.message, elapsedMs: Date.now() - started }));

    socket.on('close', () => resolve({ expired, reason, elapsedMs: Date.now() - started }));

    setTimeout(() => {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
    }, timeoutMs);
  });
}

if (require.main === module) {
  const port = Number(process.argv[2] || process.env.PORT || 8080);
  probeIdleExpiry(port).then((result) => {
    console.log(JSON.stringify({ port, ...result }));
    process.exit(result.expired ? 0 : 1);
  });
}

module.exports = { probeIdleExpiry };
