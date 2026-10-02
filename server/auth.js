'use strict';

/**
 * [AUTH] Dependency-free access control.
 *
 * One long-lived *signing key* stays on the server, either supplied by the
 * operator (`RBAS_KEY`) or generated at boot. Browsers never see it: they only
 * ever receive short-lived tokens signed with it, so a token leaked out of a
 * page expires on its own and can never be replayed as the master key.
 *
 *   token   = "v1." + base64url(payload) + "." + base64url(HMAC-SHA256(key, "v1." + base64url(payload)))
 *   payload = { iat, exp, sub?, scope? }
 *
 * Verification is stateless — no token store, no database — matching the rest
 * of the product.
 */

const crypto = require('crypto');

const VERSION = 'v1';
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MIN_TTL_MS = 1000;
const CLOCK_SKEW_MS = 30 * 1000;
const MIN_KEY_BYTES = 16;

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

/** Constant-time string comparison (both sides are ASCII base64url). */
function timingEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** A fresh 32-byte secret, safe to paste into an env var. */
function generateKey() {
  return crypto.randomBytes(32).toString('base64url');
}

function normalizeKey(key) {
  if (Buffer.isBuffer(key)) return key.length ? key : null;
  if (typeof key === 'string' && key.length) return Buffer.from(key, 'utf8');
  return null;
}

/** "15m" | "1h" | "90s" | "500ms" | "3600000" -> milliseconds. */
function parseDuration(value, fallback = DEFAULT_TTL_MS) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(String(value).trim().toLowerCase());
  if (!match) return fallback;
  const amount = Number(match[1]);
  const scale = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] || 'ms'];
  return Math.round(amount * scale);
}

/**
 * Build an auth helper bound to one signing key.
 *
 * If no key is supplied, one is generated and logged: the server is therefore
 * never accidentally open, at the cost of tokens not surviving a restart.
 */
function createAuth({ key, ttlMs, logger = console } = {}) {
  let resolved = normalizeKey(key) || normalizeKey(process.env.RBAS_KEY);
  let generated = false;
  if (!resolved) {
    generated = true;
    resolved = Buffer.from(generateKey(), 'utf8');
    logger.warn(
      '[AUTH] RBAS_KEY is not set — generated a random signing key for this process.\n' +
        '[AUTH] Tokens minted now will stop verifying after a restart. Set RBAS_KEY to keep them stable.\n' +
        `[AUTH] generated key: ${resolved.toString('utf8')}`
    );
  } else if (resolved.length < MIN_KEY_BYTES) {
    logger.warn(`[AUTH] RBAS_KEY is only ${resolved.length} bytes — use at least 32 random bytes in production.`);
  }

  const defaultTtlMs =
    typeof ttlMs === 'number' ? ttlMs : parseDuration(process.env.RBAS_TOKEN_TTL_MS, DEFAULT_TTL_MS);
  const keyId = crypto.createHash('sha256').update(resolved).digest('hex').slice(0, 8);

  function clampTtl(requested) {
    const value = Number(requested);
    const usable = Number.isFinite(value) && value > 0 ? value : defaultTtlMs;
    return Math.min(Math.max(usable, MIN_TTL_MS), MAX_TTL_MS);
  }

  /** Mint a signed, expiring token. Returns { token, payload, expiresAt }. */
  function sign(options = {}) {
    const now = Date.now();
    const payload = {
      iat: now,
      exp: now + clampTtl(options.ttlMs),
      ...(options.sub ? { sub: String(options.sub) } : {}),
      ...(options.scope ? { scope: String(options.scope) } : {}),
    };
    const encoded = b64url(JSON.stringify(payload));
    const signingInput = `${VERSION}.${encoded}`;
    const signature = b64url(crypto.createHmac('sha256', resolved).update(signingInput).digest());
    return { token: `${signingInput}.${signature}`, payload, expiresAt: payload.exp };
  }

  /** Verify a token. Always returns { ok, reason?, payload? } — never throws. */
  function verify(token) {
    if (typeof token !== 'string' || !token) return { ok: false, reason: 'missing token' };
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== VERSION || !parts[1] || !parts[2]) {
      return { ok: false, reason: 'malformed token' };
    }
    const signingInput = `${VERSION}.${parts[1]}`;
    const expected = b64url(crypto.createHmac('sha256', resolved).update(signingInput).digest());
    if (!timingEqual(expected, parts[2])) return { ok: false, reason: 'bad signature' };

    let payload;
    try {
      payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
      return { ok: false, reason: 'malformed payload' };
    }
    if (!payload || typeof payload.exp !== 'number') return { ok: false, reason: 'missing expiry' };
    if (Date.now() > payload.exp + CLOCK_SKEW_MS) return { ok: false, reason: 'token expired' };
    return { ok: true, payload };
  }

  /** Does this string equal the raw signing key? For `/api/token` only. */
  function verifyMasterKey(candidate) {
    if (typeof candidate !== 'string' || !candidate) return false;
    return timingEqual(candidate, resolved.toString('utf8'));
  }

  /** Pull a token from `Authorization: Bearer …` or `?token=…`. */
  function tokenFromRequest(req) {
    const headers = (req && req.headers) || {};
    const header = headers.authorization || headers.Authorization;
    if (header) {
      const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
      if (match) return match[1].trim();
      return String(header).trim();
    }
    const query = (req && req.query) || {};
    if (typeof query.token === 'string' && query.token) return query.token;
    return null;
  }

  /** Express middleware: reject the request unless it carries a valid token. */
  function httpGuard() {
    return (req, res, next) => {
      const result = verify(tokenFromRequest(req));
      if (result.ok) {
        req.rbasAuth = result.payload;
        return next();
      }
      res.setHeader('WWW-Authenticate', 'Bearer realm="rbas"');
      return res.status(401).json({ error: 'unauthorized', reason: result.reason });
    };
  }

  /** WebSocket gate: the first message's `token` field must verify. */
  function verifyInit(msg) {
    return verify(msg && msg.token);
  }

  return {
    sign,
    verify,
    verifyMasterKey,
    tokenFromRequest,
    httpGuard,
    verifyInit,
    keyId,
    generated,
    defaultTtlMs,
    keyLength: resolved.length,
  };
}

module.exports = {
  createAuth,
  generateKey,
  parseDuration,
  DEFAULT_TTL_MS,
  MAX_TTL_MS,
};
