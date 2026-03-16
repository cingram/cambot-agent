#!/bin/bash
# ===========================================================================
# CamBot-Agent — Updater
# ===========================================================================
# Downloads the latest (or specified) release and updates the installation.
# Preserves all user data (store/, groups/, .env, data/).
#
# Usage:
#   bash update.sh                        # Update to latest
#   bash update.sh --version v1.2.3       # Update to specific version
#   CAMBOT_HOME=/opt/cambot bash update.sh
# ===========================================================================
set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults & argument parsing
# ---------------------------------------------------------------------------
CAMBOT_HOME="${CAMBOT_HOME:-/opt/cambot}"
UPDATE_VERSION="latest"
GITHUB_OWNER="cingram"
GITHUB_REPO="cambot-agent"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)  UPDATE_VERSION="$2"; shift 2 ;;
    --home)     CAMBOT_HOME="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: update.sh [--version v1.2.3] [--home /opt/cambot]"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

AGENT_DIR="$CAMBOT_HOME/cambot-agent"
UI_DIR="$CAMBOT_HOME/cambot-core-ui"
PLIST_LABEL="com.cambot-agent"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"

# ---------------------------------------------------------------------------
# Colors & logging
# ---------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${BLUE}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
fail()  { echo -e "${RED}[FAIL]${NC}  $*"; exit 1; }
step()  { echo -e "\n${CYAN}── $*${NC}"; }

# ---------------------------------------------------------------------------
# Pre-flight
# ---------------------------------------------------------------------------
echo ""
echo "============================================"
echo "  CamBot-Agent Updater"
echo "============================================"
echo ""

[ -d "$AGENT_DIR" ] || fail "No existing installation at $CAMBOT_HOME. Run install.sh first."

# Show current version
if [ -f "$CAMBOT_HOME/VERSION" ]; then
  info "Current version: $(head -1 "$CAMBOT_HOME/VERSION")"
fi

# Verify gh CLI
command -v gh &>/dev/null || fail "GitHub CLI (gh) is required. Install it: https://cli.github.com"
gh auth status &>/dev/null 2>&1 || fail "GitHub CLI not authenticated. Run: gh auth login"

# ===========================================================================
# Step 1: Check for updates
# ===========================================================================
step "Step 1/6: Check Version"

if [ "$UPDATE_VERSION" = "latest" ]; then
  UPDATE_VERSION=$(gh release view --repo "$GITHUB_OWNER/$GITHUB_REPO" --json tagName -q '.tagName')
fi

info "Target version: $UPDATE_VERSION"

# Compare with installed version
if [ -f "$CAMBOT_HOME/VERSION" ] && grep -q "$UPDATE_VERSION" "$CAMBOT_HOME/VERSION"; then
  ok "Already running $UPDATE_VERSION"
  echo ""
  echo "  Use --version to specify a different version, or"
  echo "  re-run with a specific tag to force reinstall."
  echo ""
  exit 0
fi

# ===========================================================================
# Step 2: Download release
# ===========================================================================
step "Step 2/6: Download Release"

DOWNLOAD_DIR="$(mktemp -d)"
trap 'rm -rf "$DOWNLOAD_DIR"' EXIT

info "Downloading $UPDATE_VERSION artifacts..."
gh release download "$UPDATE_VERSION" \
  --repo "$GITHUB_OWNER/$GITHUB_REPO" \
  --dir "$DOWNLOAD_DIR" \
  --pattern "cambot-agent-*.tar.gz" \
  --pattern "cambot-ui-*.tar.gz"

AGENT_ARCHIVE=$(ls "$DOWNLOAD_DIR"/cambot-agent-*.tar.gz 2>/dev/null | head -1)
UI_ARCHIVE=$(ls "$DOWNLOAD_DIR"/cambot-ui-*.tar.gz 2>/dev/null | head -1)

[ -f "$AGENT_ARCHIVE" ] || fail "Agent artifact not found in release $UPDATE_VERSION"
ok "Downloaded artifacts"

# ===========================================================================
# Step 3: Stop services
# ===========================================================================
step "Step 3/6: Stop Services"

OS="$(uname -s)"

# Stop launchd service (macOS)
if [ "$OS" = "Darwin" ] && launchctl list "$PLIST_LABEL" &>/dev/null 2>&1; then
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  ok "Launchd service stopped"
fi

# Stop systemd services (Linux)
if [ "$OS" = "Linux" ]; then
  sudo systemctl stop cambot-agent 2>/dev/null || true
  sudo systemctl stop cambot-ui 2>/dev/null || true
  ok "Systemd services stopped"
fi

# Stop UI PID-based process
UI_PID_FILE="$CAMBOT_HOME/cambot-ui.pid"
if [ -f "$UI_PID_FILE" ]; then
  kill "$(cat "$UI_PID_FILE")" 2>/dev/null || true
  rm -f "$UI_PID_FILE"
fi

# Wait for containers to finish
info "Waiting for running agent containers to finish..."
TIMEOUT=60
ELAPSED=0
while docker ps --filter "name=cambot-agent-" --format '{{.Names}}' 2>/dev/null | grep -q .; do
  if [ $ELAPSED -ge $TIMEOUT ]; then
    warn "Timeout waiting for containers. Stopping them..."
    docker ps --filter "name=cambot-agent-" --format '{{.Names}}' | xargs -r docker stop -t 5
    break
  fi
  sleep 5
  ELAPSED=$((ELAPSED + 5))
done
ok "Services stopped"

# ===========================================================================
# Step 4: Extract and update files
# ===========================================================================
step "Step 4/6: Update Application Files"

EXTRACT_DIR="$(mktemp -d)"

tar xzf "$AGENT_ARCHIVE" -C "$EXTRACT_DIR"

# Update library packages
for pkg in cambot-integrations cambot-core cambot-channels cambot-workflows cambot-llm; do
  if [ -d "$EXTRACT_DIR/$pkg" ]; then
    rm -rf "$CAMBOT_HOME/$pkg/dist"
    cp -r "$EXTRACT_DIR/$pkg/dist"         "$CAMBOT_HOME/$pkg/dist"
    cp    "$EXTRACT_DIR/$pkg/package.json"  "$CAMBOT_HOME/$pkg/package.json"
  fi
done

# Update cambot-agent (preserve store/, data/, groups/, logs/, .env)
if [ -d "$EXTRACT_DIR/cambot-agent" ]; then
  rm -rf "$AGENT_DIR/dist"
  cp -r "$EXTRACT_DIR/cambot-agent/dist" "$AGENT_DIR/dist"
  cp "$EXTRACT_DIR/cambot-agent/package.json" "$AGENT_DIR/package.json"

  # Update container assets
  rm -rf "$AGENT_DIR/container"
  cp -r "$EXTRACT_DIR/cambot-agent/container" "$AGENT_DIR/container"

  # Update agent-runner
  rm -rf "$AGENT_DIR/agent-runner/src" "$AGENT_DIR/agent-runner/dist"
  cp -r "$EXTRACT_DIR/cambot-agent/agent-runner/src" "$AGENT_DIR/agent-runner/src"
  [ -d "$EXTRACT_DIR/cambot-agent/agent-runner/dist" ] && \
    cp -r "$EXTRACT_DIR/cambot-agent/agent-runner/dist" "$AGENT_DIR/agent-runner/dist"
  cp "$EXTRACT_DIR/cambot-agent/agent-runner/package.json" "$AGENT_DIR/agent-runner/package.json"

  # Update deploy scripts
  [ -d "$EXTRACT_DIR/cambot-agent/deploy" ] && \
    cp -r "$EXTRACT_DIR/cambot-agent/deploy/." "$AGENT_DIR/deploy/"
fi

# Update UI
if [ -f "$UI_ARCHIVE" ]; then
  info "Updating UI..."
  rm -rf "$UI_DIR"
  mkdir -p "$UI_DIR"
  tar xzf "$UI_ARCHIVE" -C "$CAMBOT_HOME"
fi

# Update version stamp
[ -f "$EXTRACT_DIR/VERSION" ] && cp "$EXTRACT_DIR/VERSION" "$CAMBOT_HOME/"

rm -rf "$EXTRACT_DIR"
ok "Application files updated"

# ===========================================================================
# Step 5: Reinstall dependencies and rebuild container
# ===========================================================================
step "Step 5/6: Dependencies & Container"

info "Updating dependencies..."
for pkg in cambot-integrations cambot-channels cambot-core cambot-workflows cambot-llm cambot-agent; do
  if [ -d "$CAMBOT_HOME/$pkg" ] && [ -f "$CAMBOT_HOME/$pkg/package.json" ]; then
        rm -f "$CAMBOT_HOME/$pkg/bun.lock" "$CAMBOT_HOME/$pkg/bun.lockb"
    (cd "$CAMBOT_HOME/$pkg" && bun install --production 2>&1 | tail -1)
  fi
done
ok "Dependencies updated"

info "Rebuilding agent container image..."
(cd "$AGENT_DIR/container" && bash build.sh)
ok "Container image rebuilt"

# ===========================================================================
# Step 6: Restart services
# ===========================================================================
step "Step 6/6: Restart Services"

if [ "$OS" = "Darwin" ] && [ -f "$PLIST_PATH" ]; then
  launchctl load "$PLIST_PATH"
  ok "Launchd service started"
elif [ "$OS" = "Linux" ]; then
  sudo systemctl start cambot-agent 2>/dev/null || true
  sudo systemctl start cambot-ui 2>/dev/null || true
  ok "Systemd services started"
fi

echo ""
echo "============================================"
echo "  Update Complete!"
echo "============================================"
echo ""
echo "  Version: $UPDATE_VERSION"
echo "  Logs:    tail -f $AGENT_DIR/logs/cambot-agent.log"
echo ""
