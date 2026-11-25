#!/usr/bin/env bash
# One-time setup for the permanent named tunnel.
#
# Run this yourself — it opens a browser to authenticate against YOUR Cloudflare
# account and creates a real resource there, which is not something the bridge
# or an automated session should do on your behalf.
#
#   ./scripts/setup-named-tunnel.sh bridge.example.com
#
# PREREQUISITE: the zone (example.com) must already be active in
# Cloudflare — i.e. its nameservers point at Cloudflare. A named tunnel resolves
# through <UUID>.cfargotunnel.com, which exists only inside Cloudflare's edge, so
# a CNAME from a third-party DNS provider cannot reach it. See README.
set -euo pipefail

HOSTNAME_ARG="${1:-}"
if [ -z "$HOSTNAME_ARG" ]; then
  echo "usage: $0 <hostname>    e.g. $0 bridge.example.com"
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Binary location: an explicit $CLOUDFLARED wins, then whatever is on PATH
# (Linux, Intel Homebrew under /usr/local, MacPorts), then the Apple-Silicon
# Homebrew path as a last resort.
CFD="${CLOUDFLARED:-$(command -v cloudflared || echo /opt/homebrew/bin/cloudflared)}"
TUNNEL_NAME="${BRIDGE_TUNNEL_NAME:-claude-bridge}"
# Label of your own launchd agent for the tunnel, if you run one. Only used for
# the restart hint printed at the end.
LAUNCHD_LABEL="${BRIDGE_LAUNCHD_LABEL:-com.example.claude-bridge-tunnel}"
PORT="$(grep -E '^BRIDGE_PORT=' "$ROOT/.env" 2>/dev/null | cut -d= -f2)"
PORT="${PORT:-8787}"

echo "▸ 1/4  Authenticate with Cloudflare"
if [ -f "$HOME/.cloudflared/cert.pem" ]; then
  echo "       already authenticated (~/.cloudflared/cert.pem exists)"
else
  echo "       a browser will open — pick the zone for ${HOSTNAME_ARG#*.}"
  "$CFD" tunnel login
fi

echo "▸ 2/4  Create the tunnel"
if "$CFD" tunnel info "$TUNNEL_NAME" >/dev/null 2>&1; then
  echo "       '$TUNNEL_NAME' already exists"
else
  "$CFD" tunnel create "$TUNNEL_NAME"
fi
UUID="$("$CFD" tunnel info "$TUNNEL_NAME" --output json 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).id)}catch{}})')"
[ -z "$UUID" ] && UUID="$("$CFD" tunnel list | awk -v n="$TUNNEL_NAME" '$2==n{print $1}' | head -1)"
echo "       tunnel id: $UUID"

echo "▸ 3/4  Write ~/.cloudflared/config.yml"
mkdir -p "$HOME/.cloudflared"
cat > "$HOME/.cloudflared/config.yml" <<EOF
tunnel: ${UUID}
credentials-file: ${HOME}/.cloudflared/${UUID}.json

ingress:
  - hostname: ${HOSTNAME_ARG}
    service: http://127.0.0.1:${PORT}
  - service: http_status:404
EOF
echo "       wrote config for ${HOSTNAME_ARG} → http://127.0.0.1:${PORT}"

echo "▸ 4/4  Create the DNS route in Cloudflare"
if "$CFD" tunnel route dns "$TUNNEL_NAME" "$HOSTNAME_ARG"; then
  echo "       DNS record created"
else
  echo "       ! route failed — the zone is probably not on Cloudflare nameservers yet."
  echo "       ! Everything else is configured; re-run this step once the zone is active."
fi

echo
echo "Done. Restart the tunnel service so it picks up the named tunnel:"
echo "  launchctl kickstart -k gui/\$(id -u)/${LAUNCHD_LABEL}"
echo
echo "Permanent connector URL:"
echo "  https://${HOSTNAME_ARG}/$(grep -E '^BRIDGE_TOKEN=' "$ROOT/.env" | cut -d= -f2)/mcp"
