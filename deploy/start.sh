#!/bin/bash
# ===========================================================================
# CamBot — Start All Services
# ===========================================================================
# Starts the cambot-agent (via launchd), cambot-ui (via Node/Next.js),
# and the native iMessage bridge (if configured).
# Run on the Mac Mini after install.sh has completed.
#
# Usage:
#   bash start.sh              # Start all services
#   bash start.sh agent        # Start agent only
#   bash start.sh ui           # Start UI only
#   bash start.sh bridge       # Start native iMessage bridge only
#   bash start.sh status       # Check service status
#   bash start.sh stop         # Stop all services
# ===========================================================================
set -euo pipefail

CAMBOT_HOME="${CAMBOT_HOME:-/opt/cambot}"
AGENT_DIR="$CAMBOT_HOME/cambot-agent"
UI_DIR="$CAMBOT_HOME/cambot-core-ui"
CHANNELS_DIR="$CAMBOT_HOME/cambot-channels"
PLIST_LABEL="com.cambot-agent"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
UI_PID_FILE="$CAMBOT_HOME/cambot-ui.pid"
BRIDGE_PID_FILE="$CAMBOT_HOME/cambot-bridge.pid"
UI_PORT="${UI_PORT:-3000}"
BRIDGE_PORT="${BRIDGE_PORT:-9876}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
fail()  { echo -e "${RED}[FAIL]${NC}  $*"; exit 1; }

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

is_agent_running() {
  launchctl list "$PLIST_LABEL" &>/dev/null 2>&1
}

is_ui_running() {
  if [ -f "$UI_PID_FILE" ]; then
    local pid
    pid=$(cat "$UI_PID_FILE")
    kill -0 "$pid" 2>/dev/null && return 0
    # Stale PID file
    rm -f "$UI_PID_FILE"
  fi
  return 1
}

start_agent() {
  if is_agent_running; then
    ok "Agent is already running"
    return
  fi

  [ -f "$PLIST_PATH" ] || fail "Launchd plist not found. Run install.sh first."

  info "Starting cambot-agent..."
  launchctl load "$PLIST_PATH"
  sleep 2

  if is_agent_running; then
    ok "Agent started (port 3100)"
  else
    warn "Agent may have failed to start. Check logs:"
    echo "  tail -f $AGENT_DIR/logs/cambot-agent.log"
  fi
}

start_ui() {
  if is_ui_running; then
    ok "UI is already running (PID $(cat "$UI_PID_FILE"))"
    return
  fi

  [ -d "$UI_DIR" ] || fail "UI directory not found at $UI_DIR"

  # Build if .next doesn't exist
  if [ ! -d "$UI_DIR/.next" ]; then
    info "Building UI (first run)..."
    (cd "$UI_DIR" && npm run build)
  fi

  info "Starting cambot-core-ui on port $UI_PORT..."
  (cd "$UI_DIR" && node_modules/.bin/next start -p "$UI_PORT" >> "$CAMBOT_HOME/logs/cambot-ui.log" 2>&1 &)
  local pid=$!
  echo "$pid" > "$UI_PID_FILE"
  sleep 2

  if kill -0 "$pid" 2>/dev/null; then
    ok "UI started (port $UI_PORT, PID $pid)"
  else
    rm -f "$UI_PID_FILE"
    warn "UI may have failed to start. Check logs:"
    echo "  tail -f $CAMBOT_HOME/logs/cambot-ui.log"
  fi
}

stop_agent() {
  if is_agent_running; then
    info "Stopping agent..."
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    ok "Agent stopped"
  else
    ok "Agent is not running"
  fi
}

stop_ui() {
  if is_ui_running; then
    local pid
    pid=$(cat "$UI_PID_FILE")
    info "Stopping UI (PID $pid)..."
    kill "$pid" 2>/dev/null || true
    rm -f "$UI_PID_FILE"
    ok "UI stopped"
  else
    ok "UI is not running"
  fi
}

# ---------------------------------------------------------------------------
# Native iMessage Bridge
# ---------------------------------------------------------------------------

needs_bridge() {
  # Check if native iMessage provider is configured
  if [ -f "$AGENT_DIR/.env" ]; then
    grep -q 'IMESSAGE_PROVIDER=native' "$AGENT_DIR/.env" 2>/dev/null && return 0
  fi
  return 1
}

is_bridge_running() {
  if [ -f "$BRIDGE_PID_FILE" ]; then
    local pid
    pid=$(cat "$BRIDGE_PID_FILE")
    kill -0 "$pid" 2>/dev/null && return 0
    rm -f "$BRIDGE_PID_FILE"
  fi
  return 1
}

start_bridge() {
  if ! needs_bridge; then
    ok "Native iMessage bridge not needed (IMESSAGE_PROVIDER != native)"
    return
  fi

  if is_bridge_running; then
    ok "Bridge is already running (PID $(cat "$BRIDGE_PID_FILE"))"
    return
  fi

  [ -f "$CHANNELS_DIR/dist/channels/imessage/bridge/native-bridge.js" ] \
    || fail "Native bridge not found. Run: cd $CHANNELS_DIR && bun run build"

  info "Starting native iMessage bridge on port $BRIDGE_PORT..."
  (cd "$CHANNELS_DIR" && BRIDGE_PORT="$BRIDGE_PORT" bun run dist/channels/imessage/bridge/native-bridge.js \
    >> "$CAMBOT_HOME/logs/cambot-bridge.log" 2>&1 &)
  local pid=$!
  echo "$pid" > "$BRIDGE_PID_FILE"
  sleep 1

  if kill -0 "$pid" 2>/dev/null; then
    ok "Bridge started (port $BRIDGE_PORT, PID $pid)"
  else
    rm -f "$BRIDGE_PID_FILE"
    warn "Bridge may have failed to start. Check logs:"
    echo "  tail -f $CAMBOT_HOME/logs/cambot-bridge.log"
  fi
}

stop_bridge() {
  if is_bridge_running; then
    local pid
    pid=$(cat "$BRIDGE_PID_FILE")
    info "Stopping bridge (PID $pid)..."
    kill "$pid" 2>/dev/null || true
    rm -f "$BRIDGE_PID_FILE"
    ok "Bridge stopped"
  else
    ok "Bridge is not running"
  fi
}

show_status() {
  echo ""
  echo "  CamBot Service Status"
  echo "  ─────────────────────"

  if is_agent_running; then
    echo -e "  Agent:   ${GREEN}running${NC} (port 3100)"
  else
    echo -e "  Agent:   ${RED}stopped${NC}"
  fi

  if is_ui_running; then
    echo -e "  UI:      ${GREEN}running${NC} (port $UI_PORT, PID $(cat "$UI_PID_FILE"))"
  else
    echo -e "  UI:      ${RED}stopped${NC}"
  fi

  if needs_bridge; then
    if is_bridge_running; then
      echo -e "  Bridge:  ${GREEN}running${NC} (port $BRIDGE_PORT, PID $(cat "$BRIDGE_PID_FILE"))"
    else
      echo -e "  Bridge:  ${RED}stopped${NC}"
    fi
  else
    echo -e "  Bridge:  ${YELLOW}not configured${NC}"
  fi

  echo ""
  echo "  Logs:"
  echo "    Agent:  tail -f $AGENT_DIR/logs/cambot-agent.log"
  echo "    UI:     tail -f $CAMBOT_HOME/logs/cambot-ui.log"
  if needs_bridge; then
    echo "    Bridge: tail -f $CAMBOT_HOME/logs/cambot-bridge.log"
  fi
  echo ""
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

mkdir -p "$CAMBOT_HOME/logs"

COMMAND="${1:-all}"

case "$COMMAND" in
  agent)
    start_agent
    ;;
  ui)
    start_ui
    ;;
  bridge)
    start_bridge
    ;;
  status)
    show_status
    ;;
  stop)
    echo ""
    stop_bridge
    stop_ui
    stop_agent
    echo ""
    ;;
  all|start)
    echo ""
    echo "============================================"
    echo "  Starting CamBot Services"
    echo "============================================"
    echo ""
    start_bridge
    start_agent
    start_ui
    echo ""
    show_status
    ;;
  *)
    echo "Usage: bash start.sh [agent|ui|bridge|status|stop|all]"
    exit 1
    ;;
esac
