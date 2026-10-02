#!/usr/bin/env bash
# Easy Browser-as-a-Service — one-command install.
#
#   ./install.sh              # Docker if available, else local Node
#   ./install.sh --docker     # force Docker (docker compose up -d --build)
#   ./install.sh --local      # force local Node (npm ci && npm start)
#   ./install.sh --port 9000  # override the listening host port
set -euo pipefail

usage() {
  grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -n 9
}

have_docker() {
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
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

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --docker) mode="docker" ;;
      --local) mode="local" ;;
      --port) port="$2"; shift ;;
      -h|--help) usage; return 0 ;;
      *) echo "unknown option: $1" >&2; return 1 ;;
    esac
    shift
  done

  cd "$(dirname "$0")"

  if [[ "$mode" == "auto" ]]; then
    if have_docker; then mode="docker"; else mode="local"; fi
  fi

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
  PORT="$port" exec npm start
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
