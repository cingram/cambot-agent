#!/bin/bash
# ===========================================================================
# cambot-ctl — Unified CLI for CamBot
# ===========================================================================
# Single entry point for managing CamBot installations.
#
# Install to PATH:
#   sudo ln -sf /opt/cambot/cambot-agent/deploy/cambot-ctl.sh /usr/local/bin/cambot-ctl
#
# Usage:
#   cambot-ctl install [--version v1.2.3]
#   cambot-ctl update  [--version v1.2.3]
#   cambot-ctl uninstall [--purge]
#   cambot-ctl start [agent|ui|all]
#   cambot-ctl stop [agent|ui|all]
#   cambot-ctl restart [agent|ui|all]
#   cambot-ctl status
#   cambot-ctl logs [agent|ui] [-f]
#   cambot-ctl doctor
#   cambot-ctl version
# ===========================================================================
set -euo pipefail

CAMBOT_HOME="${CAMBOT_HOME:-/opt/cambot}"
AGENT_DIR="$CAMBOT_HOME/cambot-agent"
UI_DIR="$CAMBOT_HOME/cambot-core-ui"
DEPLOY_DIR="$AGENT_DIR/deploy"

# Detect OS
OS="$(uname -s)"
PLIST_LABEL="com.cambot-agent"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
UI_PID_FILE="$CAMBOT_HOME/cambot-ui.pid"
UI_PORT="${UI_PORT:-3000}"

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

check_ok()   { echo -e "  ${GREEN}✓${NC} $*"; }
check_warn() { echo -e "  ${YELLOW}!${NC} $*"; }
check_fail() { echo -e "  ${RED}✗${NC} $*"; }

# ---------------------------------------------------------------------------
# Service helpers
# ---------------------------------------------------------------------------

is_agent_running() {
  if [ "$OS" = "Darwin" ]; then
    launchctl list "$PLIST_LABEL" &>/dev/null 2>&1
  else
    systemctl is-active --quiet cambot-agent 2>/dev/null
  fi
}

is_ui_running() {
  if [ "$OS" = "Linux" ] && systemctl is-active --quiet cambot-ui 2>/dev/null; then
    return 0
  fi
  if [ -f "$UI_PID_FILE" ]; then
    local pid
    pid=$(cat "$UI_PID_FILE")
    kill -0 "$pid" 2>/dev/null && return 0
    rm -f "$UI_PID_FILE"
  fi
  return 1
}

start_agent() {
  if is_agent_running; then
    ok "Agent is already running"
    return
  fi

  if [ "$OS" = "Darwin" ]; then
    [ -f "$PLIST_PATH" ] || fail "Launchd plist not found. Run: cambot-ctl install"
    info "Starting cambot-agent..."
    launchctl load "$PLIST_PATH"
  else
    info "Starting cambot-agent..."
    sudo systemctl start cambot-agent
  fi

  sleep 2
  if is_agent_running; then
    ok "Agent started (port 3100)"
  else
    warn "Agent may have failed to start. Check: cambot-ctl logs agent"
  fi
}

start_ui() {
  if is_ui_running; then
    ok "UI is already running"
    return
  fi

  [ -d "$UI_DIR" ] || fail "UI directory not found at $UI_DIR"

  if [ "$OS" = "Linux" ] && systemctl list-unit-files cambot-ui.service &>/dev/null 2>&1; then
    info "Starting cambot-ui..."
    sudo systemctl start cambot-ui
  else
    # Standalone mode (macOS or no systemd)
    if [ -f "$UI_DIR/server.js" ]; then
      info "Starting cambot-core-ui on port $UI_PORT..."
      (cd "$UI_DIR" && PORT="$UI_PORT" node server.js >> "$CAMBOT_HOME/logs/cambot-ui.log" 2>&1 &)
      local pid=$!
      echo "$pid" > "$UI_PID_FILE"
    elif [ -d "$UI_DIR/.next" ]; then
      info "Starting cambot-core-ui on port $UI_PORT (next start)..."
      (cd "$UI_DIR" && node_modules/.bin/next start -p "$UI_PORT" >> "$CAMBOT_HOME/logs/cambot-ui.log" 2>&1 &)
      local pid=$!
      echo "$pid" > "$UI_PID_FILE"
    else
      fail "No runnable UI found. Re-run: cambot-ctl install"
    fi

    sleep 2
    if is_ui_running; then
      ok "UI started (port $UI_PORT)"
    else
      warn "UI may have failed to start. Check: cambot-ctl logs ui"
    fi
  fi
}

stop_agent() {
  if is_agent_running; then
    info "Stopping agent..."
    if [ "$OS" = "Darwin" ]; then
      launchctl unload "$PLIST_PATH" 2>/dev/null || true
    else
      sudo systemctl stop cambot-agent 2>/dev/null || true
    fi
    ok "Agent stopped"
  else
    ok "Agent is not running"
  fi
}

stop_ui() {
  if is_ui_running; then
    info "Stopping UI..."
    if [ "$OS" = "Linux" ] && systemctl is-active --quiet cambot-ui 2>/dev/null; then
      sudo systemctl stop cambot-ui
    elif [ -f "$UI_PID_FILE" ]; then
      kill "$(cat "$UI_PID_FILE")" 2>/dev/null || true
      rm -f "$UI_PID_FILE"
    fi
    ok "UI stopped"
  else
    ok "UI is not running"
  fi
}

show_status() {
  echo ""
  echo "  CamBot Service Status"
  echo "  ─────────────────────"

  if is_agent_running; then
    echo -e "  Agent:  ${GREEN}running${NC} (port 3100)"
  else
    echo -e "  Agent:  ${RED}stopped${NC}"
  fi

  if is_ui_running; then
    echo -e "  UI:     ${GREEN}running${NC} (port $UI_PORT)"
  else
    echo -e "  UI:     ${RED}stopped${NC}"
  fi

  if [ -f "$CAMBOT_HOME/VERSION" ]; then
    echo ""
    echo "  Version: $(head -1 "$CAMBOT_HOME/VERSION")"
  fi

  # Show running containers
  local containers
  containers=$(docker ps --filter "name=cambot-" --format '{{.Names}}' 2>/dev/null | wc -l | tr -d ' ')
  echo "  Containers: $containers running"
  echo ""
}

show_logs() {
  local component="${1:-agent}"
  shift || true

  local follow=false
  local lines=50

  while [[ $# -gt 0 ]]; do
    case "$1" in
      -f|--follow) follow=true; shift ;;
      -n)          lines="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  local log_file
  case "$component" in
    agent) log_file="$AGENT_DIR/logs/cambot-agent.log" ;;
    ui)    log_file="$CAMBOT_HOME/logs/cambot-ui.log" ;;
    *)     fail "Unknown component: $component. Use 'agent' or 'ui'" ;;
  esac

  if [ ! -f "$log_file" ]; then
    warn "No log file found at $log_file"
    return
  fi

  if $follow; then
    tail -f "$log_file"
  else
    tail -n "$lines" "$log_file"
  fi
}

run_doctor() {
  echo ""
  echo "  CamBot Health Check"
  echo "  ───────────────────"
  echo ""

  local issues=0

  # Installation
  echo "  Installation:"
  if [ -d "$AGENT_DIR/dist" ]; then
    check_ok "Agent installed at $AGENT_DIR"
  else
    check_fail "Agent not installed"
    issues=$((issues + 1))
  fi

  if [ -d "$UI_DIR" ]; then
    check_ok "UI installed at $UI_DIR"
  else
    check_warn "UI not installed"
  fi

  if [ -f "$CAMBOT_HOME/VERSION" ]; then
    check_ok "Version: $(head -1 "$CAMBOT_HOME/VERSION")"
  else
    check_warn "No version file found"
  fi

  # Configuration
  echo ""
  echo "  Configuration:"
  if [ -f "$AGENT_DIR/.env" ]; then
    check_ok ".env file exists"
    if grep -q '^ANTHROPIC_API_KEY=sk-' "$AGENT_DIR/.env" 2>/dev/null; then
      check_ok "Anthropic API key configured"
    else
      check_fail "Anthropic API key not set in .env"
      issues=$((issues + 1))
    fi
  else
    check_fail "No .env file found"
    issues=$((issues + 1))
  fi

  # Prerequisites
  echo ""
  echo "  Prerequisites:"
  for cmd in node bun docker gh uv; do
    if command -v "$cmd" &>/dev/null; then
      local ver
      case "$cmd" in
        node)   ver=$(node --version) ;;
        bun)    ver=$(bun --version) ;;
        docker) ver=$(docker --version 2>/dev/null | cut -d' ' -f3 | tr -d ',') ;;
        gh)     ver=$(gh --version 2>/dev/null | head -1 | awk '{print $3}') ;;
        uv)     ver=$(uv --version 2>/dev/null | awk '{print $2}') ;;
      esac
      check_ok "$cmd ($ver)"
    else
      check_fail "$cmd not found"
      issues=$((issues + 1))
    fi
  done

  # Docker
  echo ""
  echo "  Docker:"
  if docker info &>/dev/null 2>&1; then
    check_ok "Docker daemon running"
  else
    check_fail "Docker daemon not running"
    issues=$((issues + 1))
  fi

  if docker image inspect cambot-agent-claude:latest &>/dev/null 2>&1; then
    check_ok "Agent container image exists"
  else
    check_fail "Agent container image not built"
    issues=$((issues + 1))
  fi

  local containers
  containers=$(docker ps --filter "name=cambot-" --format '{{.Names}}' 2>/dev/null | wc -l | tr -d ' ')
  check_ok "$containers agent containers running"

  # Services
  echo ""
  echo "  Services:"
  if is_agent_running; then
    check_ok "Agent service running"
  else
    check_warn "Agent service not running"
  fi

  if is_ui_running; then
    check_ok "UI service running"
  else
    check_warn "UI service not running"
  fi

  # Runtime directories
  echo ""
  echo "  Data Directories:"
  for dir in store data groups logs; do
    if [ -d "$AGENT_DIR/$dir" ]; then
      check_ok "$dir/"
    else
      check_warn "$dir/ missing"
    fi
  done

  # GitHub auth
  echo ""
  echo "  GitHub:"
  if gh auth status &>/dev/null 2>&1; then
    check_ok "GitHub CLI authenticated"
  else
    check_fail "GitHub CLI not authenticated (updates will fail)"
    issues=$((issues + 1))
  fi

  # Network connectivity
  echo ""
  echo "  Network:"
  if curl -sf --connect-timeout 5 https://api.anthropic.com > /dev/null 2>&1; then
    check_ok "Anthropic API reachable"
  else
    check_warn "Cannot reach Anthropic API"
  fi

  # Summary
  echo ""
  if [ $issues -eq 0 ]; then
    echo -e "  ${GREEN}All checks passed!${NC}"
  else
    echo -e "  ${YELLOW}$issues issue(s) found${NC}"
  fi
  echo ""
}

show_version() {
  echo ""
  if [ -f "$CAMBOT_HOME/VERSION" ]; then
    cat "$CAMBOT_HOME/VERSION"
  else
    echo "  Version unknown (no VERSION file found)"
  fi
  echo ""
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

mkdir -p "$CAMBOT_HOME/logs" 2>/dev/null || true

COMMAND="${1:-help}"
shift || true

case "$COMMAND" in
  install)
    exec bash "$DEPLOY_DIR/install.sh" "$@"
    ;;
  update)
    exec bash "$DEPLOY_DIR/update.sh" "$@"
    ;;
  uninstall)
    exec bash "$DEPLOY_DIR/uninstall.sh" "$@"
    ;;
  start)
    TARGET="${1:-all}"
    echo ""
    case "$TARGET" in
      agent) start_agent ;;
      ui)    start_ui ;;
      all)   start_agent; start_ui ;;
      *)     fail "Unknown target: $TARGET. Use 'agent', 'ui', or 'all'" ;;
    esac
    echo ""
    ;;
  stop)
    TARGET="${1:-all}"
    echo ""
    case "$TARGET" in
      agent) stop_agent ;;
      ui)    stop_ui ;;
      all)   stop_ui; stop_agent ;;
      *)     fail "Unknown target: $TARGET. Use 'agent', 'ui', or 'all'" ;;
    esac
    echo ""
    ;;
  restart)
    TARGET="${1:-all}"
    echo ""
    case "$TARGET" in
      agent) stop_agent; start_agent ;;
      ui)    stop_ui; start_ui ;;
      all)   stop_ui; stop_agent; start_agent; start_ui ;;
      *)     fail "Unknown target: $TARGET. Use 'agent', 'ui', or 'all'" ;;
    esac
    echo ""
    ;;
  status)
    show_status
    ;;
  logs)
    show_logs "$@"
    ;;
  doctor)
    run_doctor
    ;;
  version)
    show_version
    ;;
  help|--help|-h)
    echo ""
    echo "cambot-ctl — CamBot management CLI"
    echo ""
    echo "Usage: cambot-ctl <command> [options]"
    echo ""
    echo "Commands:"
    echo "  install [--version TAG]      Install CamBot from GitHub Releases"
    echo "  update  [--version TAG]      Update to latest (or specific) release"
    echo "  uninstall [--purge]          Remove CamBot (--purge removes data too)"
    echo "  start [agent|ui|all]         Start services"
    echo "  stop [agent|ui|all]          Stop services"
    echo "  restart [agent|ui|all]       Restart services"
    echo "  status                       Show service status"
    echo "  logs [agent|ui] [-f]         View logs (-f to follow)"
    echo "  doctor                       Health check all components"
    echo "  version                      Show installed version"
    echo ""
    echo "Environment:"
    echo "  CAMBOT_HOME   Install directory (default: /opt/cambot)"
    echo "  UI_PORT       UI port (default: 3000)"
    echo ""
    ;;
  *)
    echo "Unknown command: $COMMAND"
    echo "Run 'cambot-ctl help' for usage"
    exit 1
    ;;
esac
