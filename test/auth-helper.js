'use strict';

/**
 * Shared auth plumbing for the test harnesses.
 *
 * Every self-spawned service runs with a deterministic RBAS_KEY so the harness
 * can mint its own tokens. Against an external deployment, pass RBAS_KEY (to
 * mint locally) or E2E_TOKEN (a ready-made token the deployment accepts).
 */

const { createAuth } = require('../server/auth');

const DEFAULT_TEST_KEY = 'rbas-test-key-0123456789abcdef0123456789abcdef';

const KEY = process.env.RBAS_KEY || DEFAULT_TEST_KEY;

const quiet = { log() {}, warn() {}, error() {} };
const auth = createAuth({ key: KEY, logger: quiet });

// Long enough to outlive any harness run; short-lived tokens are the point in
// production, but tests should not race their own expiry.
const TOKEN = process.env.E2E_TOKEN || auth.sign({ sub: 'test-harness', ttlMs: 60 * 60 * 1000 }).token;

module.exports = {
  KEY,
  TOKEN,
  auth,
  authHeaders() {
    return { Authorization: `Bearer ${TOKEN}` };
  },
};
