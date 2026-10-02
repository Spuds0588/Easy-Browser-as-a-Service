'use strict';

/**
 * Image/browser robustness probe.
 *
 * Launches Chromium with the EXACT args the product uses (server/browser.js) and
 * reports:
 *
 *   1. the identity a site can read (UA, navigator.webdriver, headers)
 *   2. renderer and media capabilities the image does or doesn't ship
 *   3. whether Enter actually submits a form (CDP key-dispatch semantics)
 *   4. how real-world and bot-detection sites respond
 *   5. the same, with hardened flags, so the improvement is measured, not claimed
 *
 * Intended to run INSIDE the shipped image so the verdicts describe the image:
 *
 *   docker cp test/robustness-probe.js <container>:/app/probe/robustness-probe.js
 *   docker exec <container> node /app/probe/robustness-probe.js
 *
 * PROBE_HARDENED=0 disables the A/B pass, PROBE_SITES=0 skips the site sweep.
 */

const fs = require('fs');
const path = require('path');

// Runs either from the repo (test/) or from a scratch dir inside the image
// (/app is root-owned, so the probe may live in /tmp instead).
const serverBrowser = ['../server/browser', '/app/server/browser'].find((p) => {
  try {
    return fs.existsSync(require.resolve(p));
  } catch {
    return false;
  }
});
const { resolveExecutablePath, BASE_ARGS } = require(serverBrowser);

const RUN_HARDENED = process.env.PROBE_HARDENED !== '0';
const RUN_SITES = process.env.PROBE_SITES !== '0';
const HEADLESS = process.env.PUPPETEER_HEADLESS !== 'false';

// A realistic desktop Chrome UA with the same major version as the image's
// Chromium, so a site that sniffs the version still sees a plausible client.
const DESKTOP_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// PROBE_HARDEN_MODE isolates the cause: 'both' (default), 'ua' (only the UA is
// changed, navigator.webdriver stays true) or 'flags' (only the flags change,
// the UA keeps leaking HeadlessChrome).
const HARDEN_MODE = process.env.PROBE_HARDEN_MODE || 'both';
const HARDENING_ARGS = HARDEN_MODE === 'ua' ? [] : ['--disable-blink-features=AutomationControlled', '--window-size=1280,900'];
const HARDENING_UA = HARDEN_MODE === 'flags' ? null : DESKTOP_UA;

const SITES = [
  ['bot.sannysoft.com', 'https://bot.sannysoft.com/'],
  ['creepjs', 'https://abrahamjuliot.github.io/creepjs/'],
  ['areyouheadless', 'https://arh.antoinevastel.com/bots/areyouheadless'],
  ['fingerprintjs demo', 'https://fingerprintjs.github.io/fingerprintjs/'],
  ['deviceandbrowserinfo', 'https://deviceandbrowserinfo.com/are_you_a_bot'],
  ['google search', 'https://www.google.com/search?q=hello'],
  ['duckduckgo html', 'https://html.duckduckgo.com/html/?q=hello'],
  ['cloudflare', 'https://www.cloudflare.com/'],
  ['reddit', 'https://www.reddit.com/'],
  ['x.com', 'https://x.com/'],
  ['linkedin', 'https://www.linkedin.com/'],
  ['amazon', 'https://www.amazon.com/'],
  ['stackoverflow', 'https://stackoverflow.com/questions'],
  ['nytimes', 'https://www.nytimes.com/'],
  ['zillow', 'https://www.zillow.com/'],
  ['indeed', 'https://www.indeed.com/'],
  ['ticketmaster', 'https://www.ticketmaster.com/'],
  ['nike', 'https://www.nike.com/'],
];

const BLOCK_HINTS = [
  'just a moment', 'attention required', 'checking your browser', 'verify you are human',
  'are you a robot', 'unusual traffic', 'access denied', 'request blocked', 'enable javascript and cookies',
  'captcha', 'press & hold', 'cf-challenge', 'px-captcha', 'bot detection',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function line(label, value) {
  console.log(`    ${label.padEnd(30)} ${value}`);
}

async function launch(extraArgs = [], userAgent = null) {
  const puppeteer = require('puppeteer');
  // NOTE: Puppeteer v23 ignores a `userAgent` launch option, so the UA has to go
  // through the command line to affect navigator.userAgent AND the request
  // header. This is exactly the trap the product would fall into.
  const args = [...BASE_ARGS, ...extraArgs];
  if (userAgent) args.push(`--user-agent=${userAgent}`);
  return puppeteer.launch({
    executablePath: resolveExecutablePath(),
    headless: HEADLESS,
    args,
    defaultViewport: userAgent ? { width: 1280, height: 900 } : null,
  });
}

/** Everything a website can read about the browser without any special tricks. */
async function fingerprint(page) {
  return page.evaluate(() => {
    const out = {};
    out.userAgent = navigator.userAgent;
    out.webdriver = navigator.webdriver;
    out.languages = (navigator.languages || []).join(',');
    out.platform = navigator.platform;
    out.hardwareConcurrency = navigator.hardwareConcurrency;
    out.deviceMemory = navigator.deviceMemory ?? null;
    out.plugins = navigator.plugins.length;
    out.mimeTypes = navigator.mimeTypes.length;
    out.chromeRuntime = typeof window.chrome === 'object' && !!window.chrome && 'runtime' in window.chrome;
    out.pdfViewerEnabled = navigator.pdfViewerEnabled ?? null;
    out.cookieEnabled = navigator.cookieEnabled;
    out.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    out.locale = Intl.DateTimeFormat().resolvedOptions().locale;
    out.notificationPermission = typeof Notification !== 'undefined' ? Notification.permission : 'n/a';
    out.maxTouchPoints = navigator.maxTouchPoints;
    out.screen = `${screen.width}x${screen.height} dpr=${window.devicePixelRatio}`;
    out.outerInner = `outer ${outerWidth}x${outerHeight} inner ${innerWidth}x${innerHeight}`;
    // WebGL renderer: a headless/SwiftShader signature is a classic tell.
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (gl) {
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        out.webglVendor = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
        out.webglRenderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      } else {
        out.webglVendor = 'NO WEBGL CONTEXT';
        out.webglRenderer = 'NO WEBGL CONTEXT';
      }
    } catch (e) {
      out.webglVendor = `error: ${e.message}`;
    }
    // Media codecs: proprietary H.264/AAC only exist in a Chrome build.
    const v = document.createElement('video');
    out.mp4_h264 = v.canPlayType('video/mp4; codecs="avc1.42E01E"');
    out.mp4_h265 = v.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"');
    out.webm_vp9 = v.canPlayType('video/webm; codecs="vp9"');
    out.mp3 = v.canPlayType('audio/mpeg');
    out.aac = v.canPlayType('audio/mp4; codecs="mp4a.40.2"');
    out.ogg = v.canPlayType('audio/ogg; codecs="vorbis"');
    out.mse_h264 = typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E"');
    out.drmWidevine = 'requestMediaKeySystemAccess' in navigator;
    return out;
  });
}

/** Does the image's font set actually render non-Latin text? */
async function fontReport(page) {
  return page.evaluate(() => {
    const ink = (text, font) => {
      const c = document.createElement('canvas');
      c.width = 220; c.height = 90;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.fillStyle = '#000'; ctx.font = `36px ${font}`;
      ctx.fillText(text, 6, 60);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let dark = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 128) dark++;
      return dark;
    };
    // Ink alone cannot tell real glyphs from .notdef boxes, so each script is
    // compared against private-use codepoints, which always render as tofu.
    const tofu = ink('\uE000\uE001', 'sans-serif');
    const verdict = (text) => {
      const pixels = ink(text, 'sans-serif');
      return { ink: pixels, real: pixels !== tofu };
    };
    return {
      tofuReference: tofu,
      latin: verdict('Az'),
      cjk: verdict('漢字の日本語'),
      emoji: verdict('😀🎉'),
      cyrillic: verdict('Русский'),
      arabic: verdict('العربية'),
      devanagari: verdict('हिन्दी'),
    };
  });
}

/**
 * Does Enter actually submit a form? This needs a real HTTP origin (a data:
 * document cannot navigate) and per-event tracing, because "no submit" can
 * equally mean "no key delivered".
 */
async function formEnterSemantics(browser) {
  const http = require('http');
  // Reports land on the server, so a successful submit navigating the page away
  // cannot erase the evidence the way an in-page array would.
  const reported = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/report') {
      reported.push(`${url.searchParams.get('attempt')}:${url.searchParams.get('name')}`);
      res.writeHead(204);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><body>
      <form id="f" action="/submitted" method="get">
        <input id="q" name="q" type="text" autofocus>
        <button type="submit">go</button>
      </form>
      <script>
        const push = (name) => { try { fetch('/report?attempt=' + encodeURIComponent(window.__attempt || '?') + '&name=' + name); } catch (e) {} };
        window.__attempt = 'init';
        const q = document.getElementById('q');
        q.addEventListener('keydown', () => push('keydown'));
        q.addEventListener('keypress', () => push('keypress'));
        q.addEventListener('beforeinput', () => push('beforeinput'));
        q.addEventListener('input', () => push('input'));
        document.getElementById('f').addEventListener('submit', () => push('submit'));
      </script></body></html>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const page = await browser.newPage();
  const cdp = await page.target().createCDPSession();

  const attempt = async (label, events) => {
    // Fresh document + focused field for every variant, so one submit cannot
    // poison the next measurement.
    await page.goto(`http://127.0.0.1:${port}/form`);
    await page.evaluate((l) => { window.__attempt = l; }, label);
    await page.click('#q');
    await page.keyboard.type('probe');
    for (const ev of events) await cdp.send('Input.dispatchKeyEvent', ev);
    await sleep(900);
    const seen = reported.filter((r) => r.startsWith(`${label}:`)).map((r) => r.split(':')[1]);
    return { label, seen: [...new Set(seen)], url: page.url() };
  };

  const results = [];
  // What the product sends today for Enter: rawKeyDown/keyUp, no text.
  results.push(await attempt('rawKeyDown+keyUp', [
    { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
    { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
  ]));
  // keyDown with \r asks CDP for the character event too.
  results.push(await attempt("keyDown+text-r", [
    { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' },
    { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
  ]));
  // Explicit separate char event, the shape a real key produces.
  results.push(await attempt('rawKeyDown+char+keyUp', [
    { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
    { type: 'char', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' },
    { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
  ]));

  // Before changing the Enter path, check the other common meaning of Enter:
  // a newline inside a textarea. A fix that adds a character event must not
  // insert the newline twice.
  const textarea = async (label, events) => {
    await page.goto(`http://127.0.0.1:${port}/form`);
    await page.evaluate(() => {
      const ta = document.createElement('textarea');
      ta.id = 'ta';
      document.body.appendChild(ta);
    });
    await page.click('#ta');
    await page.keyboard.type('ab');
    for (const ev of events) await cdp.send('Input.dispatchKeyEvent', ev);
    await sleep(400);
    return { label, value: await page.evaluate(() => document.getElementById('ta').value) };
  };

  const newlineResults = [];
  newlineResults.push(await textarea('textarea rawKeyDown+keyUp', [
    { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
    { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
  ]));
  newlineResults.push(await textarea('textarea keyDown+text-r', [
    { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' },
    { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
  ]));

  await page.close();
  server.close();
  return { submitResults: results, newlineResults };
}

async function siteVerdict(browser, label, url) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const row = { label, url, status: null, title: '', blocked: false, blockedBy: '', note: '' };
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    row.status = response ? response.status() : null;
    await sleep(2500);
    row.title = (await page.title().catch(() => '')).slice(0, 70);
    const body = (await page.evaluate(() => document.body ? document.body.innerText.slice(0, 4000) : '').catch(() => '')) || '';
    const hay = `${row.title}\n${body}`.toLowerCase();
    const hit = BLOCK_HINTS.find((h) => hay.includes(h));
    if (hit) { row.blocked = true; row.blockedBy = hit; }
    row.note = body.replace(/\s+/g, ' ').slice(0, 80);
  } catch (err) {
    row.note = `ERROR ${err.message.split('\n')[0].slice(0, 90)}`;
  }
  await page.close().catch(() => {});
  return row;
}

const ONLY = (process.env.PROBE_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);

async function sweep(name, browser) {
  console.log(`\n  --- site sweep: ${name} ---`);
  const rows = [];
  for (const [label, url] of SITES.filter(([l]) => !ONLY.length || ONLY.includes(l))) {
    const row = await siteVerdict(browser, label, url);
    rows.push(row);
    const verdict = row.blocked ? `BLOCKED (${row.blockedBy})` : row.note.startsWith('ERROR') ? row.note : 'ok';
    console.log(`    ${label.padEnd(22)} ${String(row.status ?? '-').padEnd(4)} ${verdict.padEnd(34)} ${row.title.slice(0, 34)}`);
  }
  return rows;
}

async function main() {
  console.log('\n=== robustness probe ===');
  console.log(`chrome:   ${resolveExecutablePath()}`);
  console.log(`args:     ${BASE_ARGS.join(' ')}`);
  console.log(`headless: ${HEADLESS}`);

  // ---------------------------------------------------------- 1. identity
  let browser = await launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto('about:blank');

  console.log('\n  --- identity as a site sees it ---');
  const fp = await fingerprint(page);
  for (const [k, v] of Object.entries(fp)) line(k, String(v));

  console.log('\n  --- request headers ---');
  const hdrs = await page.evaluate(async () => {
    const r = await fetch('https://httpbin.org/headers', { cache: 'no-store' });
    return (await r.json()).headers;
  }).catch((e) => ({ error: e.message }));
  for (const [k, v] of Object.entries(hdrs)) line(k, String(v).slice(0, 110));

  console.log('\n  --- fonts (ink vs tofu reference) ---');
  const fonts = await fontReport(page);
  line('tofu reference (PUA)', String(fonts.tofuReference));
  for (const [k, v] of Object.entries(fonts)) {
    if (k === 'tofuReference') continue;
    line(k, `ink=${v.ink} ${v.real ? 'real glyphs' : 'MISSING (renders as tofu)'}`);
  }

  console.log('\n  --- Enter / form submission semantics ---');
  const enterRun = await formEnterSemantics(browser);
  const enterResults = enterRun.submitResults;
  for (const r of enterResults) {
    const seen = new Set(r.seen);
    line(r.label, `${seen.has('submit') ? 'SUBMITS' : 'no submit'} [${[...seen].join(',') || 'no events'}] -> ${r.url.replace(/^http:\/\/127\.0\.0\.1:\d+/, '')}`);
  }
  console.log('  --- Enter inside a textarea (double-newline check) ---');
  for (const r of enterRun.newlineResults) line(r.label, JSON.stringify(r.value));

  const version = await browser.version();

  // ------------------------------------------------------- 2. baseline sweep
  let baselineRows = [];
  if (RUN_SITES) baselineRows = await sweep('stock image args', browser);
  await browser.close();

  // ------------------------------------------------------- 3. hardened sweep
  let hardenedFp = null;
  let hardenedRows = [];
  let hardenedEnter = [];
  if (RUN_HARDENED) {
    console.log(`\n=== hardened pass ===`);
    console.log(`  extra args: ${HARDENING_ARGS.join(' ')}`);
    console.log(`  mode: ${HARDEN_MODE}`);
    console.log(`  user-agent: ${HARDENING_UA || '(unchanged — still HeadlessChrome)'}`);
    browser = await launch(HARDENING_ARGS, HARDENING_UA);
    const p2 = await browser.newPage();
    await p2.setViewport({ width: 1280, height: 900 });
    await p2.goto('about:blank');
    hardenedFp = await fingerprint(p2);
    console.log('\n  --- identity with hardening ---');
    for (const k of ['userAgent', 'webdriver', 'plugins', 'mimeTypes', 'chromeRuntime', 'pdfViewerEnabled', 'screen', 'outerInner', 'timezone', 'webglRenderer', 'mp4_h264', 'mp3']) {
      line(k, String(hardenedFp[k]));
    }
    const hardenedHeaders = await p2.evaluate(async () => {
      const r = await fetch('https://httpbin.org/headers', { cache: 'no-store' });
      return (await r.json()).headers;
    }).catch((e) => ({ error: e.message }));
    console.log('\n  --- request headers with hardening (UA vs client hints) ---');
    for (const k of ['User-Agent', 'Sec-Ch-Ua', 'Sec-Ch-Ua-Platform', 'Sec-Ch-Ua-Mobile', 'Accept-Language']) {
      line(k, String(hardenedHeaders[k] ?? '(absent)').slice(0, 110));
    }
    const hardenedEnterRun = await formEnterSemantics(browser);
    console.log('\n  --- Enter semantics with hardening (same key path) ---');
    for (const r of hardenedEnterRun.submitResults) {
      const seen = new Set(r.seen);
      line(r.label, `${seen.has('submit') ? 'SUBMITS' : 'no submit'} [${[...seen].join(',') || 'no events'}]`);
    }
    if (RUN_SITES) hardenedRows = await sweep('hardened args', browser);
    await browser.close();
  }

  // ------------------------------------------------------------- 4. summary
  console.log('\n=== summary ===');
  if (baselineRows.length && hardenedRows.length) {
    const base = baselineRows.filter((r) => r.blocked).map((r) => r.label);
    const hard = hardenedRows.filter((r) => r.blocked).map((r) => r.label);
    console.log(`  blocked, stock args:    ${base.length ? base.join(', ') : 'none'}`);
    console.log(`  blocked, hardened:      ${hard.length ? hard.join(', ') : 'none'}`);
  }
  console.log(`  navigator.webdriver:    stock=${fp.webdriver} hardened=${hardenedFp ? hardenedFp.webdriver : 'n/a'}`);
  console.log(`  UA contains HeadlessChrome: ${/HeadlessChrome/.test(fp.userAgent)} -> hardened ${hardenedFp ? /HeadlessChrome/.test(hardenedFp.userAgent) : 'n/a'}`);
  const submits = enterResults.filter((r) => r.seen.includes('submit')).map((r) => r.label);
  console.log(`  Enter submits form:     ${submits.length ? submits.join(' | ') : 'NEVER (in any dispatch variant)'}`);
  console.log(`  Enter in textarea:      ${enterRun.newlineResults.map((r) => `${r.label.split(' ')[1]}=${JSON.stringify(r.value)}`).join('  ')}`);
  console.log(`  chromium version:       ${version}`);
  return 0;
}

main()
  .then((c) => setTimeout(() => process.exit(c), 200))
  .catch((err) => {
    console.error(`\nprobe failed: ${err.stack || err.message}`);
    setTimeout(() => process.exit(1), 200);
  });
