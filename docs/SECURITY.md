# Security and limits

This service gives whoever can reach it a real browser on your network, driven on their behalf.
Read this before exposing `PORT` to an untrusted network.

## Authentication

Access is gated by short-lived HMAC-signed tokens, whose signing key is `RBAS_KEY`. Anything that can
open a TCP connection to `PORT` still reaches the open routes, but it can no longer start a session:

- `WS /ws` rejects an `init` without a valid token (close code `1008`) **before** any browser context
  is created, so an unauthenticated peer cannot cost you a Chromium.
- `/api/sessions`, `POST /upload` and `GET /download/:id` all require a token.
- `/api/token` requires either the master signing key, or a request from a trusted origin **and** a trusted network (see below).
- `DELETE /api/sessions/:id` requires a token and ends one session immediately.
- `/healthz`, `/sdk.js` and `/demo.html` are open: the container probe and a cross-origin asset load
  must work before any session exists.

What this does **not** do:

- It authenticates the *token*, not the *person*. Anyone holding a valid token — including anyone who
  can read it out of the embedding page — can drive a browser to any URL. Keep TTLs short and mint
  per-user tokens in your own backend.
- A token is checked when a session is **established**, not continuously, so a leaked token can be
  replayed for as long as the session it opened stays open.
- The built-in limits are per-IP, not per-user: they stop obvious abuse but a client can still rotate
  IPs, and behind a proxy the IP is only as trustworthy as `RBAS_TRUST_PROXY`. Per-user quotas and
  audit trails still belong in a reverse proxy.
- The signing key is the whole ballgame: whoever holds `RBAS_KEY` can mint tokens. Store it as a
  secret, never ship it to a browser, and rotate it by restarting with a new value (which invalidates
  outstanding tokens).

Per-user identity, quotas and audit trails still belong in a reverse proxy in front of the service.

## Letting a page with no backend mint for itself

`RBAS_TRUSTED_ORIGINS` (plus `RBAS_TRUSTED_NETWORKS`) lets a browser mint its own token, so a static
site or a packaged Electron/Tauri app needs no server of its own. Be precise about which half of that
pair does the work:

- The **`Origin` check is a web control, not a cryptographic one.** Browsers set `Origin` and page
  JavaScript cannot forge it, which stops other *websites*. It does not stop a non-browser client:
  anything that can open a TCP connection can send `Origin: https://app.example.com`.
- The **network check is what constrains that client.** Until `RBAS_TRUSTED_NETWORKS` is set, the
  trusted-origin path is effectively an open mint endpoint for anyone who can reach the port and
  knows one of the allowed origins. The service logs a warning at boot when only origins are set.
- Both are exact-match allow-lists. Keep them as narrow as the deployment allows, and keep a network
  boundary you control in front of the service regardless — that is the control doing the real work.

Tokens minted this way are capped at `RBAS_BROWSER_TOKEN_TTL_MS` (15 min by default) and carry
`sub: origin:<origin>`, so they are easy to spot and short-lived by construction. The master key is
unaffected and still mints with any TTL.

Behind a reverse proxy the socket address belongs to the proxy, so `RBAS_TRUST_PROXY` must be set to
the number of hops you actually trust. Set it too high and a client can spoof `X-Forwarded-For` to
look like it came from a trusted network — which is the whole check.

## Server-side request forgery

The remote browser runs **inside your infrastructure**, so it can reach anything that network can
reach: internal admin panels, databases, `169.254.169.254` cloud metadata, `localhost` services.
Authentication limits *who* can open a session, but it does not change *what that session can
reach* — for anyone holding a valid token, a session is still a full SSRF primitive.

`RBAS_ALLOWED_DOMAINS` narrows this, but do not mistake it for a network egress control. It filters
**top-level navigations** only: a page that is itself allowed can still fetch internal endpoints as
subresources, and an allow-list that includes an internal hostname hands that host to every session.
Treat the filter as a product guardrail (keep users on your app, protect your compute budget), not a
sandbox boundary — the network the browser runs on is the real one.

Mitigations, in rough order of strength:

- Treat every token holder as able to reach anything the browser can reach: mint tokens only for
  people you trust with that reach.
- Restrict the container's egress (network policy, egress proxy, or a private subnet) so the browser
  can only reach the applications you intend to embed.
- Keep the container away from sensitive networks and strip cloud metadata access
  (IMDSv2 + hop limit, or block `169.254.169.254`).

## Open CORS

Every HTTP route sets `Access-Control-Allow-Origin: *` (and answers `OPTIONS` with `204`) so the SDK
can be embedded from any origin. Consequences to be aware of:

- Any web page can read `/healthz` and load `/sdk.js`, and can *attempt* `POST /api/token` or
  `/upload` — but without the master key or a valid token those are `401`. CORS openness no longer
  implies access, because every sensitive route is token-gated.
- `/healthz` stays world-readable (uptime, session count, browser version) — keep that in mind if you
  consider any of it sensitive.

If you need to narrow this, restrict the origin at your proxy or reverse proxy rather than in the
app, and keep `/ws` and `/upload` on the same origin policy.

## Session state lives in the host page

Stateful data — the remote site's cookies and `localStorage` — is stored by the SDK in the *host
page's* `localStorage` under `rbas:session`. Two implications:

- Anyone who can run script on the host origin (XSS, a compromised third-party tag) can read the
  embedded session's cookies and storage, and can replay the `sessionId` to hijack the live session
  while it is warm.
- That state is deliberately kept client-side so the container stays stateless; do not treat host
  `localStorage` as a secure store for high-value credentials.

The server never persists session state to disk and holds no database, so a container restart loses
live sessions — but not the state the host still holds.

## File bridge

- Uploads are written to `RBAS_TMP_DIR` (default `/tmp/rbas`) and handed to the remote browser; the
  remote page sees the original filename (sanitised to word characters, dots, dashes, parentheses
  and spaces, truncated to 180 characters).
- Downloads are captured in a per-session directory and served at `/download/:id` until
  `FILE_TTL_MS` (5 minutes) elapses, after which the entry is deleted and the route returns `404`.
- Both are ephemeral: the sweeper deletes expired entries (and their per-upload directories) every
  `max(30s, FILE_TTL_MS/2)`.
- Size cap: `MAX_UPLOAD` (default `200mb`) per request; larger bodies are rejected by the body
  parser.

A malicious or compromised remote page can repeatedly trigger downloads and file-picker requests.
Downloads land on the host (the `download` event fires and the SDK clicks a hidden anchor), and
uploads always require a deliberate host-side file selection by the person at the keyboard — nothing
is read from the host filesystem without that picker.

## Clipboard

Clipboard sync is text-only and best-effort. Host→remote paste is inserted into the focused remote
element; remote→host copy fires the `clipboard` event and attempts `navigator.clipboard.writeText`,
which browsers may refuse without a user gesture or permission. Do not treat clipboard contents as
trusted input on either side — they are user-supplied text.

## Resource limits and abuse

| Control | Default | Effect |
| --- | --- | --- |
| `MAX_SESSIONS` | `8` | Concurrent sessions per instance; further connects are refused with an error. |
| `RBAS_MAX_SESSIONS_PER_IP` | `1` | Concurrent sessions from one client address; a further `init` is refused with `code: "limit"` and a `1013` close. `0` disables. |
| `RBAS_SESSION_RATE` | `20/min` | Token bucket of new sessions per address, so a client cannot close-and-reopen to mint contexts in a loop. `0` disables. |
| `RBAS_ALLOWED_DOMAINS` | — (open) | Domains the remote browser may top-level navigate to; empty/`*` is open. |
| `IDLE_TIMEOUT_MS` | `600000` | Connected-but-idle sessions are reaped (a connected client that is doing nothing still costs a Chromium context). |
| `HIDDEN_TIMEOUT_MS` | `180000` | Hidden-tab sessions are reaped sooner. |
| `RECONNECT_GRACE_MS` | `60000` | How long a disconnected context lingers — a window in which a leaked `sessionId` could still be resumed. |
| `MAX_UPLOAD` | `200mb` | Per-request upload cap. |
| `FILE_TTL_MS` | `300000` | Lifetime of bridged files. |
| `SCREENCAST_QUALITY` / `SCREENCAST_MAX_*` | `70` / `1280×800` | Frame size and quality — the main bandwidth lever. |

The per-IP controls bound the common case, but they are not a complete defence: a client can rotate
source addresses, and `MAX_SESSIONS` still caps the whole instance. `/ws` frames are capped at 64 MB
and uploads at `MAX_UPLOAD`, but there is no request-*rate* limit on the socket itself. If you run
this multi-tenant on a public network, add authentication, quotas and rate limiting at the proxy —
and set `RBAS_TRUST_PROXY` correctly or the per-IP limits will bucket everyone behind the proxy
together.

## Untested

These areas were **not** exercised in this repo's testing and must not be assumed safe:

- Deployment behind TLS or on a public URL (only local plain-HTTP containers were tested).
- The built-in limits under real load, or the target filter against a page that navigates itself
  via client-side routing and `history.pushState` (which is not a request and is not filtered).
- Concurrent load / multi-tenant behaviour; the e2e suite drives one session at a time.
- Fly.io deployment (`fly.toml` is configuration, not a verified deployment).
