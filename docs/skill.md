---
name: easy-browser-as-a-service
description: Embed a real remote Chromium inside a web app with one custom element — for apps that block iframes (X-Frame-Options/CSP), collide on cookies or localStorage, or are unreachable from the browser (CORS). Use when asked to embed, screen-scrape, automate or drive a web app that refuses to be framed.
license: MIT
metadata:
  homepage: https://spuds0588.github.io/Easy-Browser-as-a-Service/
  repository: https://github.com/Spuds0588/Easy-Browser-as-a-Service
  component: <remote-browser>
  runtime: Docker or Node 18+ with Chrome/Chromium
---

# Easy Browser-as-a-Service

Run a real Chromium in a container and stream it into any page as a `<remote-browser>` element.
The remote page is rendered as JPEG frames over a WebSocket; input flows back over the same socket.
Use this instead of an `<iframe>` when the target app refuses to be framed, when its cookies or
`localStorage` would collide with your own origin, or when the browser cannot reach it at all.

The server is **stateless**: session state (session id, URL, cookies, `localStorage`) is persisted by
the SDK in the *host page's* `localStorage` and replayed on reconnect, so reloading your page resumes
the same remote session instead of logging the user out. There is no database and no volume.

## When to use it

- The target site sends `X-Frame-Options: DENY` / `frame-ancestors`, so `<iframe>` is out.
- The target's cookies or `localStorage` clash with the embedding origin.
- The target is reachable from the server but not from the user's browser (CORS, private network).
- You need to drive a real browser (clicks, typing, uploads, downloads) from your own UI.

Do **not** use it for audio or video calls: frames carry no sound, and streaming is deliberately
WebSocket-based rather than WebRTC (WebRTC needs STUN/TURN to deploy).

## Quickstart

```bash
git clone https://github.com/Spuds0588/Easy-Browser-as-a-Service.git
cd Easy-Browser-as-a-Service
./install.sh          # Docker when available, else bare-metal Node
```

Verify, then embed:

```bash
curl -s localhost:8080/healthz
# {"ok":true,"uptime":8,"sessions":{"active":0,"max":8},"browser":{"connected":true,"version":"Chrome/131.0.6778.204"},"tmp":"/tmp/rbas"}
```

```html
<!-- Token first: without one the service refuses to open a session. The demo
     page at /demo.html has one injected for you. -->
<script src="http://localhost:8080/sdk.js?token=SHORT_LIVED_TOKEN"></script>
<remote-browser
  src="https://legacy-crm.internal"
  server="http://localhost:8080"
  style="display:block;width:100%;height:700px"
></remote-browser>
```

The element has no intrinsic size — **always give it a height**. Its measured size becomes the remote
viewport (clamped to 240–2560 px wide and 240–1600 px tall). A zero-height element streams nothing.

## The `<remote-browser>` element

Vanilla Custom Element with Shadow DOM, no framework and no build step.

### Attributes

| Attribute | Default | Meaning |
| --- | --- | --- |
| `src` | — | URL to open. Changing it after `ready` navigates the remote browser. |
| `server` | origin the SDK was loaded from | Service origin. Connects to `<server>/ws`. |
| `storage-key` | `rbas:session` | Host `localStorage` key holding `{sessionId, url, localStorage, cookies}`. Use a distinct key per session on one host origin. |

The access token is **not** an attribute: append it to the SDK's own script URL
(`<script src="…/sdk.js?token=…">`) and the element picks it up. Mint tokens from the server's
signing key — `curl -X POST -H "Authorization: Bearer $RBAS_KEY" '<origin>/api/token?ttl=15m'`,
`node server/token.js --ttl 15m`, or HMAC-SHA256 in your own backend.

### Methods and properties

| Member | Description |
| --- | --- |
| `el.navigate(url)` | Navigate the remote session and remember the URL for resume. |
| `el.reload()` | Re-navigate to the current `src`, or the remembered URL. |
| `el.endSession(reason?)` | End the remote session now — sends `close`, clears the remembered session id, stops reconnecting, fires `ended`. Returns whether a session was attached. |
| `el.status` | `{ ready, sessionId, url }`. |
| `el.sessionId` | `sess_…` or `null`. |
| `el.lastClipboard` | Last text copied out of the remote page. |

### Events (all `CustomEvent` on the element)

| Event | `detail` | Fires when |
| --- | --- | --- |
| `ready` | `{ sessionId, url, resumed, navigated }` | A session is attached. `resumed: true` = an existing session was re-attached; `navigated: false` = the initial navigation failed (the overlay explains why). |
| `navigate` | `{ url }` | The remote page navigated (initial load, link click, redirect, `window.open`). Arrives **before** `ready` on a fresh session. |
| `clipboard` | `{ text }` | The remote page copied text. |
| `download` | `{ url, filename }` | A remote download finished and was triggered on the host page. |
| `expired` | `{ reason }` | The server reaped the session (idle, hidden or disconnect grace). |
| `ended` | `{ reason }` | The session was closed on purpose — `endSession()`, or the server at your request. No reconnect follows. |

Connection and server errors are shown in the element's built-in overlay (with a **Reload session**
button), not as events. The element logs `[SDK] …` lines to the console.

## Behaviour worth knowing before you build on it

- **Input** — mouse clicks, movement, drag and wheel are forwarded with coordinates scaled to the
  remote viewport; keyboard goes to the focused remote element.
- **Clipboard is text-only, and `Ctrl`/`Cmd` + `C`/`V`/`X` are reserved for the *host*** so host
  clipboard sync can work. A user therefore cannot press Ctrl+C inside the remote page: remote → host
  copy fires only when the remote page itself raises a copy event (an in-page copy button). Sites whose
  copy buttons use `navigator.clipboard.writeText()` do not reach the host.
- **Enter works normally** — it submits forms and inserts newlines in textareas, like a real browser.
- **Uploads** — the remote file picker is suppressed; the host's picker opens, the file is `POST`ed to
  `/upload`, and the stored file is handed to the waiting remote input under its original filename.
- **Downloads** — captured in the container, exposed briefly at `/download/:id`, then triggered on the
  host page as a normal download.
- **Authentication is built in.** A session needs a short-lived HMAC token signed with `RBAS_KEY`;
  the WebSocket `init` and the sensitive HTTP routes reject anything else. A token is checked when the
  session is *established*, not continuously, and it authorizes the caller — not a person. See
  `docs/SECURITY.md`.
- **Teardown is on demand too.** `el.endSession()` (or the `close` message, or
  `DELETE /api/sessions/:id`) ends a session immediately instead of waiting out the reconnect grace,
  the idle timeout, or the hidden-tab timeout.

## HTTP and WebSocket endpoints

All HTTP responses send `Access-Control-Allow-Origin: *`; `OPTIONS` returns `204`.

| Method | Path | Token | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/token?ttl=&sub=` | master key, or trusted origin+network | Mint `{token, expiresAt}`. Either present `Authorization: Bearer $RBAS_KEY`, or call it from an origin in `RBAS_TRUSTED_ORIGINS` (a no-backend page minting for itself) |
| `GET` | `/healthz` | open | `{ok, uptime, sessions:{active,max}, browser:{connected,version}, tmp}` |
| `GET` | `/api/sessions` | required | `{active, max, items:[{id,url,visible,idleMs}]}` |
| `DELETE` | `/api/sessions/:id` | required | End one session immediately, skipping the reconnect grace; `404` if it is gone |
| `POST` | `/upload?name=<filename>` | required | Raw body stored in tmp; returns `{id, filename, bytes}` |
| `GET` | `/download/:id` | required (`?token=`) | Captured download as an attachment, until `FILE_TTL_MS` |
| `GET` | `/sdk.js` | open | The web component |
| `GET` | `/demo.html` | open (token injected) | Working demo harness (accepts `?src=`) |
| `GET` | `/` | open | `302` → `/demo.html` |
| `GET` | `/ws` | required in `init` | WebSocket session channel (must survive proxy upgrades) |

Wire protocol if you write your own client — the **first** message on a socket must be `init`.
Client→server: `init {token, url, sessionId, viewport, state, config}`, `navigate`, `mouse`, `wheel`, `key`,
`clipboard`, `paste`, `resize`, `visibility`, `upload:result`, `ping`, `close {reason?}` (end now, no grace).
Server→client: `ready`, `frame`, `url`, `state`, `clipboard`, `upload:request`, `download`, `error`,
`expired`, `closed`, `pong`.

## Configuration (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | HTTP/WebSocket port |
| `HOST` | `0.0.0.0` | Listen address |
| `RBAS_KEY` | generated at boot & logged | HMAC signing key for access tokens; set it for stable tokens |
| `RBAS_TOKEN_TTL_MS` | `3600000` | Default token lifetime |
| `RBAS_TRUSTED_ORIGINS` | — | Origins that may mint a token for themselves (no-backend pages) |
| `RBAS_TRUSTED_NETWORKS` | — | IPs/CIDRs those origins must connect from; without it `Origin` alone is forgeable |
| `RBAS_BROWSER_TOKEN_TTL_MS` | `900000` | Ceiling on trusted-origin tokens |
| `RBAS_TRUST_PROXY` | `0` | Trusted proxy hops, for the IP allow-list behind a proxy |
| `MAX_SESSIONS` | `8` | Concurrent sessions; further `init`s are refused |
| `RECONNECT_GRACE_MS` | `60000` | How long a dropped session's context is kept for resume |
| `IDLE_TIMEOUT_MS` | `600000` | No input on a connected session → reaped |
| `HIDDEN_TIMEOUT_MS` | `180000` | Same, while the embedding tab is hidden |
| `SWEEP_MS` | `15000` | Idle sweep interval |
| `SCREENCAST_QUALITY` | `70` | JPEG quality of frames |
| `SCREENCAST_MAX_WIDTH` / `_HEIGHT` | `1280` / `800` | Default frame bounds |
| `STORAGE_POLL_MS` | `5000` | Cookie snapshot interval |
| `DOWNLOAD_POLL_MS` | `400` | Download directory poll interval |
| `NAV_TIMEOUT_MS` | `45000` | Navigation timeout |
| `MAX_UPLOAD` | `200mb` | Max single upload |
| `FILE_TTL_MS` | `300000` | Lifetime of bridged upload/download files |
| `PUPPETEER_EXECUTABLE_PATH` | auto-detected | Chrome/Chromium binary |
| `PUPPETEER_ARGS` | — | Extra Chromium flags, space separated |
| `PUPPETEER_HEADLESS` | `true` | `false` runs headed (debugging only) |
| `RBAS_TMP_DIR` | `<tmpdir>/rbas` | Root for the upload/download bridge |

Sizing: budget roughly **1 GB of memory per concurrent session**. `--shm-size=1gb` (512 MB minimum)
is required or Chromium renderers crash.

## Session lifecycle

1. **Boot** — one master Chromium per process.
2. **Connect** — the first `init` resumes a live session by id, or creates an
   `IncognitoBrowserContext` + page, scopes download behaviour to it, injects cookies, seeds
   `localStorage` once, and starts a screencast.
3. **Run** — frames out, input in, cookies polled, remote `localStorage` writes streamed to the host.
4. **Hidden** — the embedding tab going hidden stops the screencast; reconnects re-arm it.
5. **Disconnect** — the context survives `RECONNECT_GRACE_MS`; reconnecting with the same
   `sessionId` re-attaches it (`ready.resumed === true`).
6. **Reap** — idle, hidden or expired grace closes the context, frees its downloads, sends `expired`.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Element blank or zero-height | It has no intrinsic size — set a height. |
| `net::ERR_NAME_NOT_RESOLVED` | The *container's* Chrome cannot resolve the `src` URL. Inside Docker use `http://host.docker.internal:<port>`. |
| `capacity reached (N/N)` | `MAX_SESSIONS` in use; raise it or shorten the timeouts. |
| No browser binary | Boot log prints the resolved Chrome path; override with `PUPPETEER_EXECUTABLE_PATH`. |
| Frames stop after a while | Session was reaped — check `/api/sessions`, raise `IDLE_TIMEOUT_MS`. |
| Nothing after a host reload | The host origin cannot use `localStorage` (opaque origin), or the reload exceeded `RECONNECT_GRACE_MS`. |
| Uploads/downloads never arrive | `RBAS_TMP_DIR` must be writable; files expire after `FILE_TTL_MS`. |

## Verifying a deployment

```bash
curl -s localhost:8080/healthz          # liveness + Chrome version
curl -s localhost:8080/api/sessions     # who is connected, and for how long
```

Test suites (need a browser to drive; system Chrome by default):

```bash
npm test              # 16 checks: frames, input, clipboard, upload/download, resume, reaping
npm run test:multi    # 23 checks: cross-session isolation, capacity, churn
npm run test:live     # drives real external sites through the product
npm run test:probe    # browser identity, codecs, fonts, and which real sites block it
```

The full reference — every variable, the lifecycle, and troubleshooting — is in
[README.md](https://github.com/Spuds0588/Easy-Browser-as-a-Service/blob/main/README.md).
