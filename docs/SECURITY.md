# Security and limits

This service gives whoever can reach it a real browser on your network, driven on their behalf.
Read this before exposing `PORT` to an untrusted network.

## The service has no authentication

There is no login, API key, token or origin check anywhere in the request path. Anything that can
open a TCP connection to `PORT` can:

- open a session (`POST`-less: the first WebSocket message `init` is all it takes),
- drive that browser to any URL (`init.url`, or `navigate` at any time),
- fetch files that other users' downloads left behind **if** it can guess a download id,
- upload files up to `MAX_UPLOAD`.

Put it behind authentication you already trust — an authenticated reverse proxy, a VPN, a private
network, an identity-aware proxy, or a signed short-lived token in front of both `/ws` and the HTTP
routes. The SDK has no notion of credentials, so fronting it is the intended pattern.

## Server-side request forgery

The remote browser runs **inside your infrastructure**, so it can reach anything that network can
reach: internal admin panels, databases, `169.254.169.254` cloud metadata, `localhost` services.
Combined with the missing authentication that is a full SSRF primitive.

Mitigations, in rough order of strength:

- Never expose the service to the public internet without auth in front of it.
- Restrict the container's egress (network policy, egress proxy, or a private subnet) so the browser
  can only reach the applications you intend to embed.
- Keep the container away from sensitive networks and strip cloud metadata access
  (IMDSv2 + hop limit, or block `169.254.169.254`).

## Open CORS

Every HTTP route sets `Access-Control-Allow-Origin: *` (and answers `OPTIONS` with `204`) so the SDK
can be embedded from any origin. Consequences to be aware of:

- Any web page a user visits can `POST /upload` to your service and `GET /download/:id` (given the
  id), and can read `/healthz` and `/api/sessions`.
- `/api/sessions` discloses live session ids and the URLs they are showing. Session ids are random
  (`sess_` + 16 hex chars) but they are not secrets you should rely on.

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
| `IDLE_TIMEOUT_MS` | `600000` | Connected-but-idle sessions are reaped (a connected client that is doing nothing still costs a Chromium context). |
| `HIDDEN_TIMEOUT_MS` | `180000` | Hidden-tab sessions are reaped sooner. |
| `RECONNECT_GRACE_MS` | `60000` | How long a disconnected context lingers — a window in which a leaked `sessionId` could still be resumed. |
| `MAX_UPLOAD` | `200mb` | Per-request upload cap. |
| `FILE_TTL_MS` | `300000` | Lifetime of bridged files. |
| `SCREENCAST_QUALITY` / `SCREENCAST_MAX_*` | `70` / `1280×800` | Frame size and quality — the main bandwidth lever. |

Unbounded work is possible: anyone who can connect can hold `MAX_SESSIONS` sessions open in a loop,
pinning CPU and memory. There is no per-IP rate limit and no request-size limit on `/ws` beyond the
server's 64 MB frame cap. If you run this multi-tenant, add rate limiting and auth at the proxy.

## Untested

These areas were **not** exercised in this repo's testing and must not be assumed safe:

- Deployment behind TLS or on a public URL (only local plain-HTTP containers were tested).
- Any authentication or rate-limiting layer.
- Concurrent load / multi-tenant behaviour; the e2e suite drives one session at a time.
- Fly.io deployment (`fly.toml` is configuration, not a verified deployment).
