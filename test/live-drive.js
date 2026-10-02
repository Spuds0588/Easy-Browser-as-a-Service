'use strict';

/**
 * Live-internet drive: points a real <remote-browser> at real external sites and
 * checks the product end to end against the open web (not the local fixtures).
 *
 *   SERVICE_ORIGIN=http://localhost:8130 node test/live-drive.js
 *
 * Optional env:
 *   LIVE_HOME      first page to load            (default https://example.com/)
 *   LIVE_FORM      page with a search box        (default https://www.wikipedia.org/)
 *   LIVE_SEARCH    text pasted into that box     (default "remote browser")
 *   LIVE_DOWNLOAD  URL that returns an attachment (default httpbin 4096 bytes)
 *   SHOT_DIR       where canvas PNGs are written (default $TMPDIR/rbas-live-shots)
 */

const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');

const { start: startFixtureApp } = require('./target-app');
const { resolveExecutablePath } = require('../server/browser');

const SERVICE_ORIGIN = process.env.SERVICE_ORIGIN || 'http://localhost:8130';
const HOST_PORT = Number(process.env.HOST_PORT || 8094);
const SHOT_DIR = process.env.SHOT_DIR || path.join(os.tmpdir(), 'rbas-live-shots');
const LIVE_HOME = process.env.LIVE_HOME || 'https://example.com/';
const LIVE_FORM = process.env.LIVE_FORM || 'https://www.wikipedia.org/';
const LIVE_SEARCH = process.env.LIVE_SEARCH || 'remote browser';
const LIVE_PASTE = process.env.LIVE_PASTE || 'clipboard probe';
const LIVE_DOWNLOAD = process.env.LIVE_DOWNLOAD || 'https://httpbin.org/bytes/4096';

// target-app substitutes these into the host fixture it serves.
process.env.SERVICE_ORIGIN = SERVICE_ORIGIN;
process.env.TARGET_ORIGIN = SERVICE_ORIGIN;

const REMOTE_W = 1024;
const REMOTE_H = 700;

const results = [];
let failures = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok) });
  if (!ok) failures += 1;
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function note(label, detail = '') {
  console.log(`  •  ${label}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, fn, { timeout = 30000, interval = 200 } = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      last = err;
    }
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${label}${last ? `: ${last.message}` : ''}`);
}

async function main() {
  await fsp.mkdir(SHOT_DIR, { recursive: true });
  const hostDownloads = path.join(SHOT_DIR, 'host-downloads');
  await fsp.mkdir(hostDownloads, { recursive: true });

  console.log('\n=== Easy Browser-as-a-Service — live internet drive ===');
  console.log(`service: ${SERVICE_ORIGIN}`);
  console.log(`shots:   ${SHOT_DIR}\n`);

  const health = await (await fetch(`${SERVICE_ORIGIN}/healthz`)).json();
  note('remote browser', `${health.browser.version} (sessions ${health.sessions.active}/${health.sessions.max})`);

  await startFixtureApp(HOST_PORT, '0.0.0.0');

  const browser = await puppeteer.launch({
    executablePath: resolveExecutablePath(),
    headless: true,
    defaultViewport: { width: 1280, height: 980 },
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars'],
  });
  const page = await browser.newPage();
  const cdp = await page.target().createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: hostDownloads, eventsEnabled: true });

  const rbState = () => page.evaluate(() => {
    const rb = document.getElementById('rb');
    return { ready: Boolean(rb && rb.status && rb.status.ready), sessionId: rb && rb.status && rb.status.sessionId, lastClipboard: rb && rb.lastClipboard };
  });
  const events = (type) => page.evaluate((t) => window.__rbEvents.filter((e) => e.type === t).map((e) => e.detail), type);

  const canvasRect = () => page.evaluate(() => {
    const c = document.getElementById('rb').shadowRoot.querySelector('canvas');
    const r = c.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  const clickRemote = async (x, y) => {
    const r = await canvasRect();
    await page.mouse.click(r.x + x * (r.width / REMOTE_W), r.y + y * (r.height / REMOTE_H));
  };
  const shot = async (name) => {
    const dataUrl = await page.evaluate(() => document.getElementById('rb').shadowRoot.querySelector('canvas').toDataURL('image/png'));
    const file = path.join(SHOT_DIR, `${name}.png`);
    await fsp.writeFile(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
    note(`screenshot -> ${path.basename(file)}`);
    return file;
  };
  // Server-side truth about where the remote browser actually is.
  const remoteUrl = async () => {
    const info = await (await fetch(`${SERVICE_ORIGIN}/api/sessions`)).json();
    return info.items[0] ? info.items[0].url : null;
  };
  const navigateRemote = async (url) => {
    await page.evaluate((u) => document.getElementById('rb').navigate(u), url);
  };

  // ---------------------------------------------------------------- 0. attach
  await page.goto(`http://127.0.0.1:${HOST_PORT}/host.html?src=${encodeURIComponent(LIVE_HOME)}`, { waitUntil: 'domcontentloaded' });
  await waitFor('SDK ready', async () => (await rbState()).ready, { timeout: 45000 });
  const session = (await rbState()).sessionId;
  check('embedder connects over the live internet', /^sess_[0-9a-f]+$/.test(session || ''), session);

  // ------------------------------------------------------- 1. real navigation
  const landed = await waitFor('remote lands on the real URL', async () => {
    const url = await remoteUrl();
    return url && url.startsWith('http') && url.includes(new URL(LIVE_HOME).host) ? url : null;
  }, { timeout: 45000 });
  check('navigation to a real site succeeds', true, landed);
  await sleep(1500);
  await shot('01-home');
  const homeText = await page.evaluate(() => {
    const c = document.getElementById('rb').shadowRoot.querySelector('canvas');
    return c.width + 'x' + c.height;
  });
  check('remote viewport matches the embed', homeText === `${REMOTE_W}x${REMOTE_H}`, homeText);

  // ------------------------------------------- 2. download a real internet file
  const before = (await events('download')).length;
  await navigateRemote(LIVE_DOWNLOAD);
  const download = await waitFor('download bridge hands the host a link', async () => {
    const list = await events('download');
    return list.length > before ? list[list.length - 1] : null;
  }, { timeout: 40000 });
  check('real internet download reaches the host', Boolean(download && download.filename), `${download.filename} via ${download.url}`);
  // The SDK dispatches an already-absolute /download/:id link, which is the same
  // copy of the bytes the host browser fetches.
  const fetched = await fetch(download.url);
  const body = Buffer.from(await fetched.arrayBuffer());
  const expectedBytes = Number(process.env.LIVE_DOWNLOAD_BYTES || 0);
  check('download link serves non-empty bytes', fetched.ok && body.length > 0, `HTTP ${fetched.status}, ${body.length} bytes fetched`);
  if (expectedBytes) check('downloaded size matches the source', body.length === expectedBytes, `${body.length} vs ${expectedBytes} expected`);
  const onDisk = await waitFor('host browser also saves the file', async () => {
    const names = await fsp.readdir(hostDownloads).catch(() => []);
    const hit = names.find((n) => !n.endsWith('.crdownload'));
    return hit || null;
  }, { timeout: 20000 });
  const diskSize = (await fsp.stat(path.join(hostDownloads, onDisk))).size;
  check('host browser wrote the same bytes to disk', diskSize === body.length, `${onDisk} ${diskSize} bytes`);

  // Coordinates are in the remote 1024x700 viewport. The default is the centre
  // of wikipedia.org's search field, measured by pixel-scanning a canvas
  // screenshot (the field's row spans y 472..515 at 1024x700).
  const boxX = Number(process.env.LIVE_FORM_X || 492);
  const boxY = Number(process.env.LIVE_FORM_Y || 494);
  const goToForm = async () => {
    await navigateRemote(LIVE_FORM);
    await waitFor('form site loads', async () => (await remoteUrl()).includes(new URL(LIVE_FORM).host), { timeout: 45000 });
    await sleep(2500);
  };
  // Focusing by pixel is brittle on real pages, so reach the first field the way
  // a keyboard user would: Tab from a neutral spot in the document.
  const focusField = async (tabs) => {
    if (tabs > 0) {
      await clickRemote(Number(process.env.LIVE_BODY_X || 12), Number(process.env.LIVE_BODY_Y || 60));
      await sleep(300);
      for (let i = 0; i < tabs; i += 1) {
        await page.keyboard.press('Tab');
        await sleep(250);
      }
    }
    await clickRemote(boxX, boxY);
    await sleep(400);
  };
  // Typing triggers the site's autocomplete, so Enter may legitimately pick a
  // suggestion (a different URL) instead of running a search. Both are proof
  // that the key reached the page and was acted on.
  const submitWithEnter = async (label, predicate) => {
    const navBefore = (await events('navigate')).length;
    await page.keyboard.press('Enter');
    return waitFor(`${label} navigation`, async () => {
      const fresh = (await events('navigate')).slice(navBefore);
      return fresh.find(predicate) || null;
    }, { timeout: 25000 }).catch(() => null);
  };
  // Let the destination actually paint before capturing, or the canvas still
  // holds the pre-navigation frame.
  const settle = () => sleep(4500);
  const leftTheForm = (d) => /^https?:/i.test(d.url || '') && !/^https?:\/\/www\.wikipedia\.org\/?$/.test(d.url || '');
  const wasASearch = (d) => /search|query|[?&]q=/i.test(d.url || '');

  // Optional calibration: click a known link on the real page and confirm the
  // session actually navigated, proving the canvas -> remote coordinate mapping.
  if (process.env.LIVE_CALIBRATE) {
    await goToForm();
    const [cx, cy] = process.env.LIVE_CALIBRATE.split(',').map(Number);
    const rect = await canvasRect();
    note('canvas rect', JSON.stringify(rect));
    const urlBefore = await remoteUrl();
    await clickRemote(cx, cy);
    await sleep(4000);
    const urlAfter = await remoteUrl();
    await shot('00-calibrate');
    check('canvas -> remote click mapping is accurate', urlAfter !== urlBefore, `${urlBefore} -> ${urlAfter} (clicked ${cx},${cy})`);
    if (process.env.LIVE_CALIBRATE_ONLY === '1') {
      await browser.close();
      return failures === 0 ? 0 : 1;
    }
  }

  // ------------------------------------------ 3. real keyboard against a real site
  await goToForm();
  await shot('02-form-before');
  await focusField(Number(process.env.LIVE_TABS || 0));
  await page.keyboard.type(LIVE_SEARCH);
  await sleep(1200);
  await shot('03-form-typed');
  const typedSubmit = await submitWithEnter('typed query', leftTheForm);
  check('keyboard input + Enter is acted on by a real form', Boolean(typedSubmit),
    typedSubmit ? `${wasASearch(typedSubmit) ? 'search' : 'suggestion pick'}: ${typedSubmit.url.slice(0, 110)}` : 'no navigation after Enter');
  if (typedSubmit) { await settle(); await shot('04-search-results'); }

  // ------------------------------------- 4. paste from the host into a real site
  await goToForm();
  await focusField(Number(process.env.LIVE_TABS || 0));
  await page.evaluate((text) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  }, LIVE_PASTE);
  await sleep(1200);
  await shot('05-form-pasted');
  const pastedSubmit = await submitWithEnter('pasted query', wasASearch);
  check('host paste reaches a real page and submits a search', Boolean(pastedSubmit),
    pastedSubmit ? pastedSubmit.url.slice(0, 130) : 'no search navigation after paste + Enter');
  if (pastedSubmit) { await settle(); await shot('06-paste-results'); }

  // --------------------------------- 5. clipboard from a real page back to host
  // The SDK reserves Ctrl+C for the host, so forwarding happens only when the
  // remote page itself raises a copy event (an in-page copy button).
  if (process.env.LIVE_COPY === '1') {
    const copyBefore = (await events('clipboard')).length;
    await clickRemote(Number(process.env.LIVE_COPY_X || 512), Number(process.env.LIVE_COPY_Y || 400));
    const copied = await waitFor('in-page copy button reaches the host', async () => {
      const list = await events('clipboard');
      return list.length > copyBefore ? list[list.length - 1] : null;
    }, { timeout: 15000 }).catch(() => null);
    check('real page copy button reaches the host clipboard', Boolean(copied), copied ? JSON.stringify(copied).slice(0, 120) : 'nothing captured');
  } else {
    note('remote -> host copy probe skipped (set LIVE_COPY=1 to click an in-page copy button)');
  }

  const status = await (await fetch(`${SERVICE_ORIGIN}/api/sessions`)).json();
  note('sessions after drive', JSON.stringify(status.stats || status));

  await browser.close();

  console.log(`\n=== ${results.length - failures}/${results.length} live checks passed ===`);
  for (const r of results.filter((x) => !x.ok)) console.log(`  FAILED: ${r.name}`);
  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => setTimeout(() => process.exit(code), 300))
  .catch((err) => {
    console.error(`\n❌ live drive crashed: ${err.stack || err.message}`);
    setTimeout(() => process.exit(1), 300);
  });
