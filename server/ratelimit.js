'use strict';

/**
 * [RATELIMIT] A tiny per-key token bucket.
 *
 * Used to bound how fast one address can create *new* sessions (the concurrency
 * cap lives in SessionManager and is a separate, complementary control). A token
 * bucket allows a short burst up to `limit` and then refills steadily, which
 * suits "open a couple of tabs, but don't churn contexts".
 *
 *   RBAS_SESSION_RATE="20/min"  (default), "5/sec", "100/hour", "0" to disable.
 */

/** Parse "20/min" (or a bare number = per minute) into { limit, windowMs }. */
function parseRate(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return { limit: Math.floor(value), windowMs: 60_000, raw: String(value) };
  }
  const text = String(value).trim().toLowerCase();
  if (text === '0' || text === 'off' || text === 'none' || text === 'unlimited') return null;

  const match = text.match(/^(\d+(?:\.\d+)?)\s*(?:\/\s*)?(sec|s|second|min|m|minute|hour|h|hr)?s?$/);
  if (!match) return fallback;
  const limit = Math.floor(Number(match[1]));
  const unit = match[2] || 'min';
  let windowMs = 60_000;
  if (unit.startsWith('s')) windowMs = 1_000;
  else if (unit.startsWith('h')) windowMs = 3_600_000;
  if (!Number.isFinite(limit) || limit <= 0) return null;
  return { limit, windowMs, raw: text };
}

class RateLimiter {
  constructor({ limit, windowMs }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.refillPerMs = limit / windowMs;
    this.buckets = new Map();
  }

  /**
   * @returns {{ allowed: boolean, remaining?: number, retryAfterMs?: number }}
   * Never throws; a `null`/disabled limiter is handled by the caller.
   */
  check(key, now = Date.now()) {
    if (!this.limit || this.limit <= 0) return { allowed: true, remaining: this.limit };
    const bucket = this.buckets.get(key) || { tokens: this.limit, updated: now };
    bucket.tokens = Math.min(this.limit, bucket.tokens + (now - bucket.updated) * this.refillPerMs);
    bucket.updated = now;
    this.buckets.set(key, bucket);

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, remaining: Math.floor(bucket.tokens) };
    }
    const retryAfterMs = Math.ceil((1 - bucket.tokens) / this.refillPerMs);
    return { allowed: false, retryAfterMs };
  }

  /** Drop buckets that have fully refilled and gone quiet. */
  prune(now = Date.now()) {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updated > this.windowMs * 2) this.buckets.delete(key);
    }
  }

  get size() {
    return this.buckets.size;
  }

  /** One-line summary for boot logs. */
  describe() {
    const seconds = Math.round(this.windowMs / 1000);
    return `${this.limit} new/${seconds}s`;
  }
}

/** Build a limiter, or null when the rate is disabled. */
function createRateLimiter(rate) {
  if (!rate || !rate.limit || rate.limit <= 0) return null;
  return new RateLimiter(rate);
}

module.exports = { parseRate, createRateLimiter, RateLimiter };
