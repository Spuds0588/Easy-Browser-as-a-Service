'use strict';

/**
 * [TRUST] Origin and network allow-lists for the no-backend mint path.
 *
 * A browser that has no backend to mint tokens for it can still be given one,
 * if the operator says which origins and which networks may ask. That is a
 * *web* control first, a network control second:
 *
 *   - The Origin header is set by the browser and cannot be forged by page
 *     JavaScript, so other websites cannot mint. A non-browser client can set
 *     any Origin it likes, so the Origin list alone is not a security boundary.
 *   - The network list is what actually constrains a non-browser client. With
 *     it set, a request must come from a permitted address AND carry a
 *     permitted Origin.
 *
 * The master signing key (RBAS_KEY) is never weakened by any of this: it keeps
 * minting whatever it likes, with whatever TTL it asks for.
 */

const NET_V4 = 4;
const NET_V6 = 6;

/** Split a comma/space separated env value into trimmed, non-empty entries. */
function parseList(value) {
  if (!value) return [];
  return String(value)
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** Origins are compared exactly, so normalise away a trailing slash. */
function parseOrigins(value) {
  return parseList(value).map((origin) => origin.replace(/\/+$/, ''));
}

function normalizeIp(ip) {
  if (!ip) return null;
  let value = String(ip).trim();
  const zone = value.indexOf('%'); // fe80::1%eth0
  if (zone !== -1) value = value.slice(0, zone);
  if (value.startsWith('::ffff:')) value = value.slice(7); // IPv4-mapped IPv6
  return value || null;
}

function ipv4ToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

function ipv6ToBytes(ip) {
  if (String(ip).indexOf(':') === -1) return null;
  const doubleIndex = String(ip).indexOf('::');
  let head;
  let tail;
  if (doubleIndex !== -1) {
    head = String(ip).slice(0, doubleIndex);
    tail = String(ip).slice(doubleIndex + 2);
  } else {
    head = String(ip);
    tail = null;
  }
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail ? tail.split(':') : [];
  const filled = tail === null ? headGroups : [...headGroups, ...Array(8 - headGroups.length - tailGroups.length).fill('0'), ...tailGroups];
  if (filled.length !== 8) return null;
  const bytes = Buffer.alloc(16);
  for (let i = 0; i < 8; i += 1) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(filled[i])) return null;
    const group = parseInt(filled[i], 16);
    bytes[i * 2] = group >> 8;
    bytes[i * 2 + 1] = group & 0xff;
  }
  return bytes;
}

/** Parse "10.0.0.0/8", "127.0.0.1", "::1" or "fd00::/8" into a matcher. */
function parseNetwork(entry) {
  const [address, prefix] = String(entry).split('/');
  const bits = prefix === undefined || prefix === '' ? null : Number(prefix);
  const v4 = ipv4ToInt(address);
  if (v4 !== null) {
    const width = bits === null ? 32 : bits;
    if (!Number.isInteger(width) || width < 0 || width > 32) return null;
    return { family: NET_V4, base: v4, bits: width, raw: entry };
  }
  const v6 = ipv6ToBytes(address);
  if (v6) {
    const width = bits === null ? 128 : bits;
    if (!Number.isInteger(width) || width < 0 || width > 128) return null;
    return { family: NET_V6, base: v6, bits: width, raw: entry };
  }
  return null;
}

function parseNetworks(value) {
  return parseList(value)
    .map(parseNetwork)
    .filter(Boolean);
}

function ipMatchesNetwork(ip, network) {
  const normalized = normalizeIp(ip);
  if (!normalized) return false;
  if (network.family === NET_V4) {
    const address = ipv4ToInt(normalized);
    if (address === null) return false;
    const mask = network.bits === 0 ? 0 : (0xffffffff << (32 - network.bits)) >>> 0;
    return (address & mask) === (network.base & mask);
  }
  const address = ipv6ToBytes(normalized);
  if (!address) return false;
  let remaining = network.bits;
  for (let i = 0; i < 16 && remaining > 0; i += 1) {
    const take = Math.min(8, remaining);
    const mask = take === 8 ? 0xff : (0xff << (8 - take)) & 0xff;
    if ((address[i] & mask) !== (network.base[i] & mask)) return false;
    remaining -= take;
  }
  return true;
}

function ipInNetworks(ip, networks) {
  if (!networks || !networks.length) return false;
  return networks.some((network) => ipMatchesNetwork(ip, network));
}

/**
 * Decide whether a request may mint a token on its own behalf.
 * Returns { ok, reason, origin, ip } — never throws.
 */
function evaluateBrowserTrust(req, { origins, networks }) {
  if (!origins || !origins.length) {
    return { ok: false, reason: 'no trusted origins configured (set RBAS_TRUSTED_ORIGINS)' };
  }
  const origin = String((req && req.get && req.get('origin')) || '').replace(/\/+$/, '');
  if (!origin) return { ok: false, reason: 'missing Origin header' };
  if (!origins.includes(origin)) return { ok: false, reason: `origin not trusted: ${origin}` };

  const ip = normalizeIp((req && req.ip) || (req && req.socket && req.socket.remoteAddress));
  if (networks && networks.length) {
    if (!ipInNetworks(ip, networks)) return { ok: false, reason: `client network not trusted: ${ip || 'unknown'}` };
  }
  return { ok: true, origin, ip };
}

module.exports = {
  parseList,
  parseOrigins,
  parseNetworks,
  parseNetwork,
  normalizeIp,
  ipInNetworks,
  ipMatchesNetwork,
  evaluateBrowserTrust,
};
