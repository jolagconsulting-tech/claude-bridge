#!/usr/bin/env bash
# Tunnel process for the launchd service.
#
# Runs the NAMED tunnel when one has been configured (stable hostname, survives
# restarts), and falls back to a quick tunnel otherwise so the bridge is still
# reachable while the named tunnel is being set up.
#
# Either way the current public URL is written to the state dir, so nothing has
# to scrape a log to find out where the bridge is.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Binary location: an explicit $CLOUDFLARED wins, then whatever is on PATH
# (Linux, Intel Homebrew under /usr/local, MacPorts), then the Apple-Silicon
# Homebrew path as a last resort.
CFD="${CLOUDFLARED:-$(command -v cloudflared || echo /opt/homebrew/bin/cloudflared)}"
PORT="$(grep -E '^BRIDGE_PORT=' "$ROOT/.env" 2>/dev/null | cut -d= -f2)"
PORT="${PORT:-8787}"

STATE_DIR="${BRIDGE_STATE_DIR:-$HOME/Library/Application Support/claude-bridge/state}"
mkdir -p "$STATE_DIR"
# The quick tunnel records its URL in its OWN file. tunnel.url is the canonical
# public URL the self-check probes, which may be a different (stable) tunnel
# entirely; writing a throwaway hostname there made public_http test the wrong
# tunnel.
URL_FILE="$STATE_DIR/cloudflared.url"

TUNNEL_NAME="${BRIDGE_TUNNEL_NAME:-claude-bridge}"
CF_CONFIG="$HOME/.cloudflared/config.yml"

# Wait for the bridge itself to be listening. launchd may start us first, and a
# tunnel to a dead port just serves 502s.
for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 && break
  sleep 2
done

# --- named tunnel, if configured -------------------------------------------
if [ -f "$CF_CONFIG" ] && "$CFD" tunnel info "$TUNNEL_NAME" >/dev/null 2>&1; then
  HOSTNAME_LINE="$(grep -E '^\s*-?\s*hostname:' "$CF_CONFIG" | head -1 | sed 's/.*hostname:[[:space:]]*//')"
  if [ -n "$HOSTNAME_LINE" ]; then
    echo "https://${HOSTNAME_LINE}" > "$URL_FILE"
    echo "$(date -u +%FT%TZ) starting NAMED tunnel '$TUNNEL_NAME' → https://${HOSTNAME_LINE}"
  fi
  exec "$CFD" --no-autoupdate tunnel run "$TUNNEL_NAME"
fi

# --- quick tunnel fallback ---------------------------------------------------
echo "$(date -u +%FT%TZ) no named tunnel configured; starting a QUICK tunnel (hostname changes on every restart)"
LOG="$ROOT/logs/tunnel.log"
mkdir -p "$ROOT/logs"

"$CFD" --no-autoupdate tunnel --url "http://127.0.0.1:${PORT}" 2>&1 | tee "$LOG" &
CFD_PID=$!
trap 'kill $CFD_PID 2>/dev/null' EXIT TERM INT

# Record the assigned hostname as soon as it appears.
for _ in $(seq 1 60); do
  URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" 2>/dev/null | head -1)"
  if [ -n "$URL" ]; then
    echo "$URL" > "$URL_FILE"
    echo "$(date -u +%FT%TZ) quick tunnel URL: $URL"
    break
  fi
  sleep 1
done

wait $CFD_PID
