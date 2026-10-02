'use strict';

/**
 * Access-control suite.
 *
 * Two halves:
 *   1. a pure in-process matrix over server/auth.js (sign / verify / expiry /
 *      tamper / master key) — no browser required;
 *   2. integration against a real spawned server: HTTP guards, the /api/token
 *      exchange, and the WebSocket init gate.
 *
 *   node test/auth.js
 */

const crypto = require('crypto');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const { createAuth, generateKey } = require('../server/auth');
const { ipInNetworks, normalizeIp, parseNetworks, parseOrigins } = require('../server/trust');
const { resolveExecutablePath } = require('../server/browser');

const PORT = Number(process.env.E2E_AUTH_PORT || 8190);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const KEY = process.env.RBAS_TEST_KEY || 'rbas-auth-suite-key-0123456789abcdef0123456789';

const results = [];
let failures = 0;
const children = [];

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok) });
  if (!ok) failures += 1;
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, fn, { timeout = 20000, interval = 200 } = {}) {
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

/** Fire a request and return only its status, for concise gate assertions. */
async function status(pathname, init) {
  const res = await fetch(`${ORIGIN}${pathname}`, init);
  return res.status;
}

/**
 * Forge a token that verifies in every respect except expiry, so the expiry
 * check itself is exercised (sign() clamps TTLs to >= 1s, and the verifier
 * allows 30s of skew, so we cannot reach the past through the public API).
 */
function forgeExpiredToken(key, ageMs = 3600_000) {
  const payload = { iat: Date.now() - ageMs - 1000, exp: Date.now() - ageMs };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signingInput = `v1.${encoded}`;
  const signature = crypto.createHmac('sha256', key).update(signingInput).digest('base64url');
  return `${signingInput}.${signature}`;
}

async function wsAttempt(token, { timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const out = { ready: false, error: null, code: null, closeCode: null };
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(out);
    };
    ws.on('open', () =>
      ws.send(JSON.stringify({ type: 'init', token, url: 'about:blank', viewport: { width: 400, height: 300 } }))
    );
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'ready') {
        out.ready = true;
        finish();
      }
      if (msg.type === 'error') {
        out.error = msg.message;
        out.code = msg.code || null;
      }
    });
    ws.on('close', (code) => {
      out.closeCode = code;
      finish();
    });
    ws.on('error', (err) => {
      out.error = out.error || err.message;
      finish();
    });
    setTimeout(finish, timeout);
  });
}

function startService() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
      env: {
        ...process.env,
        PORT: String(PORT),
        RBAS_KEY: KEY,
        // The no-backend path: this origin may mint for itself, from loopback.
        RBAS_TRUSTED_ORIGINS: 'http://trusted.example',
        RBAS_TRUSTED_NETWORKS: '127.0.0.0/8,::1',
        RBAS_TMP_DIR: path.join(os.tmpdir(), 'rbas-auth'),
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

// ------------------------------------------------------------------ unit half

function unitMatrix() {
  console.log('\n=== in-process: server/auth.js ===');
  const auth = createAuth({ key: KEY, logger: { log() {}, warn() {}, error() {} } });

  const minted = auth.sign({ sub: 'alice', ttlMs: 60_000 });
  check('a freshly signed token verifies', auth.verify(minted.token).ok === true);
  check('the payload carries the subject', auth.verify(minted.token).payload.sub === 'alice');

  check('a missing token is rejected', auth.verify(undefined).ok === false);
  check('an empty token is rejected', auth.verify('').ok === false);
  check('a malformed token is rejected', auth.verify('not-a-token').ok === false);
  check('a token with too few segments is rejected', auth.verify('v1.abc').ok === false);
  check('an unknown version prefix is rejected', auth.verify(minted.token.replace(/^v1/, 'v2')).ok === false);

  const [head, body, sig] = minted.token.split('.');
  const tampered = `${head}.${body}.${sig.slice(0, -1)}${sig.slice(-1) === 'A' ? 'B' : 'A'}`;
  check('a tampered signature is rejected', auth.verify(tampered).ok === false);

  const swappedPayload = Buffer.from(JSON.stringify({ iat: Date.now(), exp: Date.now() + 60000, sub: 'mallory' })).toString(
    'base64url'
  );
  check('a swapped payload is rejected', auth.verify(`${head}.${swappedPayload}.${sig}`).ok === false);

  check('an expired token is rejected', auth.verify(forgeExpiredToken(KEY)).ok === false);

  const otherKey = createAuth({ key: generateKey(), logger: { log() {}, warn() {}, error() {} } });
  check('a token signed with another key is rejected', otherKey.verify(minted.token).ok === false);

  check('the master key itself is not a valid token', auth.verify(KEY).ok === false);
  check('verifyMasterKey accepts the signing key', auth.verifyMasterKey(KEY) === true);
  check('verifyMasterKey rejects anything else', auth.verifyMasterKey(`${KEY}x`) === false);

  // Stats for the integration half.
  return auth;
}

// -------------------------------------------------------------- trust matrix

function trustMatrix() {
  console.log('\n=== in-process: server/trust.js ===');
  const networks = parseNetworks('127.0.0.0/8,10.0.0.0/8,::1,fd00::/8,192.168.1.5');
  const cases = [
    ['127.0.0.1', true],
    ['::ffff:127.0.0.1', true],
    ['10.1.2.3', true],
    ['11.0.0.1', false],
    ['::1', true],
    ['fd00::1', true],
    ['192.168.1.5', true],
    ['192.168.1.6', false],
    ['not-an-ip', false],
  ];
  for (const [ip, expected] of cases) {
    check(`network allow-list: ${ip} -> ${expected}`, ipInNetworks(ip, networks) === expected);
  }
  check('an empty network list matches nothing', ipInNetworks('127.0.0.1', []) === false);
  check('IPv4-mapped addresses normalise', normalizeIp('::ffff:10.0.0.1') === '10.0.0.1');
  check('a zone index is stripped', normalizeIp('fe80::1%eth0') === 'fe80::1');
  check('origins drop a trailing slash', parseOrigins('https://a.example.com/, http://b.test')[0] === 'https://a.example.com');
  check('garbage network entries are ignored', parseNetworks('nonsense,10.0.0.0/99').length === 0);
}

// ----------------------------------------------------------- integration half

async function integration(auth) {
  console.log('\n=== against a running server ===');
  const token = auth.sign({ sub: 'suite', ttlMs: 300_000 }).token;

  check('GET /healthz stays open', (await status('/healthz')) === 200);
  check('GET /sdk.js stays open', (await status('/sdk.js')) === 200);

  check('GET /api/sessions without a token is 401', (await status('/api/sessions')) === 401);
  check(
    'GET /api/sessions with a token is 200',
    (await status('/api/sessions', { headers: { Authorization: `Bearer ${token}` } })) === 200
  );
  check(
    'GET /api/sessions with a garbage token is 401',
    (await status('/api/sessions', { headers: { Authorization: 'Bearer nope' } })) === 401
  );

  check('POST /upload without a token is 401', (await status('/upload?name=x', { method: 'POST' })) === 401);
  check('GET /download/:id without a token is 401', (await status('/download/abc')) === 401);
  check(
    'GET /download/:id with a query token gets past the gate',
    (await status(`/download/abc?token=${encodeURIComponent(token)}`)) === 404
  );

  check('POST /api/token without the master key is 401', (await status('/api/token', { method: 'POST' })) === 401);
  check(
    'POST /api/token with the wrong key is 401',
    (await status('/api/token', { method: 'POST', headers: { Authorization: 'Bearer wrong' } })) === 401
  );

  const mintRes = await fetch(`${ORIGIN}/api/token?ttl=5m&sub=bob`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}` },
  });
  const minted = mintRes.ok ? await mintRes.json() : {};
  check('POST /api/token with the master key mints a token', mintRes.status === 200 && typeof minted.token === 'string');
  const mintedCheck = minted.token ? auth.verify(minted.token) : { ok: false };
  check('the minted token verifies and keeps its subject', mintedCheck.ok === true && mintedCheck.payload.sub === 'bob');
  check(
    'the minted token unlocks /api/sessions',
    (await status('/api/sessions', { headers: { Authorization: `Bearer ${minted.token}` } })) === 200
  );

  // Demo page: zero-config, the server injects a working token.
  const demoRes = await fetch(`${ORIGIN}/demo.html`);
  const demoHtml = await demoRes.text();
  const demoToken = /sdk\.js\?token=([^"&]+)/.exec(demoHtml)?.[1];
  check('GET /demo.html injects a token into the sdk.js URL', Boolean(demoToken), demoToken ? 'found' : 'not found');
  check('the injected demo token verifies', Boolean(demoToken) && auth.verify(decodeURIComponent(demoToken)).ok === true);

  // No-backend path: an allow-listed origin mints for itself.
  const mintWithOrigin = (origin) =>
    fetch(`${ORIGIN}/api/token`, { method: 'POST', headers: origin ? { Origin: origin } : {} });

  const trusted = await mintWithOrigin('http://trusted.example');
  const trustedBody = trusted.ok ? await trusted.json() : {};
  check(
    'a trusted origin mints with no backend and no key',
    trusted.status === 200 && typeof trustedBody.token === 'string',
    `HTTP ${trusted.status}${trustedBody.reason ? ` (${trustedBody.reason})` : ''}`
  );
  check('the mint is labelled trusted-origin', trustedBody.via === 'trusted-origin', String(trustedBody.via));
  check('the self-minted token verifies', Boolean(trustedBody.token) && auth.verify(trustedBody.token).ok === true);

  const capped = await fetch(`${ORIGIN}/api/token?ttl=24h`, {
    method: 'POST',
    headers: { Origin: 'http://trusted.example' },
  });
  const cappedBody = capped.ok ? await capped.json() : {};
  const lifetimeMs = cappedBody.expiresAt ? cappedBody.expiresAt - Date.now() : Number.POSITIVE_INFINITY;
  check(
    'a browser-minted TTL is capped well below the 24h it asked for',
    lifetimeMs <= 15 * 60 * 1000 + 5000,
    `${Math.round(lifetimeMs / 1000)}s`
  );

  check('an untrusted origin is refused', (await mintWithOrigin('http://evil.example')).status === 401);
  check('a missing Origin header is refused', (await mintWithOrigin(null)).status === 401);

  // WebSocket gate.
  const noToken = await wsAttempt(undefined);
  check('WS init without a token is refused', noToken.ready === false && noToken.code === 'unauthorized');
  check('the refusal closes with policy code 1008', noToken.closeCode === 1008, `code=${noToken.closeCode}`);

  const badToken = await wsAttempt('v1.bogus.bogus');
  check('WS init with a bogus token is refused', badToken.ready === false && badToken.code === 'unauthorized');

  const active = await (await fetch(`${ORIGIN}/api/sessions`, { headers: { Authorization: `Bearer ${token}` } })).json();
  check('refused inits never created a session', active.active === 0, `active=${active.active}`);

  const good = await wsAttempt(token);
  check('WS init with a valid token reaches ready', good.ready === true, good.error || '');

  const after = await (
    await fetch(`${ORIGIN}/api/sessions`, { headers: { Authorization: `Bearer ${token}` } })
  ).json();
  check('the authorized socket opened exactly one session', after.active === 1, `active=${after.active}`);
}

async function main() {
  console.log('\n=== Easy Browser-as-a-Service — access control ===');
  const auth = unitMatrix();
  trustMatrix();

  let service = null;
  try {
    service = await startService();
  } catch (err) {
    console.log(`\n  ⚠️  could not start a server for the integration half: ${err.message}`);
    console.log('     (the unit matrix above still ran)');
  }

  if (service) {
    await waitFor('service health', async () => (await fetch(`${ORIGIN}/healthz`)).ok, { timeout: 45000 });
    await integration(auth);
  }

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
