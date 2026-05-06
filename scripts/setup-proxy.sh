#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════
# Ollama Bridge Proxy — Setup Script
# ═══════════════════════════════════════════════════════════════════════
# Run this on the machine where the proxy will live.
# For local usage alongside Foundry: run on same machine, HOST=127.0.0.1
# For shared/team usage: run on a VPS or server with known IP
#
# Usage:
#   chmod +x setup-proxy.sh
#   ./setup-proxy.sh            # interactive setup
#   ./setup-proxy.sh --quick    # default settings, token mode
# ═══════════════════════════════════════════════════════════════════════

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}[*]${NC} $1"; }
ok()    { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
err()   { echo -e "${RED}[✗]${NC} $1"; exit 1; }

MODE="${PROXY_MODE:-}"
TARGET="${OLLAMA_TARGET_URL:-https://hermes-bridge.luxtenebris.online}"
PORT="${PROXY_PORT:-3001}"
HOST="${PROXY_HOST:-127.0.0.1}"
RATE_LIMIT="${RATE_LIMIT_RPM:-30}"
API_KEY="${OLLAMA_API_KEY:-}"

# ═══════════════════════════════════════════════════════════════════════
# Step 1 — Dependencies
# ═══════════════════════════════════════════════════════════════════════
if ! command -v node &>/dev/null; then
  err "Node.js is required. Install it first: https://nodejs.org"
fi
if [ ! -d node_modules ] || [ ! -f node_modules/express/package.json ]; then
  info "Installing Express..."
  npm install express --save
  ok "Express installed"
else
  ok "Express already installed"
fi

# ═══════════════════════════════════════════════════════════════════════
# Step 2 — Configuration
# ═══════════════════════════════════════════════════════════════════════
print_banner() {
  echo ""
  echo -e "${CYAN}╔══════════════════════════════════════════════════════════╗${NC}"
  echo -e "${CYAN}║         Ollama Bridge Proxy — Configuration            ║${NC}"
  echo -e "${CYAN}╚══════════════════════════════════════════════════════════╝${NC}"
  echo ""
}

if [ "${1:-}" = "--quick" ]; then
  MODE="${MODE:-token}"
  SECRET="${PROXY_SECRET:-$(openssl rand -hex 32)}"
  info "Quick mode: token auth, localhost:${PORT}"
else
  print_banner

  # Security mode
  echo "Choose security mode:"
  echo "  1) Shared Secret Token  (strongest — recommended)"
  echo "  2) Foundry Referer Lock  (good for browser-only, no Foundry config)"
  echo "  3) IP Allowlist          (best if Foundry has static IP)"
  echo "  4) Open                  (⚠️  NOT RECOMMENDED)"
  read -rp "Mode [1]: " mode_choice
  case "${mode_choice:-1}" in
    1) MODE="token" ;;
    2) MODE="referer" ;;
    3) MODE="ip" ;;
    4) MODE="open" ;;
    *) MODE="token" ;;
  esac

  # Target endpoint
  read -rp "Upstream Ollama URL [${TARGET}]: " input
  TARGET="${input:-$TARGET}"

  # Port
  read -rp "Proxy port [${PORT}]: " input
  PORT="${input:-$PORT}"

  # Host binding
  read -rp "Bind address [${HOST}] (127.0.0.1 = local only, 0.0.0.0 = network): " input
  HOST="${input:-$HOST}"

  # Mode-specific config
  case "$MODE" in
    token)
      read -rp "Shared secret (leave blank to generate random): " input
      if [ -z "$input" ]; then
        SECRET="$(openssl rand -hex 32)"
        info "Generated secret: ${YELLOW}${SECRET}${NC}"
      else
        SECRET="$input"
      fi
      ok "Token mode — clients must send X-Ollama-Proxy: ${SECRET}"
      ;;
    referer)
      read -rp "Allowed origin(s), comma-separated (e.g. https://my-foundry.com): " input
      ALLOWED_ORIGINS="${input:-http://localhost:30000}"
      ok "Referer lock — only requests from: ${ALLOWED_ORIGINS}"
      ;;
    ip)
      read -rp "Allowed IPs/CIDRs, comma-separated (e.g. 203.0.113.0/24,192.168.1.0/24): " input
      ALLOWED_IPS="${input:-127.0.0.1}"
      ok "IP allowlist — only from: ${ALLOWED_IPS}"
      ;;
  esac

  # Rate limit
  read -rp "Max requests per minute per IP [${RATE_LIMIT}]: " input
  RATE_LIMIT="${input:-$RATE_LIMIT}"

  # API key for upstream
  read -rp "Ollama cloud API key (leave blank if not needed): " input
  API_KEY="${input:-$API_KEY}"
fi

# ═══════════════════════════════════════════════════════════════════════
# Step 3 — Write .env file
# ═══════════════════════════════════════════════════════════════════════
cat > .env <<ENVEOF
# Ollama Bridge Proxy — Auto-generated config
# Source this file before running: export \$(cat .env | xargs)
OLLAMA_TARGET_URL=${TARGET}
PROXY_PORT=${PORT}
PROXY_HOST=${HOST}
PROXY_MODE=${MODE}
RATE_LIMIT_RPM=${RATE_LIMIT}
OLLAMA_API_KEY=${API_KEY}
ENVEOF

case "$MODE" in
  token)   echo "PROXY_SECRET=${SECRET}" >> .env ;;
  referer) echo "ALLOWED_ORIGINS=${ALLOWED_ORIGINS}" >> .env ;;
  ip)      echo "PROXY_ALLOWED_IPS=${ALLOWED_IPS}" >> .env ;;
esac

ok ".env written"

# ═══════════════════════════════════════════════════════════════════════
# Step 4 — Write systemd service file (optional)
# ═══════════════════════════════════════════════════════════════════════
if [ -d /etc/systemd/system ]; then
  cat > ollama-proxy.service <<SERVICEEOF
[Unit]
Description=Ollama Bridge Proxy
After=network.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=$(pwd)
EnvironmentFile=$(pwd)/.env
ExecStart=/usr/bin/node $(pwd)/ollama-proxy.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SERVICEEOF

  info "systemd service file written: ollama-proxy.service"
  echo "  To install: sudo cp ollama-proxy.service /etc/systemd/system/"
  echo "  sudo systemctl daemon-reload"
  echo "  sudo systemctl enable --now ollama-proxy"
fi

# ═══════════════════════════════════════════════════════════════════════
# Step 5 — Show summary
# ═══════════════════════════════════════════════════════════════════════
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║           Setup Complete!                             ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""
echo "  Proxy:     http://${HOST}:${PORT}"
echo "  Target:    ${TARGET}"
echo "  Mode:      ${MODE}"
echo "  Rate:      ${RATE_LIMIT} req/min/IP"
echo ""
echo "  To start:  export \$(cat .env | xargs)"
echo "             node ollama-proxy.js"
echo ""
echo "  To stop:   Ctrl+C"
echo ""

case "$MODE" in
  token)
    echo -e "  ${YELLOW}Foundry module setting:${NC}"
    echo "    Ollama URL → http://${HOST}:${PORT}"
    echo "    Proxy Auth Token → ${SECRET}"
    echo ""
    echo -e "  ${YELLOW}cURL test:${NC}"
    echo "    curl -s http://${HOST}:${PORT}/health -H 'X-Ollama-Proxy: ${SECRET}'"
    echo "    curl -s http://${HOST}:${PORT}/api/chat -H 'X-Ollama-Proxy: ${SECRET}' \\"
    echo "      -H 'Content-Type: application/json' \\"
    echo "      -d '{\"model\":\"gemma4:31b-cloud\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"stream\":false}'"
    ;;
  referer)
    echo -e "  ${YELLOW}Allowed origins:${NC}"
    echo "    ${ALLOWED_ORIGINS}"
    ;;
  ip)
    echo -e "  ${YELLOW}Allowed IPs:${NC}"
    echo "    ${ALLOWED_IPS}"
    ;;
esac
echo ""
