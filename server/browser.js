'use strict';

/**
 * [BOOT] Master browser lifecycle.
 *
 * Architectural directive: exactly ONE Chromium process is launched for the
 * whole server. Every user gets an isolated IncognitoBrowserContext from this
 * master, which keeps memory/CPU bounded as concurrency grows.
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const EXECUTABLE_CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const BASE_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--hide-scrollbars',
  '--mute-audio',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
];

function resolveExecutablePath() {
  for (const candidate of EXECUTABLE_CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore unreadable candidates */
    }
  }
  return discoverCachedChrome() || undefined;
}

/**
 * The Docker base image (ghcr.io/puppeteer/puppeteer) ships a Chromium in its
 * puppeteer cache, but the revision folder won't match a differently pinned
 * puppeteer. Find whatever binary is actually there.
 */
function discoverCachedChrome() {
  const roots = [
    process.env.PUPPETEER_CACHE_DIR,
    process.env.PUPPETEER_CACHE,
    path.join(process.env.HOME || '', '.cache', 'puppeteer'),
    '/home/pptruser/.cache/puppeteer',
  ].filter(Boolean);
  for (const root of roots) {
    const chromeDir = path.join(root, 'chrome');
    let revisions = [];
    try {
      revisions = fs.readdirSync(chromeDir).sort().reverse();
    } catch {
      continue;
    }
    for (const revision of revisions) {
      for (const relative of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing']) {
        const full = path.join(chromeDir, revision, relative);
        try {
          if (fs.existsSync(full)) return full;
        } catch {
          /* ignore */
        }
      }
    }
  }
  return null;
}

class BrowserManager {
  constructor({ logger = console } = {}) {
    this.logger = logger;
    this.browser = null;
    this.launching = null;
    this.version = null;
    this.shuttingDown = false;
    this.onCrash = null;
  }

  async launch() {
    if (this.browser && this.browser.connected) return this.browser;
    if (this.launching) return this.launching;

    this.launching = (async () => {
      const executablePath = resolveExecutablePath();
      const extraArgs = process.env.PUPPETEER_ARGS ? process.env.PUPPETEER_ARGS.split(' ').filter(Boolean) : [];
      this.browser = await puppeteer.launch({
        executablePath,
        headless: process.env.PUPPETEER_HEADLESS !== 'false',
        args: [...BASE_ARGS, ...extraArgs],
        defaultViewport: null,
        protocolTimeout: Number(process.env.CDP_TIMEOUT_MS || 180000),
      });
      this.version = await this.browser.version().catch(() => 'unknown');
      this.logger.log(
        `[BOOT] master browser launched pid=${this.browser.process()?.pid || '?'} version=${this.version} chrome=${executablePath || '(bundled)'}`
      );

      this.browser.on('disconnected', () => {
        this.logger.error('[BOOT] master browser disconnected');
        this.browser = null;
        if (this.shuttingDown) return;
        if (this.onCrash) this.onCrash();
      });
      return this.browser;
    })();

    try {
      return await this.launching;
    } finally {
      this.launching = null;
    }
  }

  /** Create an isolated incognito-like context for a single user session. */
  async createContext() {
    const browser = await this.launch();
    return browser.createBrowserContext();
  }

  async close() {
    this.shuttingDown = true;
    if (this.browser) {
      try {
        await this.browser.close();
      } catch {
        /* already gone */
      }
    }
    this.browser = null;
  }
}

module.exports = { BrowserManager, resolveExecutablePath, discoverCachedChrome };
