'use strict';

/**
 * [CLIENTIP] One client-IP answer for both HTTP and WebSocket traffic.
 *
 * Express computes req.ip from its `trust proxy` setting, but the WebSocket
 * upgrade path reads the raw socket, which behind a proxy is the *proxy's*
 * address. A per-IP cap fed the proxy's IP would cap every user at once, so the
 * WS side has to apply the same hop-count logic. This module is that shared
 * logic; it mirrors Express's numeric trust-proxy semantics.
 */

const { normalizeIp } = require('./trust');

/**
 * @param {object} parts
 * @param {string} parts.remoteAddress  raw socket address
 * @param {string} parts.forwardedFor   X-Forwarded-For header value (optional)
 * @param {number} parts.trustProxy     number of trusted proxy hops (0 = none)
 */
function clientIpFromParts({ remoteAddress, forwardedFor, trustProxy = 0 } = {}) {
  const socketIp = normalizeIp(remoteAddress);
  const hops = Number(trustProxy) > 0 ? Math.floor(Number(trustProxy)) : 0;
  if (hops <= 0 || !forwardedFor) return socketIp;

  const forwarded = String(forwardedFor)
    .split(',')
    .map((entry) => normalizeIp(entry))
    .filter(Boolean);
  if (!forwarded.length) return socketIp;

  // Chain nearest-first: [socket, ...forwarded]. The first `hops` entries are
  // the trusted proxies, so the client sits at index `hops`.
  const chain = [socketIp, ...forwarded].filter(Boolean);
  const index = Math.min(hops, chain.length - 1);
  return chain[index] || socketIp;
}

/** Pull the raw address + XFF off a Node request (HTTP or WS upgrade). */
function clientIpFromRequest(req, trustProxy = 0) {
  if (!req) return null;
  const headers = (req && req.headers) || {};
  const forwardedFor = headers['x-forwarded-for'] || headers['x-real-ip'] || '';
  const remoteAddress = (req.socket && req.socket.remoteAddress) || req.remoteAddress;
  return clientIpFromParts({ remoteAddress, forwardedFor, trustProxy });
}

module.exports = { clientIpFromParts, clientIpFromRequest };
