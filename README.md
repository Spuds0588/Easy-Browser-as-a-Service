**[▶ Live home page →](https://spuds0588.github.io/Easy-Browser-as-a-Service/)**

# Easy Browser-as-a-Service

Embed a real remote Chromium inside your own web app with one custom element. Use it when the
target application refuses to be framed (blocking `X-Frame-Options` / CSP), when its cookies and
`localStorage` collide with your own, or when you cannot reach it from the browser at all (CORS).

```html
<script src="https://browser.your-company.com/sdk.js?token=SHORT_LIVED_TOKEN"></script>
<remote-browser src="https://legacy-crm.internal" style="display:block;width:100%;height:700px"></remote-browser>
```

The `token` is a short-lived access token minted from your server's signing key — the service will
not open a browser for anyone without one. See [Access control](#access-control); `install.sh` and
the bundled demo page mint a token for you automatically.

The remote session is rendered as JPEG frames over a WebSocket and lives in an isolated
incognito browser context on the server. The server itself is **stateless**: session state
(cookies, `localStorage`, the session id and current URL) is persisted by the SDK in the *host
page's* `localStorage` and replayed on reconnect, so reloading your page resumes the same remote
session instead of logging the user out.

- [Quickstart](#quickstart)
- [`<remote-browser>` reference](#remote-browser-reference)
- [Access control](#access-control)
- [Configuration reference](#configuration-reference)
- [HTTP and WebSocket endpoints](#http-and-websocket-endpoints)
- [Session, Chrome and reaping model](#session-chrome-and-reaping-model)
- [Troubleshooting](#troubleshooting)
- [Deployment](docs/DEPLOY.md) · [Security and limits](docs/SECURITY.md)

## How it works

```
  host page (any origin)                     your server / container
  ┌────────────────────┐                    ┌──────────────────────────────────────────┐
  │ <remote-browser>   │  ws://…/ws         │ Express (HTTP) + ws (WebSocket)           │
  │  canvas + input    │ ─────────────────▶ │   ├─ SDK, /healthz, /upload, /download/:id│
  │  localStorage      │ ◀───────────────── │   └─ SessionManager (ids, resume, reaping)│
  │  state persistence │   frames, state    │        │ one IncognitoBrowserContext      │
  └────────────────────┘                    │        ▼ per session                     │
                                            │   master Chromium (one process, CDP)     │
                                            └──────────────────────────────────────────┘
```

One `puppeteer.launch()` runs for the life of the process. Each WebSocket connection gets its own
`IncognitoBrowserContext` and page inside that process, so isolation is per-user while memory and
CPU stay bounded by the number of sessions rather than browser processes. All browser control
goes through the Chrome DevTools Protocol (`Page.startScreencast`, `Input.dispatch*`,
`Network.*`, `DOM.setFileInputFiles`) — there is no WebRTC, no audio and no database.

## Quickstart

Requires Docker (recommended) or Node.js 18+ with a Chrome/Chromium on the machine.

```bash
git clone https://github.com/Spuds0588/Easy-Browser-as-a-Service.git
cd Easy-Browser-as-a-Service
./install.sh
```

`install.sh` uses Docker when the daemon is reachable, otherwise it installs dependencies and runs
on Node locally:

```
==> Building and starting with Docker Compose (host port 8080)
==> Waiting for health check…
==> Up: http://localhost:8080/demo.html
```

Verify the service and open the demo (it embeds `https://example.com` by default):

```bash
curl -s localhost:8080/healthz
# {"ok":true,"uptime":8,"sessions":{"active":0,"max":8},"browser":{"connected":true,"version":"Chrome/131.0.6778.204"},"tmp":"/tmp/rbas"}
```

Then open <http://localhost:8080/demo.html>. Type a URL in the header and press **Go**, or open
`<http://localhost:8080/demo.html?src=https://example.com>` to start somewhere specific; reload the
page and the session resumes where you left it.

Useful flags:

```bash
./install.sh --docker --port 9000   # force Docker, publish on host port 9000
./install.sh --local                # force bare-metal Node (runs in the foreground)
```

Embed it in your own page — the demo page itself (served at `/demo.html`) is the working example:

```html
<script src="http://localhost:8080/sdk.js"></script>
<remote-browser src="https://example.com" style="width:100%;height:640px"></remote-browser>
```

To run the end-to-end test suite (drives real browsers through the whole product):

```bash
npm test
```

## `<remote-browser>` reference

Load `/sdk.js` from the service and use the element. It is a vanilla Custom Element — no framework,
no build step, no dependencies. It fills its own box with a canvas, so **give it a height**;
the element's measured size becomes the remote viewport (clamped to 240–2560 px wide and
240–1600 px tall).

### Attributes

| Attribute | Default | Meaning |
| --- | --- | --- |
| `src` | — | URL to open in the remote session. Changing it after the session is ready navigates the remote browser. |
| `server` | origin the SDK script was loaded from | Origin of this service. Set it when the SDK is served from a different origin than your page. The element connects to `<server>/ws`. |
| `storage-key` | `rbas:session` | Host `localStorage` key holding `{sessionId, url, localStorage, cookies}`. Change it to run more than one session per host origin. |

### Properties and methods

| Member | Description |
| --- | --- |
| `element.navigate(url)` | Navigate the remote session and remember the URL for resume. |
| `element.reload()` | Re-navigate to the current `src` (or the remembered URL). |
| `element.status` | `{ ready, sessionId, url }` — `ready` is `true` once a session is attached. |
| `element.sessionId` | Current session id (`sess_…`), or `null`. |
| `element.lastClipboard` | Last text copied out of the remote page, as received by the host. |

### Events

All are `CustomEvent`s dispatched on the element.

| Event | `detail` | Fired when |
| --- | --- | --- |
| `ready` | `{ sessionId, url, resumed, navigated }` | A session is attached. `url` is the remote page's resolved URL. `resumed: true` means an existing remote session was re-attached after a reconnect/reload; `navigated: false` means the initial navigation failed (the overlay shows why). |
| `navigate` | `{ url }` | The remote page navigated — the initial load, link clicks, redirects and `window.open` targets all fire it. For a brand-new session it arrives **before** `ready`; the URL is normalised (`https://example.com` becomes `https://example.com/`). |
| `clipboard` | `{ text }` | The remote page copied text; the SDK also tries to write it to the host clipboard. |
| `download` | `{ url, filename }` | A remote download finished and was triggered on the host page. |
| `expired` | `{ reason }` | The server reaped the session (idle, hidden, or disconnect grace elapsed). |

Connection and server errors are not events: they are shown in the element's built-in overlay,
which offers a **Reload session** button. The element also logs `[SDK] …` lines to the console.

### Input, clipboard and files

- **Mouse** — clicks, movement, drag and wheel scroll are forwarded with coordinates scaled from
  the canvas to the remote viewport.
- **Keyboard** — keystrokes go to the focused remote element. The element's canvas takes focus on
  click. `Ctrl`/`Cmd` + `C`/`V`/`X` are intentionally left to the host so clipboard sync can work.
- **Clipboard** — text only, both directions. Host→remote paste is inserted into the focused remote
  element; remote→host copy fires the `clipboard` event and best-effort calls
  `navigator.clipboard.writeText` (which browsers may block without a user gesture or permission).
- **Uploads** — when the remote page opens a file picker the browser's native dialog is suppressed;
  the SDK opens a real file picker on the host, `POST`s the chosen file(s) to `/upload`, and hands
  the stored file to the waiting remote input. The remote page sees the original filename.
- **Downloads** — remote downloads are captured in the container, exposed briefly at
  `/download/:id`, and triggered on the host page as a normal download.

### Session resume

The SDK writes `{sessionId, url, localStorage, cookies}` to host `localStorage` and sends it back
on every connect. The server keeps a dropped session's browser context alive for
`RECONNECT_GRACE_MS` (default 60 s), so reloading or navigating the host page re-attaches the same
remote session. If the context is gone, the SDK silently starts a fresh session seeded with the
stored cookies and `localStorage`.

Notes: state is keyed by host `localStorage`, so a sandboxed/opaque origin (for example a
`srcdoc` iframe or `file://`) cannot persist a session. On resume the live context is authoritative —
the server pushes its state back to the host rather than replaying stale host state.

## Access control

The service ships with authentication built in. One long-lived **signing key** stays on the server
and browsers only ever receive short-lived **tokens** signed with it, so a token scraped out of a
page expires on its own and can never be replayed as the key. Verification is stateless — no token
store, no database — so it fits the rest of the design.

| Variable | Default | Meaning |
| --- | --- | --- |
| `RBAS_KEY` | generated at boot & logged | HMAC signing key for access tokens. Set it (`openssl rand -base64 32`) so tokens stay valid across restarts. |
| `RBAS_TOKEN_TTL_MS` | `3600000` (1 h) | Default token lifetime; `/api/token` and `server/token.js` can request a shorter one. |

If `RBAS_KEY` is unset the service generates one and prints it once at boot — handy for a quick
look, but every restart invalidates outstanding tokens. A token gates **establishing** a session;
once a socket is up it stays up, so a short TTL never kills a long-running session.

Mint a token one of three ways:

1. **Ask the service** — no crypto on your side:
   ```bash
   curl -sX POST -H "Authorization: Bearer $RBAS_KEY" \
     "https://your-server/api/token?ttl=15m&sub=alice"
   # {"token":"v1.…","expiresAt":1699999999999}
   ```
2. **From the CLI** — `RBAS_KEY=… node server/token.js --ttl 15m --sub alice`
3. **In your own backend** — sign `v1.<base64url({iat,exp,sub})>` with HMAC-SHA256 under the same key.

Because tokens are short-lived, mint one as the page loads rather than baking it into static HTML:

```html
<script>
  fetch('https://your-backend/rbas-token').then((r) => r.json()).then(({ token }) => {
    const s = document.createElement('script');
    s.src = `https://your-server/sdk.js?token=${encodeURIComponent(token)}`;
    document.head.append(s);
  });
</script>
<remote-browser src="https://legacy-crm.internal" style="height:700px"></remote-browser>
```

The SDK reads `?token=` off its own `<script>` URL and carries it into the WebSocket `init`, the
upload request and the download link. What is guarded, and what is deliberately not:

| Route | Token required | Why |
| --- | --- | --- |
| `GET /sdk.js`, `GET /demo.html`, `GET /healthz` | no | Assets and the container probe must load before any session exists; `/demo.html` gets a working token injected for you. |
| `POST /api/token` | the **master key** | Server-to-server exchange: master key in, short-lived token out. |
| `WS /ws` | yes — in the first `init` message | A browser WebSocket cannot send headers, and `init` is already the first frame. |
| `GET /api/sessions`, `POST /upload`, `GET /download/:id` | yes | `Authorization: Bearer …`, or `?token=…` on a download link (a click navigation cannot set headers). |

Unauthorized requests get a `401` (or a `1008` WebSocket close) and never allocate a browser context.
See [docs/SECURITY.md](docs/SECURITY.md) for what this does and does not protect against.

## Configuration reference

Everything is environment variables with the defaults below; the Docker image, `docker-compose.yml`
and `fly.toml` set the ones that matter for deployment.

### Server

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | HTTP/WebSocket listen port. |
| `HOST` | `0.0.0.0` | Listen address. |
| `RBAS_TMP_DIR` | `<os tmpdir>/rbas` | Root for the upload/download bridge (inside the container: `/tmp/rbas`). |
| `MAX_UPLOAD` | `200mb` | Maximum size of a single uploaded file. |
| `FILE_TTL_MS` | `300000` (5 min) | How long an uploaded/downloaded file is kept before deletion (swept every `max(30s, ttl/2)`). |

### Sessions and reaping

| Variable | Default | Meaning |
| --- | --- | --- |
| `MAX_SESSIONS` | `8` | Concurrent sessions per instance. Further `init`s are rejected with an error until one is reaped. |
| `RECONNECT_GRACE_MS` | `60000` | How long a dropped session's browser context is kept for a reconnect. |
| `IDLE_TIMEOUT_MS` | `600000` (10 min) | No input for this long on a **connected** session and it is reaped. |
| `HIDDEN_TIMEOUT_MS` | `180000` (3 min) | Same, but while the embedding tab reports itself hidden via the visibility API. |
| `SWEEP_MS` | `15000` | How often the idle sweep runs. |

### Screencast

| Variable | Default | Meaning |
| --- | --- | --- |
| `SCREENCAST_QUALITY` | `70` | JPEG quality of streamed frames. |
| `SCREENCAST_MAX_WIDTH` | `1280` | Upper bound for the default/fallback frame width. |
| `SCREENCAST_MAX_HEIGHT` | `800` | Upper bound for the default/fallback frame height. |
| `STORAGE_POLL_MS` | `5000` | How often remote cookies are snapshotted and pushed to the SDK. |
| `DOWNLOAD_POLL_MS` | `400` | How often the download directory is polled. |
| `NAV_TIMEOUT_MS` | `45000` | Navigation timeout before a navigation failure is reported to the SDK. |

### Browser launch

| Variable | Default | Meaning |
| --- | --- | --- |
| `PUPPETEER_EXECUTABLE_PATH` | auto-detected | Chrome/Chromium binary. Checked first, then `CHROME_PATH`, then common system paths, then the puppeteer cache (see below). |
| `CHROME_PATH` | — | Second-choice browser path. |
| `PUPPETEER_ARGS` | — | Extra Chromium flags, space separated, appended to the built-in `--no-sandbox --disable-dev-shm-usage …` set. |
| `PUPPETEER_HEADLESS` | `true` | Set to `false` to run headed (debugging only). |
| `CDP_TIMEOUT_MS` | `180000` | CDP protocol timeout. |

Browser discovery order: `PUPPETEER_EXECUTABLE_PATH` → `CHROME_PATH` → `/usr/bin/google-chrome`,
`google-chrome-stable`, `chromium`, `chromium-browser`, the macOS app bundle → the newest Chrome in
`$PUPPETEER_CACHE_DIR`, `$PUPPETEER_CACHE`, `$HOME/.cache/puppeteer` or
`/home/pptruser/.cache/puppeteer`. The chosen binary is logged at boot as
`[BOOT] master browser launched … chrome=<path>`.

## HTTP and WebSocket endpoints

All HTTP responses carry `Access-Control-Allow-Origin: *` so the SDK works from any embedding origin;
`OPTIONS` is answered with `204`.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/token` | Exchange the master key (`Authorization: Bearer $RBAS_KEY`) for a short-lived access token. Guarded by the key, not a token. |
| `GET` | `/healthz` | Liveness/readiness probe: `{ok, uptime, sessions:{active,max}, browser:{connected,version}, tmp}`. Also used by the image's `HEALTHCHECK`. |
| `GET` | `/api/sessions` | Debug/ops view of live sessions: `{active, max, items:[{id,url,visible,idleMs}]}`. |
| `POST` | `/upload?name=<filename>` | Raw request body is stored in the container's tmp dir; returns `{id, filename, bytes}`. Used by the SDK's upload bridge. |
| `GET` | `/download/:id` | Serves a captured remote download as an attachment until `FILE_TTL_MS` elapses, then `404`. |
| `GET` | `/sdk.js` | The web component. Serve this to embedding pages. |
| `GET` | `/demo.html` | Bundled demo harness. |
| `GET` | `/` | `302` redirect to `/demo.html`. |
| `GET` | `/ws` (WebSocket) | Session channel — this is the upgrade endpoint the SDK opens. |

### WebSocket message protocol

The SDK is the reference client; this is the wire contract if you write your own. Client→server:
`init` (`{url, sessionId, viewport, state, config}`), `navigate`, `mouse`, `wheel`, `key`,
`clipboard`, `paste`, `resize`, `visibility`, `upload:result`, `ping`. Server→client: `ready`,
`frame`, `url`, `state`, `clipboard`, `upload:request`, `download`, `error`, `expired`, `pong`.
The **first** message on a socket must be `init`.

## Session, Chrome and reaping model

1. **Boot** — one master Chromium is launched (`[BOOT] master browser launched …`). If it
   disconnects unexpectedly the server relaunches it; sessions on the dead process are gone and
   their clients start fresh sessions seeded from host state.
2. **Connect** — the first `init` either resumes a live session by id or creates a new
   `IncognitoBrowserContext` + page: download behaviour is scoped to that context, cookies from the
   client are injected, `localStorage` is seeded once per context, and a CDP screencast starts.
3. **Run** — frames stream to the canvas (each frame is acked), input flows back, cookies are
   polled every `STORAGE_POLL_MS`, and `localStorage` writes in the remote page are streamed to the
   host through an injected hook.
4. **Hidden** — when the embedding tab goes hidden the screencast stops; a reconnect re-arms it.
   Hidden sessions are reaped after `HIDDEN_TIMEOUT_MS`.
5. **Disconnect** — the browser context is kept for `RECONNECT_GRACE_MS`; reconnecting with the same
   `sessionId` re-attaches it (`ready.resumed === true`).
6. **Reap** — idle (`IDLE_TIMEOUT_MS`), hidden (`HIDDEN_TIMEOUT_MS`) or expired grace closes the
   context, frees its downloads and sends `expired` before closing the socket. The client clears the
   stored `sessionId`, so the next connect starts a new session.

Uploads and downloads are transient too: files live in the container's tmp root for `FILE_TTL_MS`
and are then deleted. Nothing is written to disk permanently and there is no database.

## Troubleshooting

**The element is blank or zero-height.** `<remote-browser>` is `display:block` but has no intrinsic
size; give it a height (the demo uses flexbox). The element's measured size becomes the remote
viewport, so a zero-height element streams nothing.

**`net::ERR_NAME_NOT_RESOLVED`.** The *container's* Chrome could not resolve the URL in `src` — a
host-only name that the container cannot see. The server logs
`[SESSION …] navigation issue: net::ERR_NAME_NOT_RESOLVED at <url>`, the SDK overlay shows
`Navigation problem: net::ERR_NAME_NOT_RESOLVED at <url>` (with a **Reload session** button), and
`ready.navigated` is `false`. Inside Docker, point at the host with
`http://host.docker.internal:<port>` (compose already adds the `host-gateway` alias) or publish the
target on the network the container uses. When the first navigation fails, no screencast is started
until you navigate somewhere reachable.

**`Screencast failed` / frames stop after a while.** Check the container is still up and the
session has not been reaped: `curl -s localhost:8080/api/sessions`. Reaping is normal for idle
sessions — raise `IDLE_TIMEOUT_MS` if you want longer-lived sessions.

**Session rejected with `capacity reached (N/N)`.** `MAX_SESSIONS` is in use. Raise it (each session
costs a chunk of one Chrome's memory) or shorten the timeouts so zombies free up sooner.

**No browser binary.** The boot log prints the resolved path. Set `PUPPETEER_EXECUTABLE_PATH` to
override it. `install.sh --local` uses a system Chrome when it finds one and otherwise lets
puppeteer download its own build; if you installed dependencies by hand with
`PUPPETEER_SKIP_DOWNLOAD=1` and have no system Chrome, there is nothing to launch.

**Uploads or downloads never arrive.** Files are written inside the container under
`RBAS_TMP_DIR` — that path must be writable by the container user (the image runs as `pptruser` and
`/tmp` is world-writable). Host browsers can also block automatic downloads; the `download` event
still fires on the element so you can show your own prompt. Files expire after `FILE_TTL_MS`.

**Healthcheck failing.** It requests `/healthz` on `PORT`. If you changed `PORT` for the local case,
pass the matching host port to `install.sh --port` (compose publishes `${PORT:-8080}:8080`).

**Nothing appears after a host-page reload.** Confirm the host origin can use `localStorage` (an
opaque origin cannot persist a session) and that the reload happened within `RECONNECT_GRACE_MS`.

## Testing

`npm run test:auth` runs `test/auth.js`: an in-process matrix over the token signer (accept,
tamper, expiry, wrong key, master-key check) plus an integration pass against a running server —
the HTTP guards, the `/api/token` exchange, the demo-token injection and the WebSocket `init` gate.

`npm test` runs `test/e2e.js`: it starts the service and two fixture origins, launches a real
browser, and drives the product end to end — screencast frames painted to the canvas, mouse and
keyboard passthrough, clipboard both ways, the upload and download bridges, deep-link resume,
disconnect-grace reaping and idle expiry (16 checks; `test/idle-probe.js` probes the last one
standalone). The same suite can target an already-running deployment:

```bash
E2E_SERVICE_ORIGIN=http://localhost:8130 \
E2E_TARGET_ORIGIN=http://host.docker.internal:8091 \
E2E_BIND=0.0.0.0 E2E_SKIP_IDLE=1 node test/e2e.js
```

`E2E_SERVICE_ORIGIN` attaches to a deployment instead of spawning one (fixture apps still run
locally, so the remote browser must be able to reach `E2E_TARGET_ORIGIN`). `E2E_SKIP_IDLE=1` skips
the idle-expiry check, which needs a service started with a short `IDLE_TIMEOUT_MS` — probe that
separately with `node test/idle-probe.js <port>`. The disconnect-grace check waits
`E2E_GRACE_WAIT_MS` (20 s for a self-spawned service, 90 s when attaching to a deployment that uses
the default 60 s grace) before giving up.

`npm run test:multi` runs `test/multi-session.js`, which is about isolation rather than features:
it starts the service with `MAX_SESSIONS=3` and drives two, then three, host pages at once, each on
a different tenant target. It asserts distinct session ids, per-session frames (each tenant has its
own palette), per-session keyboard routing, localStorage and cookie isolation, clipboard and
upload/download payloads that never cross a session boundary, that a third session does not disturb
an existing screencast, that a `MAX_SESSIONS+1` connection is refused with the documented capacity
error, and that closing a session frees a slot for a replacement. Point it at a deployment with
`E2E_SERVICE_ORIGIN` / `E2E_TARGET_ORIGIN` / `E2E_BIND=0.0.0.0` just like the e2e suite.

It needs a browser to drive (system Chrome by default, or `PUPPETEER_EXECUTABLE_PATH`).
