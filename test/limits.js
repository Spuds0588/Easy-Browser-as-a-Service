'use strict';

/**
 * Resource policy tests — the per-IP session controls and the domain allow-list.
 *
 * Two halves:
 *   1. a pure unit matrix for the matchers (wildcards, schemes, token bucket,
 *      trusted-hop client IP) — no server needed;
 *   2. an integration half against one spawned service configured with the
 *      defaults under test (1 session/IP, a tiny new-session rate, and a target
 *      allow-list), driven over raw WebSockets so no host browser is required.
 *
 *   node test/limits.js
 */

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const { start: startFixtureApp } = require('./target-app');
const { resolveExecutablePath } = require('../server/browser');
const { KEY: RBAS_KEY, TOKEN: RBAS_TOKEN, authHeaders } = require('./auth-helper');
const { parseDomains, parseDomainRule, isAllowedTarget, hostMatches } = require('../server/targets');
const { parseRate, RateLimiter } = require('../server/ratelimit');
const { clientIpFromParts, clientIpFromRequest } = require('../server/clientip');

const PORT = Number(process.env.E2E_LIMITS_PORT || 8195);
const TARGET_PORT = Number(process.env.E2E_LIMITS_TARGET_PORT || 8196);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const TARGET_ORIGIN = `http://127.0.0.1:${TARGET_PORT}`;

const results = [];
let failures = 0;
const children = [];

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok) });
  if (!ok) failures += 1;
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(label, fn, { timeout = 20000, interval = 150 } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err.message;
    }
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}

// ----------------------------------------------------------------- unit matrix

function unitMatrix() {
  console.log('\n-- unit: domain allow-list --');
  const open = parseDomains('');
  check('an empty allow-list is open', open.open === true);
  check('"*" is open', parseDomains('*').open === true);
  check('about:blank is always allowed', isAllowedTarget('about:blank', parseDomains('example.com')).allowed === true);

  const bare = parseDomains('example.com');
  check('bare domain matches the apex', isAllowedTarget('https://example.com/x', bare).allowed === true);
  check('bare domain matches a subdomain', isAllowedTarget('https://app.example.com/', bare).allowed === true);
  check('bare domain does not match a lookalike', isAllowedTarget('https://notexample.com/', bare).allowed === false);
  check('bare domain does not match a suffix elsewhere', isAllowedTarget('https://example.com.evil.net/', bare).allowed === false);

  const wildcard = parseDomains('*.corp.internal');
  check('*.domain matches a subdomain', isAllowedTarget('https://vpn.corp.internal/', wildcard).allowed === true);
  check('*.domain still matches the apex', isAllowedTarget('https://corp.internal/', wildcard).allowed === true);
  check('*.domain rejects an unrelated host', isAllowedTarget('https://corp.invalid/', wildcard).allowed === false);

  const ipOnly = parseDomains('127.0.0.1');
  check('an IP literal matches exactly', isAllowedTarget('http://127.0.0.1:9000/x', ipOnly).allowed === true);
  check('an IP literal does not match a neighbour', isAllowedTarget('http://127.0.0.2/', ipOnly).allowed === false);

  const messy = parseDomains('https://app.example.com:8443/path');
  check('scheme/port/path are stripped from entries', isAllowedTarget('https://app.example.com/', messy).allowed === true);

  check('file:// is blocked even when open', isAllowedTarget('file:///etc/passwd', open).allowed === false);
  check('data: is blocked even when open', isAllowedTarget('data:text/html,hi', open).allowed === false);
  check('chrome: is blocked even when open', isAllowedTarget('chrome://settings/', open).allowed === false);
  check('http is allowed when open', isAllowedTarget('http://example.org/', open).allowed === true);

  const bad = parseDomains('http://');
  check('an unparseable entry is reported, not silently accepted', bad.invalid.length === 1 && bad.open === false);
  check('entries that fail to parse deny everything (fail closed)', isAllowedTarget('https://example.com/', bad).allowed === false);

  check('parseDomainRule tolerates a wildcard prefix', (parseDomainRule('*.a.b') || {}).host === 'a.b');
  check('hostMatches honours subdomains', hostMatches('x.y.com', [{ host: 'y.com', matchSubdomains: true }]) === true);

  console.log('\n-- unit: rate limiter --');
  check('20/min parses', parseRate('20/min').limit === 20 && parseRate('20/min').windowMs === 60000);
  check('5/sec parses', parseRate('5/sec').windowMs === 1000);
  check('100/hour parses', parseRate('100/hour').windowMs === 3600000);
  check('a bare number means per minute', parseRate('10').windowMs === 60000 && parseRate('10').limit === 10);
  check('0 disables the limiter', parseRate('0') === null);

  const limiter = new RateLimiter({ limit: 2, windowMs: 60000 });
  const t0 = 1_000_000;
  check('bucket allows a burst up to the limit', limiter.check('a', t0).allowed && limiter.check('a', t0).allowed);
  check('bucket then refuses', limiter.check('a', t0).allowed === false);
  check('buckets are per key', limiter.check('b', t0).allowed === true);
  check('bucket refills over time', limiter.check('a', t0 + 40000).allowed === true);
  limiter.check('stale', t0);
  limiter.prune(t0 + 10 * 60000);
  check('prune drops cold buckets', limiter.size === 0);

  console.log('\n-- unit: client IP --');
  check('no proxy uses the socket address', clientIpFromParts({ remoteAddress: '1.2.3.4', forwardedFor: '9.9.9.9', trustProxy: 0 }) === '1.2.3.4');
  check('one trusted hop uses the XFF client', clientIpFromParts({ remoteAddress: '1.2.3.4', forwardedFor: '9.9.9.9', trustProxy: 1 }) === '9.9.9.9');
  check('two hops walks the chain', clientIpFromParts({ remoteAddress: '1.2.3.4', forwardedFor: '9.9.9.9, 8.8.8.8', trustProxy: 2 }) === '8.8.8.8');
  check('IPv4-mapped IPv6 is normalised', clientIpFromParts({ remoteAddress: '::ffff:1.2.3.4', trustProxy: 0 }) === '1.2.3.4');
  check(
    'clientIpFromRequest reads headers',
    clientIpFromRequest({ socket: { remoteAddress: '1.2.3.4' }, headers: { 'x-forwarded-for': '9.9.9.9' } }, 1) === '9.9.9.9'
  );
}

// ----------------------------------------------------------- integration half

class SessionClient {
  constructor(ws) {
    this.ws = ws;
    this.messages = [];
    this.ready = false;
    this.failed = null;
    this.closed = false;
    this.closeCode = null;
  }

  static connect(url, { timeout = 30000 } = {}) {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
      const client = new SessionClient(ws);
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve(client);
      };
      ws.on('open', () =>
        ws.send(JSON.stringify({ type: 'init', token: RBAS_TOKEN, url, viewport: { width: 400, height: 300 } }))
      );
      ws.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        client.messages.push(msg);
        if (msg.type === 'ready') {
          client.ready = true;
          finish();
        }
        if (msg.type === 'error' && msg.code === 'limit') client.failed = msg;
      });
      ws.on('close', (code) => {
        client.closed = true;
        client.closeCode = code;
        finish();
      });
      ws.on('error', () => finish());
      setTimeout(finish, timeout);
    });
  }

  navigate(url) {
    this.ws.send(JSON.stringify({ type: 'navigate', url }));
  }

  has(predicate) {
    return this.messages.some(predicate);
  }

  waitForMessage(predicate, { timeout = 8000 } = {}) {
    const found = this.messages.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const onMessage = (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (predicate(msg)) {
          clearTimeout(timer);
          this.ws.off('message', onMessage);
          resolve(msg);
        }
      };
      const timer = setTimeout(() => {
        this.ws.off('message', onMessage);
        reject(new Error('timed out waiting for message'));
      }, timeout);
      this.ws.on('message', onMessage);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

async function activeCount() {
  const res = await fetch(`${ORIGIN}/api/sessions`, { headers: authHeaders() });
  const json = await res.json();
  return json.active;
}

async function closeSession(id) {
  const res = await fetch(`${ORIGIN}/api/sessions/${id}`, { method: 'DELETE', headers: authHeaders() });
  return res.status;
}

function startService() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
      env: {
        ...process.env,
        PORT: String(PORT),
        RBAS_KEY,
        // Deliberately the defaults/values under test:
        RBAS_MAX_SESSIONS_PER_IP: '1',
        RBAS_SESSION_RATE: '2/min',
        RBAS_ALLOWED_DOMAINS: '127.0.0.1',
        RBAS_TMP_DIR: path.join(os.tmpdir(), 'rbas-limits'),
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

async function integration() {
  console.log('\n-- integration: limits + target filter --');
  await startFixtureApp(TARGET_PORT, '127.0.0.1');
  await startService();
  await waitFor('service health', async () => (await fetch(`${ORIGIN}/healthz`)).ok, { timeout: 45000 });

  // A session whose *initial* URL is disallowed still opens, but lands on
  // about:blank and reports why. (First of two allowed session creations.)
  const blockedStart = await SessionClient.connect('http://example.com/');
  check('a session with a disallowed start URL still opens', blockedStart.ready === true);
  const startBlock = blockedStart.messages.find((m) => m.code === 'target_blocked');
  check('the disallowed start URL is reported as blocked', Boolean(startBlock), startBlock && startBlock.blockedUrl);

  // On that same session, an allowed host loads…
  blockedStart.navigate(`${TARGET_ORIGIN}/target.html`);
  const navigated = await blockedStart
    .waitForMessage((m) => m.type === 'url' && m.url.includes('target.html'), { timeout: 15000 })
    .catch(() => null);
  check('an allowed host navigates', Boolean(navigated), navigated && navigated.url);
  check('the allowed navigation raises no block', !blockedStart.has((m) => m.code === 'target_blocked' && m.blockedUrl.includes('target.html')));

  // …a disallowed host does not…
  blockedStart.navigate('http://example.com/');
  const domainBlock = await blockedStart
    .waitForMessage((m) => m.code === 'target_blocked' && m.blockedUrl.includes('example.com'), { timeout: 8000 })
    .catch(() => null);
  check('a disallowed domain is blocked', Boolean(domainBlock));
  check('the session stays on the allowed page after a block', blockedStart.has((m) => m.type === 'url' && m.url.includes('target.html')));

  // …file:// never loads…
  blockedStart.navigate('file:///etc/passwd');
  const fileBlock = await blockedStart
    .waitForMessage((m) => m.code === 'target_blocked' && m.blockedUrl.startsWith('file:'), { timeout: 8000 })
    .catch(() => null);
  check('file:// is blocked', Boolean(fileBlock));

  // …and a redirect to a disallowed host is caught by interception.
  blockedStart.navigate(`${TARGET_ORIGIN}/redirect?to=http://example.com/`);
  const redirectBlock = await blockedStart
    .waitForMessage((m) => m.code === 'target_blocked' && m.blockedUrl.includes('example.com'), { timeout: 10000 })
    .catch(() => null);
  check('a redirect to a disallowed host is blocked', Boolean(redirectBlock));

  // Second session while the first is live is refused by the per-IP cap.
  const concurrent = await SessionClient.connect(`${TARGET_ORIGIN}/target.html`);
  check('a second concurrent session from the same IP is refused', concurrent.ready === false && concurrent.failed !== null);
  check('the refusal carries code "limit"', concurrent.failed && concurrent.failed.code === 'limit');
  check('the refusal closes with 1013 (try again later)', concurrent.closeCode === 1013, `close=${concurrent.closeCode}`);
  check('still exactly one active session', (await activeCount()) === 1, `active=${await activeCount()}`);

  // Freeing the slot lets a new session in… (second of two allowed creations)
  const sessionId = blockedStart.messages.find((m) => m.type === 'ready').sessionId;
  check('DELETE closes the session', (await closeSession(sessionId)) === 200);
  await waitFor('slot freed', async () => (await activeCount()) === 0);

  const reuse = await SessionClient.connect(`${TARGET_ORIGIN}/target.html`);
  check('the slot is reusable after teardown', reuse.ready === true, reuse.failed && reuse.failed.message);
  const reuseId = reuse.messages.find((m) => m.type === 'ready').sessionId;
  check('independent session has a new id', reuseId !== sessionId);
  await closeSession(reuseId);
  await waitFor('slot freed again', async () => (await activeCount()) === 0);

  // …but the new-session rate (2/min) is now spent.
  const rateLimited = await SessionClient.connect(`${TARGET_ORIGIN}/target.html`);
  check('the new-session rate refuses a third creation', rateLimited.ready === false && rateLimited.failed !== null);
  check('the rate refusal carries code "limit"', rateLimited.failed && rateLimited.failed.code === 'limit');
  check('the rate refusal closes with 1013', rateLimited.closeCode === 1013, `close=${rateLimited.closeCode}`);

  blockedStart.close();
}

async function main() {
  console.log('\n=== Easy Browser-as-a-Service — resource limits ===');
  unitMatrix();
  try {
    await integration();
  } catch (err) {
    check('integration half ran to completion', false, err.message);
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
