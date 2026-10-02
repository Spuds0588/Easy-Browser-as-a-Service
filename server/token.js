#!/usr/bin/env node
'use strict';

/**
 * Mint a short-lived access token from the command line.
 *
 *   RBAS_KEY=<key> node server/token.js --ttl 15m --sub alice
 *
 * Prints the token to stdout (safe to capture with `$(…)`); diagnostics go to
 * stderr, so `TOKEN=$(node server/token.js)` yields just the token.
 *
 * The key is resolved from --key first, then RBAS_KEY. Unlike the server this
 * never invents a key — minting with a throwaway key would produce tokens the
 * server cannot verify.
 */

const { createAuth, generateKey } = require('./auth');

function flag(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : null;
}

function main() {
  const key = flag('key') || process.env.RBAS_KEY || '';
  if (!key) {
    process.stderr.write(
      'No signing key. Pass --key <secret> or set RBAS_KEY to the key the server is using.\n' +
        `Generate one with:  RBAS_KEY=$(node -e "console.log(require('./server/auth').generateKey())") node server/token.js\n` +
        `(a fresh key looks like: ${generateKey()})\n`
    );
    process.exit(1);
  }

  const quiet = { log() {}, warn() {}, error() {} };
  const auth = createAuth({ key, logger: quiet });
  const result = auth.sign({
    ttlMs: flag('ttl') || undefined,
    sub: flag('sub') || undefined,
    scope: flag('scope') || undefined,
  });

  process.stderr.write(`expires ${new Date(result.expiresAt).toISOString()}\n`);
  process.stdout.write(`${result.token}\n`);
}

main();
