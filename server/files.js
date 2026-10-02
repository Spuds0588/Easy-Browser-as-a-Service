'use strict';

/**
 * Stateless file bridge.
 *
 * Downloads: the remote browser writes into the container /tmp, we register the
 * file under an opaque id and hand the host a short-lived `/download/:id` URL.
 * Uploads: the host POSTs raw bytes, we write to /tmp and hand the remote
 * browser the container-local path.
 *
 * Nothing here is durable: entries expire and are deleted, which keeps the
 * container stateless per the PRD.
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const ROOT = process.env.RBAS_TMP_DIR || path.join(os.tmpdir(), 'rbas');

class FileStore {
  constructor({ ttlMs = Number(process.env.FILE_TTL_MS || 5 * 60 * 1000), logger = console } = {}) {
    this.ttlMs = ttlMs;
    this.logger = logger;
    this.entries = new Map();
    this.sweeper = setInterval(() => this.sweep(), Math.max(30_000, Math.floor(ttlMs / 2)));
    if (this.sweeper.unref) this.sweeper.unref();
  }

  async ensureRoot() {
    await fsp.mkdir(ROOT, { recursive: true });
  }

  /** Reserve a container-local path for a remote download. */
  async reserveDownload(suggestedName = 'download') {
    await this.ensureRoot();
    const id = crypto.randomBytes(9).toString('hex');
    const safeName = String(suggestedName).replace(/[^\w.\-() ]+/g, '_').slice(0, 180) || 'download';
    const filePath = path.join(ROOT, `${id}-${safeName}`);
    const entry = { id, kind: 'download', path: filePath, filename: safeName, createdAt: Date.now() };
    this.entries.set(id, entry);
    return entry;
  }

  /** Adopt a file the remote browser already wrote to disk (download bridge). */
  async trackDownload(filePath, suggestedName) {
    const id = crypto.randomBytes(9).toString('hex');
    const filename = String(suggestedName || path.basename(filePath)).replace(/[^\w.\-() ]+/g, '_').slice(0, 180) || 'download';
    const entry = { id, kind: 'download', path: filePath, filename, createdAt: Date.now() };
    this.entries.set(id, entry);
    return entry;
  }

  /** Register a completed download and return the public descriptor. */
  completeDownload(id) {
    const entry = this.entries.get(id);
    if (!entry) return null;
    entry.completedAt = Date.now();
    return this.publicDescriptor(entry);
  }

  /**
   * Write an uploaded buffer to /tmp and return { id, path, filename }.
   *
   * Each upload gets its own directory so the basename the remote browser sees
   * is exactly the name the host user picked (no internal id prefix leaking
   * into `<input type=file>` or download prompts).
   */
  async storeUpload(filename, buffer) {
    await this.ensureRoot();
    const id = crypto.randomBytes(9).toString('hex');
    const safeName = String(filename || 'upload').replace(/[^\w.\-() ]+/g, '_').slice(0, 180) || 'upload';
    const dir = path.join(ROOT, 'uploads', id);
    await fsp.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, safeName);
    await fsp.writeFile(filePath, buffer);
    const entry = { id, kind: 'upload', path: filePath, dir, filename: safeName, createdAt: Date.now() };
    this.entries.set(id, entry);
    this.logger.log(`[FILES] upload stored id=${id} bytes=${buffer.length} name=${safeName}`);
    return entry;
  }

  get(id) {
    const entry = this.entries.get(id);
    if (!entry) return null;
    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.remove(id);
      return null;
    }
    return entry;
  }

  publicDescriptor(entry) {
    return {
      id: entry.id,
      filename: entry.filename,
      kind: entry.kind,
      bytes: safeSize(entry.path),
    };
  }

  remove(id) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    const target = entry.dir || entry.path;
    fs.rm(target, { force: true, recursive: true }, () => {});
  }

  sweep() {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (now - entry.createdAt > this.ttlMs) this.remove(id);
    }
  }

  dispose() {
    clearInterval(this.sweeper);
    for (const id of [...this.entries.keys()]) this.remove(id);
  }
}

function safeSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return undefined;
  }
}

module.exports = { FileStore, ROOT };
