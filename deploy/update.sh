#!/bin/bash
# ===========================================================================
# CamBot-Agent — Update Script
# ===========================================================================
# Run this on the Mac Mini after extracting a new deploy tarball.
# Stops the service, updates application files, rebuilds, restarts.
#
# Usage:
#   bash update.sh
#   CAMBOT_HOME=/opt/cambot bash update.sh
# ===========================================================================
set -euo pipefail

CAMBOT_HOME="${CAMBOT_HOME:-/opt/cambot}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$SCRIPT_DIR/cambot"
AGENT_DIR="$CAMBOT_HOME/cambot-agent"
PLIST_LABEL="com.cambot-agent"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
fail()  { echo -e "${RED}[FAIL]${NC}  $*"; exit 1; }

echo ""
echo "============================================"
echo "  CamBot-Agent Updater"
echo "============================================"
echo ""

[ -d "$SOURCE_DIR" ] || fail "Source directory not found: $SOURCE_DIR"
[ -d "$AGENT_DIR" ]  || fail "No existing installation at $CAMBOT_HOME. Run install.sh first."

if [ -f "$SOURCE_DIR/VERSION" ]; then
  info "New version: $(cat "$SOURCE_DIR/VERSION" | head -1)"
fi
if [ -f "$CAMBOT_HOME/VERSION" ]; then
  info "Current version: $(cat "$CAMBOT_HOME/VERSION" | head -1)"
fi

# ---------------------------------------------------------------------------
# 1. Stop service
# ---------------------------------------------------------------------------
echo ""
info "Stopping service..."
if launchctl list "$PLIST_LABEL" &>/dev/null 2>&1; then
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  ok "Service stopped"
else
  ok "Service was not running"
fi

# Wait for containers to finish
info "Waiting for running agent containers to finish..."
TIMEOUT=60
ELAPSED=0
while docker ps --filter "name=cambot-agent-" --format '{{.Names}}' 2>/dev/null | grep -q .; do
  if [ $ELAPSED -ge $TIMEOUT ]; then
    warn "Timeout waiting for containers. Stopping them forcefully..."
    docker ps --filter "name=cambot-agent-" --format '{{.Names}}' | xargs -r docker stop -t 5
    break
  fi
  sleep 5
  ELAPSED=$((ELAPSED + 5))
done

# ---------------------------------------------------------------------------
# 2. Update application files
# ---------------------------------------------------------------------------
echo ""
info "Updating application files..."

for pkg in cambot-integrations cambot-core cambot-workflows cambot-channels cambot-llm; do
  if [ -d "$SOURCE_DIR/$pkg" ]; then
    rm -rf "$CAMBOT_HOME/$pkg/dist"
    cp -r "$SOURCE_DIR/$pkg/dist"         "$CAMBOT_HOME/$pkg/dist"
    cp    "$SOURCE_DIR/$pkg/package.json"  "$CAMBOT_HOME/$pkg/package.json"
  fi
done

# cambot-agent: update dist + container assets + agent-runner
rm -rf "$AGENT_DIR/dist"
cp -r "$SOURCE_DIR/cambot-agent/dist" "$AGENT_DIR/dist"
cp "$SOURCE_DIR/cambot-agent/package.json" "$AGENT_DIR/package.json"

# Update container assets (Dockerfile, entrypoint, skills)
rm -rf "$AGENT_DIR/container"
cp -r "$SOURCE_DIR/cambot-agent/container" "$AGENT_DIR/container"

# Update agent-runner source (mounted into ephemeral containers)
rm -rf "$AGENT_DIR/agent-runner/src" "$AGENT_DIR/agent-runner/dist"
cp -r "$SOURCE_DIR/cambot-agent/agent-runner/src" "$AGENT_DIR/agent-runner/src"
[ -d "$SOURCE_DIR/cambot-agent/agent-runner/dist" ] && \
  cp -r "$SOURCE_DIR/cambot-agent/agent-runner/dist" "$AGENT_DIR/agent-runner/dist"
cp "$SOURCE_DIR/cambot-agent/agent-runner/package.json" "$AGENT_DIR/agent-runner/package.json"

# Update cambot-llm source (mounted into ephemeral containers)
if [ -d "$SOURCE_DIR/cambot-llm" ]; then
  rm -rf "$CAMBOT_HOME/cambot-llm/src" "$CAMBOT_HOME/cambot-llm/dist"
  cp -r "$SOURCE_DIR/cambot-llm/src" "$CAMBOT_HOME/cambot-llm/src"
  [ -d "$SOURCE_DIR/cambot-llm/dist" ] && \
    cp -r "$SOURCE_DIR/cambot-llm/dist" "$CAMBOT_HOME/cambot-llm/dist"
  cp "$SOURCE_DIR/cambot-llm/package.json" "$CAMBOT_HOME/cambot-llm/package.json"
fi

# Update version stamp
[ -f "$SOURCE_DIR/VERSION" ] && cp "$SOURCE_DIR/VERSION" "$CAMBOT_HOME/"

ok "Application files updated"

# ---------------------------------------------------------------------------
# 3. Update dependencies (in case package.json changed)
# ---------------------------------------------------------------------------
echo ""
info "Updating dependencies..."
for pkg in cambot-integrations cambot-channels cambot-core cambot-workflows cambot-llm cambot-agent; do
  (cd "$CAMBOT_HOME/$pkg" && bun install --production 2>&1 | tail -1)
done
ok "Dependencies updated"

# ---------------------------------------------------------------------------
# 4. Rebuild agent container image
# ---------------------------------------------------------------------------
echo ""
info "Rebuilding agent container image..."
(cd "$AGENT_DIR/container" && bash build.sh)
ok "Agent container image rebuilt"

# ---------------------------------------------------------------------------
# 5. Restart service
# ---------------------------------------------------------------------------
echo ""
info "Starting service..."
launchctl load "$PLIST_PATH"
ok "Service started"

echo ""
echo "============================================"
echo "  Update Complete!"
echo "============================================"
echo ""
echo "  Check logs: tail -f $AGENT_DIR/logs/cambot-agent.log"
echo ""
