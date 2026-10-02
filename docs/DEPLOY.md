# Deployment guide

The whole product is one stateless container that listens on `PORT` (default `8080`) and serves both
HTTP and WebSocket traffic. There is nothing to provision: no database, no volume, no cache.

- [What the container needs](#what-the-container-needs)
- [Docker](#docker)
- [Docker Compose (and `install.sh --docker`)](#docker-compose-and-installsh---docker)
- [Generic container hosts](#generic-container-hosts)
- [Fly.io](#flyio)
- [Bare metal with Node](#bare-metal-with-node)
- [TLS and reverse proxies](#tls-and-reverse-proxies)
- [Sizing, limits and scaling](#sizing-limits-and-scaling)

## What the container needs

| Requirement | Why |
| --- | --- |
| TCP port `8080` (or your `PORT`) exposed | HTTP + the `/ws` WebSocket upgrade. |
| **WebSocket upgrade pass-through** | The entire session runs over `/ws`. A proxy that buffers or strips upgrades breaks it. |
| Shared memory: `--shm-size=1gb` (512 MB minimum) | Chromium's renderers crash with the default 64 MB `/dev/shm`. |
| Writable tmp (`/tmp`) | The upload/download bridge writes under `RBAS_TMP_DIR` (`/tmp/rbas`). |
| Healthcheck `GET /healthz` | Liveness/readiness; the image already declares `HEALTHCHECK`. `/healthz` is left unauthenticated for exactly this reason. |
| An `RBAS_KEY` secret | Signs the access tokens every session needs. Unset, the service generates one at boot and logs it (tokens then die with the process). Store it as a real secret. |
| `RBAS_TRUSTED_ORIGINS` + `RBAS_TRUSTED_NETWORKS` (optional) | Only if you embed from a page that has no backend: they let that origin mint a token for itself. The network half is what constrains a non-browser client. Must be paired with `RBAS_TRUST_PROXY` when a proxy sits in front. |
| ~1 GB RAM per running session, plus Chrome's own footprint | Each session is an incognito context inside one master Chromium. |
| No persistent volume | Sessions and tmp files are ephemeral by design. |

The image already bundles Chromium and its shared libraries (it is built on
`ghcr.io/puppeteer/puppeteer:23.11.1`, pinned to match the `puppeteer` version in
`package-lock.json`) and runs as the non-root user `pptruser`.

## Docker

```bash
docker build -t easy-browser-as-a-service .
docker run -d --name rbas \
  -p 8080:8080 \
  --shm-size=1gb \
  -e MAX_SESSIONS=8 \
  -e RBAS_KEY="$(openssl rand -base64 32)" \
  easy-browser-as-a-service
```

Check it:

```bash
docker logs rbas                 # [BOOT] master browser launched … chrome=/home/pptruser/.cache/…
curl -s localhost:8080/healthz
curl -s -o /dev/null -w '%{http_code}\n' localhost:8080/sdk.js   # 200
```

Then mint an access token from the same key and hand it to the page (see the README's
[Access control](https://github.com/Spuds0588/Easy-Browser-as-a-Service/blob/main/README.md#access-control)
section for the full picture):

```bash
RBAS_KEY=<the key you passed above> node server/token.js --ttl 15m
# or, without a local checkout, server-to-server:
curl -sX POST -H "Authorization: Bearer $RBAS_KEY" "http://localhost:8080/api/token?ttl=15m"
```

To let the remote browser reach a service running on the Docker *host* (handy when you are testing
against a local app), add the host alias and use it in `src`:

```bash
docker run -d --name rbas -p 8080:8080 --shm-size=1gb \
  --add-host=host.docker.internal:host-gateway \
  easy-browser-as-a-service
# then embed src="http://host.docker.internal:3000" — the container resolves it
```

Without that alias the container cannot resolve `host.docker.internal` and the session will log
`navigation issue: net::ERR_NAME_NOT_RESOLVED`.

## Docker Compose (and `install.sh --docker`)

Compose is the one-liner path; `install.sh` uses it automatically when the Docker daemon is up.

```bash
./install.sh --docker --port 8080
# …or equivalently:
PORT=8080 docker compose up -d --build
docker compose ps
docker compose logs -f
docker compose down
```

`docker-compose.yml` publishes `${PORT:-8080}:8080`, so `PORT=9000 docker compose up -d` serves on
host port 9000 while the container keeps listening on 8080. It sets `shm_size: 1gb`,
`extra_hosts: host.docker.internal:host-gateway`, `restart: unless-stopped` and the deployment
defaults for `MAX_SESSIONS`, the timeouts and the screencast size.

Pass `RBAS_KEY` to compose and `install.sh` will generate one for you if you do not:

```bash
RBAS_KEY=$(openssl rand -base64 32) docker compose up -d --build
```

The key signs access tokens — keep it out of `docker-compose.yml` itself and out of source control.

Wait for the health check before pointing users at it:

```bash
for _ in $(seq 1 30); do curl -fsS localhost:8080/healthz && break; sleep 2; done
```

## Generic container hosts

Any host that can run a Docker image works — Kubernetes, ECS, Cloud Run, Railway, a plain VM with
containerd. The contract is the table in [What the container needs](#what-the-container-needs):
expose one port, keep WebSocket upgrades intact, give `/dev/shm` at least 512 MB, leave `/tmp`
writable, and probe `/healthz`.

- **Port**: set `PORT` if the platform injects its own (Heroku/Railway/Cloud Run style); otherwise
  map the platform port to `8080`.
- **WebSocket**: the service speaks `ws://<host>/ws`. If your platform terminates TLS, the SDK
  upgrades to `wss://` automatically because it derives the scheme from its `server` origin.
- **Scale to zero**: safe, with a caveat. On wake-up the container has no master Chromium until it
  boots, then serves fresh sessions; clients seeded from host `localStorage` reconnect transparently
  with a new session.
- **Multiple replicas**: sessions are pinned to the instance that created them. A client that
  reconnects to a *different* replica cannot resume its context and starts a fresh session seeded
  from host state (cookies + `localStorage`), so it usually still appears logged in. If you need
  true resume across replicas, enable sticky sessions on `/ws`.
- **Memory**: plan for roughly `MAX_SESSIONS` × session cost plus one Chromium. Setting
  `MAX_SESSIONS` above what the box can hold is the fastest way to get killed sessions; the setting
  only guards concurrency, it does not reserve memory.
- **Timeouts**: keep the platform's idle/request timeouts above `IDLE_TIMEOUT_MS`, and remember that
  a hidden tab is reaped after `HIDDEN_TIMEOUT_MS`.

## Fly.io

`fly.toml` is checked in for this service (`internal_port = 8080`, `force_https = true`,
`auto_stop_machines = "suspend"`, `min_machines_running = 0`, a 2 GB `shared-cpu-2x` machine and
`MAX_SESSIONS = 4` to fit one Chromium in that memory).

```bash
fly launch --copy-config --no-deploy     # claims the app name, keeps the checked-in config
fly deploy
fly open /healthz
fly logs
```

Fly terminates TLS and supports WebSockets on `http_service`, so the SDK reaches it as
`https://<app>.fly.dev` with `wss://` upgrades. Scale-to-zero (`auto_stop_machines`) means the first
request after idling pays the Chromium boot cost; raise `min_machines_running` if that matters.

> **Untested.** This deployment path was never executed — it needs a Fly.io account and API token.
> The `fly.toml` above is a configuration, not a verified deployment. Treat it as a starting point
> and confirm `fly logs` shows `[BOOT] master browser launched` before trusting it.

## Bare metal with Node

```bash
./install.sh --local            # finds a system Chrome, npm ci, then `npm start` (foreground)
PORT=9000 ./install.sh --local
```

`install.sh --local` prefers a Chrome it can find (`google-chrome`, `google-chrome-stable`,
`chromium`, `chromium-browser`, or the macOS app bundle) and sets `PUPPETEER_EXECUTABLE_PATH` for
you; if it finds none it lets puppeteer download its own build during install. To run it yourself:

```bash
npm ci --omit=dev
PORT=8080 npm start
```

The process logs the port it bound and the browser it resolved:

```
[BOOT] master browser launched pid=19 version=Chrome/131.0.6778.204 chrome=/usr/bin/google-chrome
[BOOT] Easy Browser-as-a-Service listening on http://localhost:8080 (bind 0.0.0.0)
```

`SIGTERM`/`SIGINT` shut down cleanly: sessions and the master browser are closed and the process
exits `0`, so a supervisor (systemd, Docker) can restart it without orphans.

## TLS and reverse proxies

Terminate TLS in front of the service (Fly, Caddy, nginx, an ALB). Two things must be preserved:

1. **Upgrade headers** on `/ws` (`Connection`/`Upgrade`), and long proxy read timeouts — sessions
   are long-lived single connections.
2. **`/upload` needs a large `client_max_body_size`** if you upload large files (the app's own cap is
   `MAX_UPLOAD`, 200 MB).

The SDK builds its WebSocket URL from the `server` origin by replacing the scheme
(`http→ws`, `https→wss`), so a page served over HTTPS talking to an HTTPS service needs no extra
configuration.

If you use `RBAS_TRUSTED_NETWORKS`, set **`RBAS_TRUST_PROXY`** to the exact number of proxy hops you
control. Without it every request looks like it came from the proxy; set too high and a client can
spoof `X-Forwarded-For` and appear to be on a trusted network, which defeats the check entirely.

Access control is built in — sessions need a short-lived token signed with `RBAS_KEY`
— but a token is not a substitute for a network boundary: see [SECURITY.md](SECURITY.md) before
exposing it to the internet, and read the README's Access control section for minting.

> **Untested.** TLS termination and public-URL access were never exercised in this repo's testing;
> only plain-HTTP local container access was verified.

## Sizing, limits and scaling

| Symptom | Knob |
| --- | --- |
| `capacity reached (N/N)` in the SDK overlay | Raise `MAX_SESSIONS` (and the container's memory) or shorten the timeouts. |
| Sessions reaped while users are reading | Raise `IDLE_TIMEOUT_MS` / `HIDDEN_TIMEOUT_MS`. |
| Reloads stop resuming | Raise `RECONNECT_GRACE_MS` (default 60 s) or enable sticky sessions. |
| Bandwidth/cost too high | Lower `SCREENCAST_QUALITY`, or `SCREENCAST_MAX_WIDTH`/`HEIGHT` (the element's size sets the real frame size). |
| Chromium OOM-killed | Raise `--shm-size` to 1 GB and give the container more memory. |

Because the backend is stateless, horizontal scaling is just "run more of them" plus the session
affinity caveat above.
