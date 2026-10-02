'use strict';

/**
 * End-to-end test: drives the real product the way a first user would.
 *
 *   host page (origin :8092)  --embeds-->  <remote-browser>
 *        |                                       |
 *        |  SDK over ws://localhost:8090/ws      |
 *        v                                       v
 *   service (origin :8090)  <---CDP--->  remote Chromium
 *                                               |
 *                          target CRM (origin :8091)
 *
 * Asserts: connection, canvas rendering, mouse + keyboard passthrough,
 * bi-directional text clipboard, upload bridge, download bridge, deep-link
 * resume, reconnect-grace reaping and idle (zombie) expiry.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');

const { start: startFixtureApp } = require('./target-app');
const { probeIdleExpiry } = require('./idle-probe');
const { resolveExecutablePath } = require('../server/browser');
const { KEY: RBAS_KEY, TOKEN: RBAS_TOKEN, authHeaders } = require('./auth-helper');

// By default this suite spawns the service itself. Point it at an already
// running deployment instead (e.g. a Docker container) with:
//
//   E2E_SERVICE_ORIGIN=http://localhost:8130 \
//   E2E_TARGET_ORIGIN=http://host.docker.internal:8091 \
//   E2E_BIND=0.0.0.0 E2E_SKIP_IDLE=1 node test/e2e.js
//
const EXTERNAL_SERVICE = process.env.E2E_SERVICE_ORIGIN || '';
const SPAWN_SERVICE = !EXTERNAL_SERVICE;

const SERVICE_PORT = Number(process.env.E2E_SERVICE_PORT || 8090);
const TARGET_PORT = Number(process.env.E2E_TARGET_PORT || SERVICE_PORT + 1);
const HOST_PORT = Number(process.env.E2E_HOST_PORT || SERVICE_PORT + 2);
const IDLE_PORT = Number(process.env.E2E_IDLE_PORT || SERVICE_PORT + 3);

const SERVICE_ORIGIN = EXTERNAL_SERVICE || `http://localhost:${SERVICE_PORT}`;
const IDLE_ORIGIN = `http://localhost:${IDLE_PORT}`;
const TARGET_ORIGIN = process.env.E2E_TARGET_ORIGIN || `http://localhost:${TARGET_PORT}`;
const HOST_ORIGIN = `http://127.0.0.1:${HOST_PORT}`;
const FIXTURE_BIND = process.env.E2E_BIND || '127.0.0.1';
const RUN_IDLE_TEST = SPAWN_SERVICE && process.env.E2E_SKIP_IDLE !== '1';
const ONLY = process.env.E2E_ONLY || '';
// Self-spawned services run with a 4s grace; an external deployment normally
// uses the shipped 60s default, so give it room unless told otherwise.
const GRACE_WAIT_MS = Number(process.env.E2E_GRACE_WAIT_MS || (SPAWN_SERVICE ? 20000 : 90000));

const results = [];
let failures = 0;
const children = [];
let browser;
let tmpRoot;

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok) });
  if (!ok) failures += 1;
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(label, fn, { timeout = 15000, interval = 150 } = {}) {
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

async function fetchJson(base, route) {
  const res = await fetch(`${base}${route}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`${route} -> HTTP ${res.status}`);
  return res.json();
}

// --------------------------------------------------------------- test steps

async function main() {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'rbas-e2e-'));
  const executablePath = resolveExecutablePath();
  console.log(`\n=== Easy Browser-as-a-Service — end-to-end ===`);
  console.log(`chrome: ${executablePath || '(puppeteer bundled)'}`);
  console.log(`tmp:    ${tmpRoot}\n`);

  process.env.SERVICE_ORIGIN = SERVICE_ORIGIN;
  process.env.TARGET_ORIGIN = TARGET_ORIGIN;
  // target-app substitutes this into the host fixture's sdk.js URL.
  process.env.RBAS_TOKEN = RBAS_TOKEN;

  // 1. bring up (or attach to) the service, the target CRM, and the host app
  let service = null;
  if (SPAWN_SERVICE) {
    service = await startService(SERVICE_PORT, {
      RECONNECT_GRACE_MS: '4000',
      STORAGE_POLL_MS: '800',
      DOWNLOAD_POLL_MS: '300',
      PUPPETEER_EXECUTABLE_PATH: executablePath || '',
      RBAS_TMP_DIR: path.join(tmpRoot, 'rbas-main'),
      // The no-backend path: the host fixture origin may mint for itself.
      RBAS_TRUSTED_ORIGINS: HOST_ORIGIN,
      RBAS_TRUSTED_NETWORKS: '127.0.0.0/8,::1',
    });
  }
  if (RUN_IDLE_TEST) {
    await startService(IDLE_PORT, {
      IDLE_TIMEOUT_MS: '3000',
      HIDDEN_TIMEOUT_MS: '3000',
      SWEEP_MS: '300',
      PUPPETEER_EXECUTABLE_PATH: executablePath || '',
      RBAS_TMP_DIR: path.join(tmpRoot, 'rbas-idle'),
    });
  }
  await startFixtureApp(TARGET_PORT, FIXTURE_BIND);
  await startFixtureApp(HOST_PORT, FIXTURE_BIND);

  const health = await waitFor('service health', async () => fetchJson(SERVICE_ORIGIN, '/healthz'), { timeout: 45000 });
  if (RUN_IDLE_TEST) await waitFor('idle service health', async () => fetchJson(IDLE_ORIGIN, '/healthz'), { timeout: 30000 });
  check(
    SPAWN_SERVICE ? 'service boots and reports health' : 'deployed service answers /healthz through its mapped port',
    health.ok,
    `chrome=${health.browser?.version} sessions=${JSON.stringify(health.sessions)} tmp=${health.tmp}`
  );
  if (service && ONLY === 'health') return reportAndExit();

  const hostDownloadDir = path.join(tmpRoot, 'host-downloads');
  await fsp.mkdir(hostDownloadDir, { recursive: true });

  browser = await puppeteer.launch({
    executablePath,
    headless: true,
    defaultViewport: { width: 1280, height: 960 },
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars'],
  });
  const page = await browser.newPage();
  const hostClient = await page.target().createCDPSession();
  await hostClient.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: hostDownloadDir,
    eventsEnabled: true,
  });

  const readState = () => page.evaluate(() => {
    const raw = window.localStorage.getItem('rbas:session');
    return raw ? JSON.parse(raw) : {};
  });

  const canvasRect = () => page.evaluate(() => {
    const canvas = document.getElementById('rb').shadowRoot.querySelector('canvas');
    const rect = canvas.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });

  // Remote coordinate space is 1024x700 (see host.html).
  const clickRemote = async (x, y) => {
    const rect = await canvasRect();
    await page.mouse.click(rect.x + x * (rect.width / 1024), rect.y + y * (rect.height / 700));
  };

  await page.goto(`${HOST_ORIGIN}/host.html`, { waitUntil: 'domcontentloaded' });
  await waitFor('SDK ready', async () => page.evaluate(() => {
    const rb = document.getElementById('rb');
    return rb && rb.status && rb.status.ready;
  }), { timeout: 30000 });
  const firstSession = await page.evaluate(() => document.getElementById('rb').status.sessionId);
  check('host page connects and gets a session id', /^sess_[0-9a-f]+$/.test(firstSession || ''), firstSession);

  // 2. canvas actually renders remote pixels (not just a black placeholder)
  const firstPaint = await waitFor('first painted frame', async () => page.evaluate(() => {
    const canvas = document.getElementById('rb').shadowRoot.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let dark = 0;
    let light = 0;
    for (let i = 0; i < data.length; i += 4 * 61) {
      const r = data[i];
      if (r < 90) dark += 1;
      if (r > 200) light += 1;
    }
    return dark > 5 && light > 20 ? { dark, light, w: canvas.width, h: canvas.height } : null;
  }), { timeout: 30000 });
  check('screencast frames render to canvas', true, `${firstPaint.w}x${firstPaint.h}, ${firstPaint.dark} dark/${firstPaint.light} light samples`);
  check('canvas dimension matches the remote viewport', firstPaint.w === 1024 && firstPaint.h === 700, `${firstPaint.w}x${firstPaint.h}`);

  // 3. mouse passthrough: a click in the remote "zone" bumps a remote counter
  await clickRemote(512, 620);
  await waitFor('remote click synced back', async () => (await readState()).localStorage?.counter >= 1, { timeout: 15000 });
  const afterClick = await readState();
  check('mouse passthrough reaches the remote page', Number(afterClick.localStorage.counter) >= 1, `remote counter=${afterClick.localStorage.counter}`);
  check('remote localStorage syncs to the host', typeof afterClick.localStorage.booted === 'string', `booted=${afterClick.localStorage.booted}`);

  // 4. keyboard passthrough
  await clickRemote(220, 110); // focus the remote text field
  await page.keyboard.type('hi');
  await waitFor('typed text synced back', async () => (await readState()).localStorage?.typed === 'hi', { timeout: 15000 });
  check('keyboard passthrough reaches the remote page', true, "remote field contains 'hi'");

  // 5. clipboard host -> remote (paste)
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', '-from-host');
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  });
  await waitFor('pasted text synced back', async () => (await readState()).localStorage?.typed === 'hi-from-host', { timeout: 15000 });
  check('clipboard host -> remote works', true, "remote field contains 'hi-from-host'");

  // 6. clipboard remote -> host (copy button in the remote page)
  await clickRemote(110, 230);
  const copied = await waitFor('remote clipboard payload', async () => page.evaluate(() => document.getElementById('rb').lastClipboard), { timeout: 15000 });
  check('clipboard remote -> host works', copied === 'remote-clipboard-payload', `host received "${copied}"`);

  // 7. upload bridge: remote file picker -> host picker -> POST /upload -> remote
  const uploadPath = path.join(tmpRoot, 'payload.bin');
  const uploadBody = 'rbas-upload-payload';
  await fsp.writeFile(uploadPath, uploadBody);
  const chooserPromise = page.waitForFileChooser({ timeout: 20000 });
  await clickRemote(120, 170); // remote <input type=file>
  const chooser = await chooserPromise;
  await chooser.accept([uploadPath]);
  const expectedUpload = `${path.basename(uploadPath)}:${uploadBody.length}`;
  const uploadState = await waitFor(
    'upload handed to remote browser',
    async () => {
      const state = await readState();
      const value = state.localStorage?.upload;
      if (value) console.log(`     remote upload state: ${JSON.stringify(value)} (expected ${JSON.stringify(expectedUpload)})`);
      return value ? state : null;
    },
    { timeout: 20000 }
  );
  check('upload bridge works end to end', uploadState.localStorage.upload === expectedUpload, `remote received ${uploadState.localStorage.upload}`);

  // 8. download bridge: remote download -> /download/:id -> host download
  await clickRemote(90, 280); // remote download link
  const downloadedFile = await waitFor('host download', async () => {
    const names = await fsp.readdir(hostDownloadDir).catch(() => []);
    const hit = names.find((name) => name === 'hello.txt' || name.endsWith('.txt'));
    if (!hit) return null;
    const full = path.join(hostDownloadDir, hit);
    const stat = await fsp.stat(full).catch(() => null);
    return stat && stat.size > 0 ? full : null;
  }, { timeout: 25000 });
  const downloadContent = await fsp.readFile(downloadedFile, 'utf8');
  check('download bridge works end to end', downloadContent.includes('hello from the remote browser'), `host saved ${path.basename(downloadedFile)}`);

  // 9. deep-link resilience: reload the host page and resume the same session
  const beforeReload = await readState();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitFor('SDK ready after reload', async () => page.evaluate(() => {
    const rb = document.getElementById('rb');
    return rb && rb.status && rb.status.ready;
  }), { timeout: 30000 });
  const resumedSession = await page.evaluate(() => document.getElementById('rb').status.sessionId);
  const resumedEvents = await page.evaluate(() => window.__rbEvents.filter((e) => e.type === 'ready').map((e) => e.detail));
  check('host reload resumes the same remote session', resumedSession === firstSession, `${firstSession} -> ${resumedSession}`);
  check('resume reports resumed=true', resumedEvents.some((d) => d && d.resumed === true), JSON.stringify(resumedEvents));
  // The remote page counters must keep climbing across the reload: a brand new
  // context would restart them at 0.
  await clickRemote(512, 620);
  const afterResume = await waitFor(
    'remote counter continues after resume',
    async () => {
      const state = await readState();
      return Number(state.localStorage?.counter) >= Number(beforeReload.localStorage.counter) + 1 ? state : null;
    },
    { timeout: 20000 }
  );
  check(
    'deep-link resume preserves remote page state',
    Number(afterResume.localStorage.counter) >= Number(beforeReload.localStorage.counter) + 1,
    `counter ${beforeReload.localStorage.counter} -> ${afterResume.localStorage.counter}`
  );

  // 10. zombie management: disconnect grace reaps the context
  await page.close();
  await waitFor('session reaped after disconnect grace', async () => (await fetchJson(SERVICE_ORIGIN, '/api/sessions')).active === 0, { timeout: GRACE_WAIT_MS });
  check('disconnect grace reaps the remote context', true, 'active sessions back to 0');

  // 10b. no-backend path: a page carrying no token mints its own, and can end
  //      the session on demand instead of waiting out the reconnect grace.
  const autoPage = await browser.newPage();
  await autoPage.goto(`${HOST_ORIGIN}/host-autotoken.html`, { waitUntil: 'domcontentloaded' });
  const auto = await waitFor(
    'auto-minted session ready',
    async () =>
      autoPage.evaluate(() => {
        const rb = document.getElementById('rb');
        return rb && rb.status && rb.status.ready ? { sessionId: rb.status.sessionId, token: rb.token } : null;
      }),
    { timeout: 30000 }
  );
  check('a page with no token mints one from the service', /^v1\./.test(auto.token || ''), `${String(auto.token).slice(0, 12)}…`);
  check('the self-minted session is live', /^sess_/.test(auto.sessionId || ''), auto.sessionId);
  check('the service sees exactly the auto-minted session', (await fetchJson(SERVICE_ORIGIN, '/api/sessions')).active === 1);

  await autoPage.evaluate(() => document.getElementById('rb').endSession('e2e'));
  const tornDown = await waitFor(
    'session torn down by endSession',
    async () => (await fetchJson(SERVICE_ORIGIN, '/api/sessions')).active === 0,
    { timeout: 2500, interval: 100 }
  )
    .then(() => true)
    .catch(() => false);
  check('endSession() tears the session down inside the 4s grace', tornDown, `active=${(await fetchJson(SERVICE_ORIGIN, '/api/sessions')).active}`);
  check('endSession() fires the ended event on the element', await autoPage.evaluate(() => window.__rbEvents.some((e) => e.type === 'ended')));
  check('endSession() clears the remembered session id', (await autoPage.evaluate(() => document.getElementById('rb').sessionId)) === null);
  await autoPage.close();

  // 11. zombie management: idle timeout expires an untouched session
  if (RUN_IDLE_TEST) {
    const idleExpiry = await probeIdleExpiry(IDLE_PORT);
    check('idle timeout expires an untouched session', idleExpiry.expired, `server sent "expired" after ${idleExpiry.elapsedMs}ms`);
  } else {
    console.log('  ⏭  idle-timeout check skipped (external service) — run: node test/idle-probe.js <port>');
  }

  await browser.close();
  browser = null;
  return reportAndExit();
}

function reportAndExit() {
  console.log(`\n=== ${results.length - failures}/${results.length} checks passed ===`);
  for (const r of results.filter((x) => !x.ok)) console.log(`  FAILED: ${r.name}`);
  return failures === 0 ? 0 : 1;
}

// ------------------------------------------------------------------ helpers

function startService(port, extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
      env: { ...process.env, PORT: String(port), RBAS_KEY, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let booted = false;
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      if (process.env.E2E_VERBOSE) process.stdout.write(`[svc:${port}] ${text}`);
      if (!booted && text.includes('listening on')) {
        booted = true;
        resolve(child);
      }
    });
    child.stderr.on('data', (chunk) => process.stderr.write(`[svc:${port}] ${chunk}`));
    child.on('exit', (code) => {
      if (!booted) reject(new Error(`service on ${port} exited early (code ${code})`));
    });
    setTimeout(() => {
      if (!booted) reject(new Error(`service on ${port} did not boot`));
    }, 30000);
  });
}

function cleanup() {
  for (const child of children) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
  if (browser) browser.close().catch(() => {});
}

main()
  .then((code) => {
    cleanup();
    setTimeout(() => process.exit(code), 300);
  })
  .catch((err) => {
    console.error(`\n❌ e2e crashed: ${err.stack || err.message}`);
    cleanup();
    setTimeout(() => process.exit(1), 300);
  });
