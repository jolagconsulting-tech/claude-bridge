#!/usr/bin/env bash
# Expose the local bridge on a public HTTPS URL that Claude.ai can reach.
#
# Uses a Cloudflare quick tunnel: no account, no signup, no config. The hostname
# is random and changes each run, which is fine — you paste it into Claude.ai as
# a custom connector each time.
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="$(grep -E '^BRIDGE_PORT=' .env 2>/dev/null | cut -d= -f2 || true)"
PORT="${PORT:-8787}"
TOKEN="$(grep -E '^BRIDGE_TOKEN=' .env 2>/dev/null | cut -d= -f2 || true)"

# Binary location: an explicit $CLOUDFLARED wins, then whatever is on PATH
# (Linux, Intel Homebrew under /usr/local, MacPorts), then the Apple-Silicon
# Homebrew path as a last resort.
CFD="${CLOUDFLARED:-$(command -v cloudflared || echo /opt/homebrew/bin/cloudflared)}"

if ! [ -x "$CFD" ]; then
  echo "cloudflared is not installed."
  echo
  echo "Install it with:"
  echo "    brew install cloudflared"
  echo
  echo "Or use ngrok instead:"
  echo "    ngrok http ${PORT}"
  exit 1
fi

if ! curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null; then
  echo "The bridge is not responding on port ${PORT}."
  echo "Start it first, in another terminal:  npm start"
  exit 1
fi

echo "Starting tunnel to http://127.0.0.1:${PORT} ..."
echo
echo "When cloudflared prints its https://<something>.trycloudflare.com URL,"
echo "the connector URL to paste into Claude.ai is:"
echo
echo "    https://<something>.trycloudflare.com/${TOKEN}/mcp"
echo
exec "$CFD" tunnel --url "http://127.0.0.1:${PORT}"
