'use strict';

/**
 * Docs page integrity check.
 *
 * The landing page is hand-written HTML with inline CSS, so a well-meaning copy
 * edit can silently push the document wider than the viewport. That is not
 * hypothetical: a long <code> added to the deploy spec list could not shrink
 * inside its flex row and widened the whole page on desktop. Nothing else in
 * the suite loads the page, so this check loads docs/index.html in a real
 * browser at a range of widths and fails on:
 *
 *   - horizontal overflow at any width (an element wider than the document)
 *   - an internal #anchor with no matching id
 *   - a copy button pointing at a different element than it references
 *   - JSON-LD that does not parse
 *
 *   node test/docs.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const { resolveExecutablePath } = require('../server/browser');

const DOCS_DIR = path.join(__dirname, '..', 'docs');
const PAGE = 'index.html';

// A responsive page should never scroll sideways. These widths span a wide
// desktop down to the narrowest phone the layout claims to support.
const WIDTHS = [1440, 1280, 1100, 1024, 900, 820, 768, 700, 640, 560, 480, 420, 390, 360, 320];
const TOLERANCE = 1; // px, for sub-pixel rounding

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
};

const results = [];
let failures = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok) });
  if (!ok) failures += 1;
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Serve docs/ over HTTP so relative assets resolve exactly as they do live. */
function serveDir(root) {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(root, rel === '/' ? `/${PAGE}` : rel);
    // Never serve outside the docs directory.
    if (!file.startsWith(root + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/**
 * Runs in the page. An element that poking past the viewport is only a problem
 * if nothing between it and the document clips it — a <pre> scrolls its own
 * overflow, so its children are expected to stick out.
 */
function measureOverflow(tolerance) {
  const docEl = document.documentElement;
  const clipped = (el) => {
    for (let p = el.parentElement; p && p !== docEl; p = p.parentElement) {
      if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(p).overflowX)) return true;
    }
    return false;
  };
  const offenders = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (r.right <= docEl.clientWidth + tolerance) continue;
    if (clipped(el)) continue;
    const cls = el.className ? `.${String(el.className).split(' ')[0]}` : '';
    offenders.push(`${el.tagName.toLowerCase()}${cls}(right=${Math.round(r.right)})`);
  }
  return {
    clientWidth: docEl.clientWidth,
    scrollWidth: docEl.scrollWidth,
    offenders: offenders.slice(0, 3),
    offenderCount: offenders.length,
  };
}

/** Runs in the page: structural checks that do not depend on layout. */
function inspectDocument() {
  const anchors = [...document.querySelectorAll('a[href^="#"]')]
    .map((a) => a.getAttribute('href'))
    .filter((h) => h && h.length > 1)
    .map((h) => h.slice(1));
  const missingAnchors = [...new Set(anchors)].filter((id) => !document.getElementById(id));

  const copyButtons = [...document.querySelectorAll('button.copy[data-copy]')].map((b) => b.dataset.copy);
  const brokenCopy = copyButtons.filter((id) => !document.getElementById(id));

  const jsonLd = [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent);
  const badJsonLd = [];
  jsonLd.forEach((text, index) => {
    try {
      JSON.parse(text);
    } catch (err) {
      badJsonLd.push(`block ${index + 1}: ${err.message}`);
    }
  });

  return {
    title: document.title,
    missingAnchors,
    brokenCopy,
    jsonLdCount: jsonLd.length,
    badJsonLd,
    // The fonts are referenced relative to the page, so a missing file shows up
    // as a failed request in the browser's own network layer.
    hasBody: Boolean(document.body && document.body.textContent.trim().length > 500),
  };
}

async function main() {
  const server = await serveDir(DOCS_DIR);
  const origin = `http://127.0.0.1:${server.address().port}/${PAGE}`;
  let browser;

  try {
    browser = await puppeteer.launch({
      executablePath: resolveExecutablePath(),
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--hide-scrollbars',
      ],
      defaultViewport: null,
    });

    const page = await browser.newPage();
    const failedRequests = [];
    page.on('requestfailed', (req) => failedRequests.push(`${req.url()} (${req.failure()?.errorText})`));

    const response = await page.goto(origin, { waitUntil: 'load' });
    await page.evaluate(() => (document.fonts ? document.fonts.ready : Promise.resolve()));

    console.log('\n-- page loads --');
    check('the page is served with 200', response && response.status() === 200, String(response && response.status()));

    const doc = await page.evaluate(inspectDocument);
    check('the page has a title', Boolean(doc.title), doc.title);
    check('the page has content', doc.hasBody);
    check('JSON-LD blocks parse', doc.badJsonLd.length === 0, doc.badJsonLd.join('; '));
    check('every internal anchor resolves', doc.missingAnchors.length === 0, doc.missingAnchors.join(', '));
    check('every copy button targets a real block', doc.brokenCopy.length === 0, doc.brokenCopy.join(', '));
    check('no subresource failed to load', failedRequests.length === 0, failedRequests.slice(0, 3).join('; '));

    console.log('\n-- no horizontal overflow at any width --');
    for (const width of WIDTHS) {
      await page.setViewport({ width, height: 900 });
      // Let the browser settle the new layout before measuring.
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const m = await page.evaluate(measureOverflow, TOLERANCE);
      check(
        `no overflow at ${width}px`,
        m.offenderCount === 0 && m.scrollWidth <= m.clientWidth + TOLERANCE,
        `scrollWidth=${m.scrollWidth} clientWidth=${m.clientWidth}${m.offenders.length ? ` — ${m.offenders.join(', ')}` : ''}`
      );
    }

    console.log(`\n=== ${results.length - failures}/${results.length} checks passed ===`);
    for (const r of results.filter((x) => !x.ok)) console.log(`  FAILED: ${r.name}`);
    return failures === 0 ? 0 : 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = { main };