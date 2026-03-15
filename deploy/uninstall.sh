#!/bin/bash
# ===========================================================================
# CamBot-Agent — Uninstaller
# ===========================================================================
# Stops the service, removes launchd config, and optionally removes data.
#
# Usage:
#   bash uninstall.sh              # Remove service + app (keeps data)
#   bash uninstall.sh --purge      # Remove everything including data
# ===========================================================================
set -euo pipefail

CAMBOT_HOME="${CAMBOT_HOME:-/opt/cambot}"
AGENT_DIR="$CAMBOT_HOME/cambot-agent"
PLIST_LABEL="com.cambot-agent"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
PURGE=false

[ "${1:-}" = "--purge" ] && PURGE=true

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }

echo ""
echo "============================================"
echo "  CamBot-Agent Uninstaller"
echo "============================================"
echo ""

if $PURGE; then
  warn "PURGE mode: ALL data (database, groups, logs) will be deleted."
else
  info "Data (database, groups, logs) will be preserved."
  info "Use --purge to remove everything."
fi

echo ""
echo "Continue? (y/n)"
read -r ans
[ "$ans" = "y" ] || [ "$ans" = "Y" ] || { echo "Cancelled."; exit 0; }

# ---------------------------------------------------------------------------
# 1. Stop and remove service
# ---------------------------------------------------------------------------
echo ""
info "Stopping service..."
if launchctl list "$PLIST_LABEL" &>/dev/null 2>&1; then
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
fi
rm -f "$PLIST_PATH"
ok "Service removed"

# ---------------------------------------------------------------------------
# 2. Stop running containers
# ---------------------------------------------------------------------------
info "Stopping agent containers..."
docker ps --filter "name=cambot-agent-" --format '{{.Names}}' 2>/dev/null | \
  xargs -r docker stop -t 10 2>/dev/null || true
docker ps --filter "name=cambot-worker-" --format '{{.Names}}' 2>/dev/null | \
  xargs -r docker stop -t 10 2>/dev/null || true
ok "Containers stopped"

# ---------------------------------------------------------------------------
# 3. Remove Docker image
# ---------------------------------------------------------------------------
info "Removing agent container image..."
docker rmi cambot-agent-claude:latest 2>/dev/null || true
ok "Image removed"

# ---------------------------------------------------------------------------
# 4. Remove application or everything
# ---------------------------------------------------------------------------
if $PURGE; then
  info "Removing all files at $CAMBOT_HOME..."
  sudo rm -rf "$CAMBOT_HOME"
  rm -rf "$HOME/.config/cambot-agent"
  ok "All files removed"
else
  info "Removing application files (keeping data)..."
  # Remove code but keep store/, data/, groups/, logs/, .env
  for pkg in cambot-integrations cambot-core cambot-workflows cambot-channels cambot-llm; do
    rm -rf "$CAMBOT_HOME/$pkg"
  done
  rm -rf "$AGENT_DIR/dist"
  rm -rf "$AGENT_DIR/node_modules"
  rm -rf "$AGENT_DIR/container"
  rm -rf "$AGENT_DIR/agent-runner"
  ok "Application files removed"
  echo ""
  info "Data preserved at:"
  info "  Database : $AGENT_DIR/store/"
  info "  Groups   : $AGENT_DIR/groups/"
  info "  Logs     : $AGENT_DIR/logs/"
  info "  Config   : $AGENT_DIR/.env"
fi

echo ""
echo "============================================"
echo "  Uninstall Complete"
echo "============================================"
echo ""
