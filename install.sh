#!/usr/bin/env bash
# Easy Browser-as-a-Service — one-command install.
#
#   ./install.sh              # Docker if available, else local Node
#   ./install.sh --docker     # force Docker (docker compose up -d --build)
#   ./install.sh --local      # force local Node (npm ci && npm start)
#   ./install.sh --port 9000  # override the listening host port
#   ./install.sh --allow-domains "app.example.com,*.corp.internal"
#   ./install.sh --sessions-per-ip 1
#   ./install.sh --session-rate 20/min
set -euo pipefail

usage() {
  grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -n 12
}

have_docker() {
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
}

# A 32-byte signing key, without assuming Node is on the host.
generate_key() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 32 | tr -d '\n'
  else
    head -c 32 /dev/urandom | base64 | tr -d '\n'
  fi
}

# The key is stable for the life of this script run and exported, so both the
# container and a local server share it.
ensure_key() {
  if [[ -z "${RBAS_KEY:-}" ]]; then
    RBAS_KEY="$(generate_key)"
    echo "==> Generated an access-control signing key for this run"
  fi
  export RBAS_KEY
}

# Exchange the master key for a short-lived token and print a drop-in snippet.
print_embed() {
  local port="$1" json token
  json="$(curl -fsS -X POST -H "Authorization: Bearer ${RBAS_KEY}" "http://localhost:${port}/api/token?ttl=1h" 2>/dev/null || true)"
  token="$(printf '%s' "$json" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
  echo "==> Signing key (keep secret; reuse it to keep tokens valid across restarts):"
  echo "      RBAS_KEY=$RBAS_KEY"
  if [[ -n "$token" ]]; then
    echo "==> Embed with a token (expires in 1h):"
    echo "      <script src=\"http://localhost:${port}/sdk.js?token=${token}\"></script>"
  fi
}

# The service needs a Chromium. Prefer one that is already installed; otherwise
# let puppeteer download its own pinned build at install time.
find_chrome() {
  local candidate
  for candidate in google-chrome google-chrome-stable chromium chromium-browser \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; do
    if [[ "$candidate" == /* ]]; then
      [[ -x "$candidate" ]] && { printf '%s\n' "$candidate"; return 0; }
    elif command -v "$candidate" >/dev/null 2>&1; then
      command -v "$candidate"
      return 0
    fi
  done
  return 1
}

main() {
  local mode="auto"
  local port="${PORT:-8080}"
  local allow_domains="${RBAS_ALLOWED_DOMAINS:-}"
  local sessions_per_ip="${RBAS_MAX_SESSIONS_PER_IP:-}"
  local session_rate="${RBAS_SESSION_RATE:-}"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --docker) mode="docker" ;;
      --local) mode="local" ;;
      --port) port="$2"; shift ;;
      --allow-domains) allow_domains="$2"; shift ;;
      --sessions-per-ip) sessions_per_ip="$2"; shift ;;
      --session-rate) session_rate="$2"; shift ;;
      -h|--help) usage; return 0 ;;
      *) echo "unknown option: $1" >&2; return 1 ;;
    esac
    shift
  done

  cd "$(dirname "$0")"

  if [[ "$mode" == "auto" ]]; then
    if have_docker; then mode="docker"; else mode="local"; fi
  fi

  ensure_key

  # Resource policy passes through to both the container and a local server.
  if [[ -n "$sessions_per_ip" ]]; then export RBAS_MAX_SESSIONS_PER_IP="$sessions_per_ip"; fi
  if [[ -n "$session_rate" ]]; then export RBAS_SESSION_RATE="$session_rate"; fi
  if [[ -n "$allow_domains" ]]; then export RBAS_ALLOWED_DOMAINS="$allow_domains"; fi
  echo "==> Limits: max ${RBAS_MAX_SESSIONS_PER_IP:-1} concurrent session(s)/IP, ${RBAS_SESSION_RATE:-20/min} new sessions"
  echo "==> Targets: ${RBAS_ALLOWED_DOMAINS:-(open — the remote browser may load any domain)}"

  if [[ "$mode" == "docker" ]]; then
    if ! have_docker; then
      echo "Docker is not available. Re-run with --local to run on this machine." >&2
      return 1
    fi
    echo "==> Building and starting with Docker Compose (host port $port)"
    PORT="$port" docker compose up -d --build
    echo "==> Waiting for health check…"
    local _
    for _ in $(seq 1 30); do
      if curl -fsS "http://localhost:${port}/healthz" >/dev/null 2>&1; then
        echo "==> Up: http://localhost:${port}/demo.html"
        print_embed "$port"
        return 0
      fi
      sleep 2
    done
    echo "Container did not become healthy in time; run 'docker compose logs' to inspect." >&2
    return 1
  fi

  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js 18+ is required for a local install." >&2
    return 1
  fi

  echo "==> Installing dependencies"
  if chrome="$(find_chrome)"; then
    echo "==> Using system browser: $chrome"
    export PUPPETEER_SKIP_DOWNLOAD=1
    export PUPPETEER_EXECUTABLE_PATH="$chrome"
  else
    echo "==> No system Chrome found; allowing puppeteer to download Chromium"
    unset PUPPETEER_SKIP_DOWNLOAD
  fi
  npm ci --omit=dev --no-audit --no-fund 2>/dev/null || npm install --omit=dev --no-audit --no-fund

  echo "==> Starting Easy Browser-as-a-Service on port $port"
  echo "==> The demo page needs no token; embeds do. Mint one with:"
  echo "      RBAS_KEY=$RBAS_KEY node server/token.js --ttl 1h"
  PORT="$port" exec npm start
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
