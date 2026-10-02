'use strict';

/**
 * [TARGETS] Which domains the remote browser is allowed to top-level navigate to.
 *
 * The point is not to sandbox the remote page (a page can still pull its own
 * subresources), but to stop the embed from becoming a free general-purpose web
 * browser on somebody else's compute. Operators who are embedding one app or one
 * enterprise domain can lock it to exactly that:
 *
 *   RBAS_ALLOWED_DOMAINS="app.example.com"          -> apex + all subdomains
 *   RBAS_ALLOWED_DOMAINS="*.corp.internal,acme.com" -> wildcard entries too
 *   RBAS_ALLOWED_DOMAINS="*"   (or unset)           -> open, anything loads
 *
 * Matching rules:
 *   - A bare domain (example.com) matches the apex AND every subdomain, so one
 *     entry locks down a whole domain. `*.example.com` is normalised to the same
 *     thing — the wildcard is accepted for legibility, not as a distinct rule.
 *   - IP literals match exactly (an IPv4/IPv6 literal never "has subdomains").
 *   - Only http(s) and about: schemes are ever allowed; file:/data:/chrome: are
 *     refused even when the filter is wide open, because a file:// navigation is
 *     a read of the container's filesystem.
 *
 * This is deliberately separate from server/trust.js: parseOrigins there is an
 * exact-match list for the *minting* decision, and giving it wildcard semantics
 * would quietly widen who may mint. Different question, different matcher.
 */

const { parseList } = require('./trust');

// Schemes a remote browser may ever use. `about:blank` is the empty page.
const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'about:']);

/** Strip scheme/path/port and a leading wildcard label; return {host, subdomains}. */
function parseDomainRule(entry) {
  let text = String(entry).trim().toLowerCase();
  if (!text) return null;

  let subdomains = false;
  if (text.startsWith('*.')) {
    subdomains = true;
    text = text.slice(2);
  } else if (text === '*' || text === '*.*') {
    return null; // the whole-list "open" case is handled in parseDomains
  }

  // Parse with a dummy scheme so URL handles ports, brackets and IPv6 literals.
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//.test(text) ? text : `http://${text}`;
  let host;
  try {
    host = new URL(candidate).hostname;
  } catch {
    return null;
  }
  if (!host) return null;
  host = host.replace(/^\[|\]$/g, '').toLowerCase();

  // An IP literal (v4 or v6) never matches subdomains.
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
  if (isIp) return { host, matchSubdomains: false, raw: entry.trim() };

  return { host, matchSubdomains: true, raw: entry.trim() };
}

/**
 * Parse RBAS_ALLOWED_DOMAINS into { open, rules, invalid }.
 * `open: true` means "no restriction"; rules are ignored in that case.
 */
function parseDomains(value) {
  const entries = parseList(value);
  if (!entries.length || entries.some((entry) => entry === '*' || entry === '*.*')) {
    return { open: true, rules: [], invalid: [] };
  }
  const rules = [];
  const invalid = [];
  for (const entry of entries) {
    if (entry === '*' || entry === '*.*') {
      return { open: true, rules: [], invalid: [] };
    }
    const rule = parseDomainRule(entry);
    if (rule) rules.push(rule);
    else invalid.push(entry);
  }
  // Fail closed: if entries were given but none parsed, nothing is allowed.
  return { open: false, rules, invalid };
}

/** Return { scheme, host, ok } for a candidate URL, or null when unparseable. */
function parseTarget(url) {
  if (!url || typeof url !== 'string') return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const scheme = parsed.protocol.toLowerCase();
  const host = (parsed.hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  return { scheme, host, href: parsed.href };
}

function hostMatches(host, rules) {
  for (const rule of rules) {
    if (host === rule.host) return true;
    if (rule.matchSubdomains && host.endsWith(`.${rule.host}`)) return true;
  }
  return false;
}

/**
 * Decide whether the remote browser may top-level navigate to `url`.
 * Always returns { allowed, reason, scheme, host } — never throws.
 */
function isAllowedTarget(url, domains) {
  const target = parseTarget(url);
  if (!target) return { allowed: false, reason: 'unparseable url', scheme: null, host: null };
  if (!ALLOWED_SCHEMES.has(target.scheme)) {
    return { allowed: false, reason: `scheme not allowed: ${target.scheme}`, scheme: target.scheme, host: target.host };
  }
  // about:blank is the empty page and is always fine.
  if (target.scheme === 'about:') return { allowed: true, reason: 'about:', scheme: target.scheme, host: target.host };
  if (!domains || domains.open) return { allowed: true, reason: 'open', scheme: target.scheme, host: target.host };
  if (hostMatches(target.host, domains.rules)) {
    return { allowed: true, reason: 'matched', scheme: target.scheme, host: target.host };
  }
  return { allowed: false, reason: `domain not allowed: ${target.host || url}`, scheme: target.scheme, host: target.host };
}

/** Human-readable one-liner for boot logs. */
function describeDomains(domains) {
  if (!domains || domains.open) return 'open (all domains allowed)';
  return `allowing ${domains.rules.map((r) => (r.matchSubdomains ? `${r.host} (+subdomains)` : r.host)).join(', ') || 'nothing'}`;
}

module.exports = {
  parseDomains,
  parseDomainRule,
  parseTarget,
  isAllowedTarget,
  hostMatches,
  describeDomains,
};
