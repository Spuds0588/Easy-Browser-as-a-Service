'use strict';

/**
 * Explicit-teardown suite.
 *
 * Two ways to end a session now instead of waiting for a timeout:
 *   - the `close` WebSocket message (what <remote-browser>.endSession() sends)
 *   - DELETE /api/sessions/:id (ops)
 *
 * The service is spawned with a 60s reconnect grace on purpose: if a session
 * disappears within a second or two, it proves teardown bypassed the grace
 * rather than merely being lucky with the timing.
 *
 *   node test/teardown.js
 */

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const { KEY: RBAS_KEY, TOKEN, authHeaders } = require('./auth-helper');
const { resolveExecutablePath } = require('../server/browser');

const PORT = Number(process.env.E2E_TEARDOWN_PORT || 8195);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const GRACE_MS = 60_000;

const results = [];
let failures = 0;
const children = [];

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok) });
  if (!ok) failures += 1;
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, fn, { timeout = 15000, interval = 100 } = {}) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeout) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

async function activeSessions() {
  const res = await fetch(`${ORIGIN}/api/sessions`, { headers: authHeaders() });
  return (await res.json()).active;
}

/** Open a session and hand back the socket plus a promise for its close. */
function openSession({ timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const state = { closed: false, closeCode: null, lastMessage: null, frames: 0 };
    let ready = false;
    const timer = setTimeout(() => {
      if (!ready) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new Error('session did not become ready'));
      }
    }, timeout);

    ws.on('open', () =>
      ws.send(JSON.stringify({ type: 'init', token: TOKEN, url: 'about:blank', viewport: { width: 400, height: 300 } }))
    );
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      state.lastMessage = msg.type;
      if (msg.type === 'ready' && !ready) {
        ready = true;
        clearTimeout(timer);
        resolve({ ws, state, sessionId: msg.sessionId });
      }
      if (msg.type === 'closed') state.lastMessage = 'closed';
    });
    ws.on('close', (code) => {
      state.closed = true;
      state.closeCode = code;
    });
    ws.on('error', (err) => {
      if (!ready) {
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

function waitForClose(state, { timeout = 5000 } = {}) {
  return waitFor('socket close', async () => state.closed, { timeout, interval: 50 });
}

function startService() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
      env: {
        ...process.env,
        PORT: String(PORT),
        RBAS_KEY,
        RECONNECT_GRACE_MS: String(GRACE_MS),
        RBAS_TMP_DIR: path.join(os.tmpdir(), 'rbas-teardown'),
        PUPPETEER_EXECUTABLE_PATH: resolveExecutablePath() || '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let booted = false;
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      if (process.env.E2E_VERBOSE) process.stdout.write(`[svc] ${text}`);
      if (!booted && text.includes('listening on')) {
        booted = true;
        resolve(child);
      }
    });
    if (process.env.E2E_VERBOSE) child.stderr.on('data', (chunk) => process.stderr.write(`[svc] ${chunk}`));
    child.on('exit', (code) => {
      if (!booted) reject(new Error(`service exited early (code ${code})`));
    });
    setTimeout(() => {
      if (!booted) reject(new Error('service did not boot'));
    }, 30000);
  });
}

async function main() {
  console.log('\n=== Easy Browser-as-a-Service — explicit teardown ===');
  console.log(`reconnect grace under test: ${GRACE_MS}ms\n`);
  await startService();
  await waitFor('service health', async () => (await fetch(`${ORIGIN}/healthz`)).ok, { timeout: 45000 });

  // 1. the `close` message
  const first = await openSession();
  check('a session can be opened', /^sess_/.test(first.sessionId || ''), first.sessionId);
  check('the service reports one active session', (await activeSessions()) === 1);

  first.ws.send(JSON.stringify({ type: 'close', reason: 'teardown test' }));
  await waitForClose(first.state);
  check('close is acknowledged with a "closed" message', first.state.lastMessage === 'closed', `last=${first.state.lastMessage}`);
  check('close uses a clean close code 1000', first.state.closeCode === 1000, `code=${first.state.closeCode}`);

  const afterClose = await waitFor('session gone', async () => (await activeSessions()) === 0, { timeout: 4000 })
    .then(() => true)
    .catch(() => false);
  check(
    `close tears the context down immediately (well inside the ${GRACE_MS / 1000}s grace)`,
    afterClose,
    `active=${await activeSessions()}`
  );

  // 2. a plain disconnect still respects the grace — the contrast matters
  const second = await openSession();
  check('a second session opens', (await activeSessions()) === 1);
  second.ws.close();
  await waitForClose(second.state);
  await sleep(1200);
  check(
    'a bare disconnect still waits out the reconnect grace',
    (await activeSessions()) === 1,
    `active=${await activeSessions()} (grace is ${GRACE_MS / 1000}s)`
  );

  // 3. the HTTP kill switch
  const killRes = await fetch(`${ORIGIN}/api/sessions/${second.sessionId}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  const killBody = killRes.ok ? await killRes.json() : {};
  check('DELETE /api/sessions/:id closes it', killRes.status === 200 && killBody.closed === true, JSON.stringify(killBody));
  check('the killed session is gone at once', (await activeSessions()) === 0);

  check('DELETE without a token is 401', (await fetch(`${ORIGIN}/api/sessions/${second.sessionId}`, { method: 'DELETE' })).status === 401);
  const missing = await fetch(`${ORIGIN}/api/sessions/sess_deadbeefdeadbeef`, { method: 'DELETE', headers: authHeaders() });
  check('DELETE of an unknown session is 404', missing.status === 404);

  console.log(`\n=== ${results.length - failures}/${results.length} checks passed ===`);
  for (const r of results.filter((x) => !x.ok)) console.log(`  FAILED: ${r.name}`);
  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => {
    for (const child of children) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
    process.exit(code);
  })
  .catch((err) => {
    console.error(err.stack || err.message);
    for (const child of children) child.kill('SIGKILL');
    process.exit(1);
  });
