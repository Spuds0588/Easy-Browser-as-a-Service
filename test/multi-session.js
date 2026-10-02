'use strict';

/**
 * Multi-session (isolation) test — the product's core premise.
 *
 * Several host pages, each embedding a different target, are driven at the same
 * time against one service. The point is not that each session works, but that
 * they never see each other: ids, frames, cookies, localStorage, clipboard and
 * file-bridge payloads must stay inside their own session, capacity must be
 * enforced exactly at MAX_SESSIONS, and reaping must free a slot again.
 *
 * Self-spawned by default; point it at a running deployment with:
 *
 *   E2E_SERVICE_ORIGIN=http://localhost:9210 \
 *   E2E_TARGET_ORIGIN=http://host.docker.internal:9091 \
 *   E2E_BIND=0.0.0.0 E2E_CAPACITY=3 node test/multi-session.js
 */

const { spawn } = require('child_process');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');
const WebSocket = require('ws');

const { start: startFixtureApp } = require('./target-app');
const { resolveExecutablePath } = require('../server/browser');
const { KEY: RBAS_KEY, TOKEN: RBAS_TOKEN, authHeaders } = require('./auth-helper');

const EXTERNAL_SERVICE = process.env.E2E_SERVICE_ORIGIN || '';
const SPAWN_SERVICE = !EXTERNAL_SERVICE;

const SERVICE_PORT = Number(process.env.E2E_SERVICE_PORT || 9090);
const TARGET_PORT = Number(process.env.E2E_TARGET_PORT || SERVICE_PORT + 1);
const HOST_PORT = Number(process.env.E2E_HOST_PORT || SERVICE_PORT + 2);
const SERVICE_ORIGIN = EXTERNAL_SERVICE || `http://localhost:${SERVICE_PORT}`;
const TARGET_ORIGIN = process.env.E2E_TARGET_ORIGIN || `http://localhost:${TARGET_PORT}`;
const HOST_ORIGIN = `http://127.0.0.1:${HOST_PORT}`;
const FIXTURE_BIND = process.env.E2E_BIND || '127.0.0.1';
const CAPACITY = Number(process.env.E2E_CAPACITY || 3);
const GRACE_WAIT_MS = Number(process.env.E2E_GRACE_WAIT_MS || (SPAWN_SERVICE ? 25000 : 90000));

const results = [];
let failures = 0;
const children = [];
let browser;
let tmpRoot;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok) });
  if (!ok) failures += 1;
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

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

async function fetchJson(route) {
  const res = await fetch(`${SERVICE_ORIGIN}${route}`, { headers: authHeaders() });
  return res.json();
}

// ------------------------------------------------------------------ sessions

class Client {
  constructor(name, tenant) {
    this.name = name;
    this.tenant = tenant;
    this.storageKey = `rbas:multi:${name}`;
  }

  get targetUrl() {
    return `${TARGET_ORIGIN}/target.html?tenant=${this.tenant}`;
  }

  async open(browserInstance) {
    this.page = await browserInstance.newPage();
    await this.page.setViewport({ width: 1200, height: 900 });
    this.consoleErrors = [];
    this.page.on('pageerror', (e) => this.consoleErrors.push(e.message));
    this.page.on('console', (m) => {
      if (m.type() === 'error') this.consoleErrors.push(m.text());
    });
    const url = `${HOST_ORIGIN}/host.html?key=${encodeURIComponent(this.storageKey)}&src=${encodeURIComponent(this.targetUrl)}`;
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    await waitFor(
      `${this.name} ready`,
      async () => this.page.evaluate(() => {
        const rb = document.getElementById('rb');
        return rb && rb.status && rb.status.ready;
      }),
      { timeout: 45000 }
    );
    this.sessionId = await this.page.evaluate(() => document.getElementById('rb').status.sessionId);
    return this;
  }

  state() {
    return this.page.evaluate((key) => {
      const raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : {};
    }, this.storageKey);
  }

  events() {
    return this.page.evaluate(() => window.__rbEvents);
  }

  lastClipboard() {
    return this.page.evaluate(() => document.getElementById('rb').lastClipboard ?? null);
  }

  async canvas() {
    return this.page.evaluate(() => {
      const c = document.getElementById('rb').shadowRoot.querySelector('canvas');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let dark = 0;
      let light = 0;
      let mid = 0;
      for (let i = 0; i < d.length; i += 4 * 53) {
        const r = d[i];
        const g = d[i + 1];
        const b = d[i + 2];
        if (r < 90) dark += 1;
        else if (r > 200 && g > 200 && b > 200) light += 1;
        else mid += 1;
      }
      const palette = light > dark * 2 ? 'light' : dark > light * 2 ? 'dark' : 'mixed';
      return { w: c.width, h: c.height, dark, light, mid, palette };
    });
  }

  async clickRemote(x, y) {
    const rect = await this.page.evaluate(() => {
      const c = document.getElementById('rb').shadowRoot.querySelector('canvas');
      const r = c.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    await this.page.mouse.click(rect.x + x * (rect.width / 1024), rect.y + y * (rect.height / 700));
  }

  async typeRemote(text) {
    await this.page.keyboard.type(text);
  }

  async close() {
    if (this.page) await this.page.close().catch(() => {});
  }
}

/** Raw-protocol client: deterministic way to observe capacity rejections. */
function rawInit({ timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${SERVICE_ORIGIN.replace(/^http/, 'ws')}/ws`);
    const out = { ready: false, error: null, closed: false };
    ws.on('open', () =>
      ws.send(JSON.stringify({ type: 'init', token: RBAS_TOKEN, url: 'about:blank', viewport: { width: 640, height: 480 } }))
    );
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'ready') out.ready = true;
      if (msg.type === 'error') out.error = msg.message;
    });
    ws.on('close', () => {
      out.closed = true;
    });
    ws.on('error', (err) => {
      out.error = err.message;
    });
    setTimeout(() => resolve(out), timeout);
  });
}

// ---------------------------------------------------------------------- main

async function main() {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'rbas-multi-'));
  const executablePath = resolveExecutablePath();
  console.log(`\n=== Easy Browser-as-a-Service — multi-session isolation ===`);
  console.log(`service: ${SERVICE_ORIGIN}${SPAWN_SERVICE ? ' (self-spawned)' : ' (external deployment)'}`);
  console.log(`capacity under test: ${CAPACITY}`);

  process.env.SERVICE_ORIGIN = SERVICE_ORIGIN;
  process.env.TARGET_ORIGIN = TARGET_ORIGIN;
  process.env.RBAS_TOKEN = RBAS_TOKEN;

  if (SPAWN_SERVICE) {
    await startService(SERVICE_PORT, {
      MAX_SESSIONS: String(CAPACITY),
      RECONNECT_GRACE_MS: '5000',
      STORAGE_POLL_MS: '700',
      DOWNLOAD_POLL_MS: '300',
      SWEEP_MS: '500',
      PUPPETEER_EXECUTABLE_PATH: executablePath || '',
      RBAS_TMP_DIR: path.join(tmpRoot, 'rbas-main'),
    });
  }
  await startFixtureApp(TARGET_PORT, FIXTURE_BIND);
  await startFixtureApp(HOST_PORT, FIXTURE_BIND);

  const health = await waitFor('service health', async () => fetchJson('/healthz'), { timeout: 45000 });
  check('service is up and reports capacity', health.sessions.max === CAPACITY, `max=${health.sessions.max} chrome=${health.browser.version}`);

  const hostDownloadDir = path.join(tmpRoot, 'host-downloads');
  await fsp.mkdir(hostDownloadDir, { recursive: true });

  browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars'],
  });
  // Host-side downloads: the SDK triggers a real anchor download in the host
  // page, so the host browser needs its own download destination wired up. The
  // page that carries the CDP session is kept open — closing it detaches the
  // session and drops the browser-wide download behavior again.
  const downloadSetup = await browser.newPage();
  const hostClient = await downloadSetup.target().createCDPSession();
  await hostClient.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: hostDownloadDir,
    eventsEnabled: true,
  });

  // ---------------------------------------------------- two concurrent sessions
  const a = new Client('alpha', 'A');
  const b = new Client('bravo', 'B');
  await a.open(browser);
  const bStarted = Date.now();
  await b.open(browser);
  console.log(`\n--- two sessions, different targets, opened ${Date.now() - bStarted}ms apart ---`);
  check('two host pages get distinct session ids', Boolean(a.sessionId) && Boolean(b.sessionId) && a.sessionId !== b.sessionId, `${a.sessionId} vs ${b.sessionId}`);
  const twoActive = await fetchJson('/api/sessions');
  check('service reports exactly two active sessions', twoActive.active === 2, JSON.stringify(twoActive.items.map((i) => i.url)));

  const [aCanvas, bCanvas] = [await a.canvas(), await b.canvas()];
  check('screencast frames are per-session (A light target, B dark target)', aCanvas.palette === 'light' && bCanvas.palette === 'dark', `A=${aCanvas.palette} B=${bCanvas.palette}`);
  check('frames are at each session\'s own viewport', aCanvas.w === 1024 && aCanvas.h === 700 && bCanvas.w === 1024 && bCanvas.h === 700, `A=${aCanvas.w}x${aCanvas.h} B=${bCanvas.w}x${bCanvas.h}`);

  // input stays routed to the right session
  await a.clickRemote(220, 110);
  await a.typeRemote('alpha-text');
  await b.clickRemote(220, 110);
  await b.typeRemote('bravo-text');
  await waitFor('A typed', async () => (await a.state()).localStorage?.typed === 'alpha-text');
  await waitFor('B typed', async () => (await b.state()).localStorage?.typed === 'bravo-text');
  check('keyboard input is routed per session', true, `A="alpha-text" B="bravo-text"`);

  // remote state never crosses
  const aState = await a.state();
  const bState = await b.state();
  check('remote localStorage is per session (own tenant only)', aState.localStorage.tenant === 'A' && bState.localStorage.tenant === 'B', `A="${aState.localStorage.tenant}" B="${bState.localStorage.tenant}"`);
  check('no session sees the other\'s seeded values', aState.localStorage.secret === 'A-ONLY' && bState.localStorage.secret === 'B-ONLY', `A="${aState.localStorage.secret}" B="${bState.localStorage.secret}"`);
  check('host storage keys stay separate', aState.sessionId !== bState.sessionId && aState.localStorage.tenant !== bState.localStorage.tenant, `${a.storageKey} vs ${b.storageKey}`);

  // cookies are per-context
  await waitFor('A cookies synced', async () => ((await a.state()).cookies || []).length > 0, { timeout: 20000 });
  await waitFor('B cookies synced', async () => ((await b.state()).cookies || []).length > 0, { timeout: 20000 });
  const aCookies = ((await a.state()).cookies || []).map((c) => c.name);
  const bCookies = ((await b.state()).cookies || []).map((c) => c.name);
  check('cookies are per session, never shared', aCookies.includes('rbas_a') && !aCookies.includes('rbas_b') && bCookies.includes('rbas_b') && !bCookies.includes('rbas_a'), `A=[${aCookies}] B=[${bCookies}]`);

  // clipboard
  await a.clickRemote(110, 230); // remote "copy text" button
  const clipboardText = await waitFor('A clipboard payload', async () => a.lastClipboard(), { timeout: 15000 });
  await sleep(800);
  const bClipboard = await b.lastClipboard();
  const bEvents = (await b.events()).map((e) => e.type);
  check('clipboard events go only to the session that copied', clipboardText === 'remote-clipboard-payload' && bClipboard === null && !bEvents.includes('clipboard'), `A="${clipboardText}" B=${bClipboard}`);
  check('host->remote paste lands only in the addressed session', await (async () => {
    await b.page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', '-bravo-paste');
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
    });
    await waitFor('B paste applied', async () => (await b.state()).localStorage?.typed === 'bravo-text-bravo-paste', { timeout: 15000 });
    return (await a.state()).localStorage?.typed === 'alpha-text';
  })(), 'A unchanged, only B received the paste');

  // ---------------------------------------------------- third concurrent session
  const c = new Client('charlie', 'C');
  await c.open(browser);
  console.log('\n--- third session joins ---');
  const threeActive = await fetchJson('/api/sessions');
  check('three distinct sessions are live', threeActive.active === 3 && new Set([a.sessionId, b.sessionId, c.sessionId]).size === 3, `active=${threeActive.active}`);
  const cCanvas = await c.canvas();
  check('third session renders its own target', cCanvas.palette === 'dark', `C=${cCanvas.palette}`);

  // ------------------------------------------- second session does not disturb
  const beforeDuring = await a.canvas();
  const aPaletteSamples = [];
  for (let i = 0; i < 6; i += 1) {
    await c.clickRemote(512, 620);
    await c.typeRemote('x');
    await sleep(250);
    aPaletteSamples.push((await a.canvas()).palette);
  }
  check('A\'s screencast is undisturbed while B and C are driven', aPaletteSamples.every((p) => p === 'light') && beforeDuring.palette === 'light', `sampled palettes=${aPaletteSamples.join(',')}`);
  const aCounterBefore = Number((await a.state()).localStorage.counter || 0);
  await a.clickRemote(512, 620);
  await waitFor('A input still works', async () => Number((await a.state()).localStorage.counter || 0) > aCounterBefore, { timeout: 15000 });
  check('A still receives input and frames after the others left noise', true, `counter ${aCounterBefore} -> ${(await a.state()).localStorage.counter}`);

  // ------------------------------------------------------------- file bridge
  const uploadPath = path.join(tmpRoot, 'alpha-only.bin');
  const uploadBody = 'alpha-upload-payload';
  await fsp.writeFile(uploadPath, uploadBody);
  const chooserPromise = a.page.waitForFileChooser({ timeout: 20000 });
  await a.clickRemote(120, 170);
  const chooser = await chooserPromise;
  await chooser.accept([uploadPath]);
  await waitFor('A upload applied', async () => (await a.state()).localStorage?.upload === `alpha-only.bin:${uploadBody.length}`, { timeout: 20000 });
  const bUpload = (await b.state()).localStorage?.upload;
  const cUpload = (await c.state()).localStorage?.upload;
  check('upload payload reaches only the requesting session', bUpload === undefined && cUpload === undefined, `A="${(await a.state()).localStorage.upload}" B=${bUpload} C=${cUpload}`);

  await a.clickRemote(90, 280); // remote download link
  const downloaded = await waitFor('host download', async () => {
    const names = await fsp.readdir(hostDownloadDir).catch(() => []);
    const hit = names.find((n) => n.endsWith('.txt'));
    return hit ? path.join(hostDownloadDir, hit) : null;
  }, { timeout: 25000 });
  const bDownloadEvents = (await b.events()).filter((e) => e.type === 'download').length;
  const cDownloadEvents = (await c.events()).filter((e) => e.type === 'download').length;
  check('download only surfaces in the session that downloaded', bDownloadEvents === 0 && cDownloadEvents === 0, `A got 1 (${path.basename(downloaded)}), B=${bDownloadEvents}, C=${cDownloadEvents}`);

  // ---------------------------------------------------------------- capacity
  console.log('\n--- capacity ---');
  const overflow = await rawInit({ timeout: 8000 });
  const capacityRe = new RegExp(`capacity reached \\(${CAPACITY}\\/${CAPACITY}\\)`);
  check(`a ${CAPACITY + 1}th session is refused with the documented error`, !overflow.ready && capacityRe.test(overflow.error || ''), `error="${overflow.error}"`);
  const stillThree = await fetchJson('/api/sessions');
  check('a refused session leaves the live ones untouched', stillThree.active === 3, `active=${stillThree.active}`);

  const cSession = c.sessionId;
  await c.close();
  await waitFor('slot freed after reconnect grace', async () => (await fetchJson('/api/sessions')).active === CAPACITY - 1, { timeout: GRACE_WAIT_MS });
  check('reaping a session frees a capacity slot', true, `active=${(await fetchJson('/api/sessions')).active} after closing ${cSession}`);

  const replacement = new Client('delta', 'B');
  await replacement.open(browser);
  const afterChurn = await fetchJson('/api/sessions');
  check('a new session is accepted once a slot frees', afterChurn.active === CAPACITY && replacement.sessionId !== a.sessionId && replacement.sessionId !== b.sessionId, `active=${afterChurn.active}`);
  await waitFor('replacement renders', async () => (await replacement.canvas()).palette === 'dark');
  check('the original sessions still hold their own state after churn', (await a.state()).localStorage.tenant === 'A' && (await b.state()).localStorage.tenant === 'B', 'A and B untouched');

  for (const client of [a, b, replacement]) {
    if (client.consoleErrors.length) check(`${client.name} had no page errors`, false, client.consoleErrors.join(' | '));
  }

  await browser.close();
  browser = null;
  await fsp.rm(hostDownloadDir, { recursive: true, force: true });
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
      if (process.env.E2E_VERBOSE) process.stdout.write(`[svc] ${text}`);
      if (!booted && text.includes('listening on')) {
        booted = true;
        resolve(child);
      }
    });
    child.stderr.on('data', (chunk) => process.stderr.write(`[svc] ${chunk}`));
    child.on('exit', (code) => {
      if (!booted) reject(new Error(`service exited early (code ${code})`));
    });
    setTimeout(() => {
      if (!booted) reject(new Error('service did not boot'));
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
    console.error(`\n❌ multi-session crashed: ${err.stack || err.message}`);
    cleanup();
    setTimeout(() => process.exit(1), 300);
  });
