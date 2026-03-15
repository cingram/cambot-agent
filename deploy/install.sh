#!/bin/bash
# ===========================================================================
# CamBot-Agent — Mac Mini Installer
# ===========================================================================
# Run this on the Mac Mini after extracting the deploy tarball.
#
# What it does:
#   1. Installs prerequisites (Homebrew, Bun, Docker, uv)
#   2. Copies the application to /opt/cambot
#   3. Installs native dependencies (better-sqlite3 etc.)
#   4. Builds the ephemeral agent container image
#   5. Creates runtime directories
#   6. Installs launchd service (auto-start on login)
#
# Usage:
#   bash install.sh                     # Interactive (asks questions)
#   CAMBOT_HOME=/opt/cambot bash install.sh  # Override install path
#
# Prerequisites: macOS with admin access
# ===========================================================================
set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
CAMBOT_HOME="${CAMBOT_HOME:-/opt/cambot}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$SCRIPT_DIR/cambot"
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

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------
echo ""
echo "============================================"
echo "  CamBot-Agent Installer for macOS"
echo "============================================"
echo ""

[ "$(uname)" = "Darwin" ] || fail "This installer is for macOS only."

if [ ! -d "$SOURCE_DIR" ]; then
  fail "Source directory not found: $SOURCE_DIR"
  echo "  Make sure you extracted the deploy tarball first."
fi

if [ -f "$SOURCE_DIR/VERSION" ]; then
  info "Package: $(cat "$SOURCE_DIR/VERSION" | head -1)"
fi

echo ""
info "Install path: $CAMBOT_HOME"
echo ""

# ---------------------------------------------------------------------------
# 1. Install prerequisites via Homebrew
# ---------------------------------------------------------------------------
echo "── Step 1/7: Prerequisites ──────────────────────────────────"

# Homebrew
if ! command -v brew &>/dev/null; then
  info "Installing Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # Add brew to PATH for this session (Apple Silicon default)
  eval "$(/opt/homebrew/bin/brew shellenv)"
else
  ok "Homebrew already installed"
fi

# Bun
if ! command -v bun &>/dev/null; then
  info "Installing Bun..."
  brew install oven-sh/bun/bun
else
  ok "Bun $(bun --version) already installed"
fi

# Node.js (needed for running the agent — Bun has rough edges with some native modules)
if ! command -v node &>/dev/null; then
  info "Installing Node.js..."
  brew install node@22
else
  NODE_VER=$(node --version | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VER" -lt 20 ]; then
    warn "Node.js v${NODE_VER} is too old, installing v22..."
    brew install node@22
  else
    ok "Node.js $(node --version) already installed"
  fi
fi

# Docker Desktop
if ! command -v docker &>/dev/null; then
  info "Installing Docker Desktop..."
  brew install --cask docker
  echo ""
  warn "Docker Desktop installed. Please:"
  warn "  1. Open Docker Desktop from Applications"
  warn "  2. Complete the setup wizard"
  warn "  3. Re-run this installer once Docker is running"
  echo ""
  echo "  Open Docker now? (y/n)"
  read -r ans
  if [ "$ans" = "y" ] || [ "$ans" = "Y" ]; then
    open -a Docker
  fi
  fail "Re-run this script after Docker Desktop is running."
else
  # Check Docker is actually running
  if ! docker info &>/dev/null 2>&1; then
    warn "Docker is installed but not running."
    warn "Start Docker Desktop and re-run this script."
    open -a Docker 2>/dev/null || true
    fail "Docker must be running to continue."
  fi
  ok "Docker $(docker --version | cut -d' ' -f3 | tr -d ',') is running"
fi

# uv (Python — needed for workspace-mcp / Google integration)
if ! command -v uv &>/dev/null; then
  info "Installing uv (Python package manager)..."
  brew install uv
else
  ok "uv already installed"
fi

# ---------------------------------------------------------------------------
# 2. Create install directory
# ---------------------------------------------------------------------------
echo ""
echo "── Step 2/7: Install Application ────────────────────────────"

if [ -d "$CAMBOT_HOME/cambot-agent/dist" ]; then
  warn "Existing installation detected at $CAMBOT_HOME"
  echo "  This will update the application files (data is preserved)."
  echo "  Continue? (y/n)"
  read -r ans
  [ "$ans" = "y" ] || [ "$ans" = "Y" ] || fail "Cancelled."
fi

sudo mkdir -p "$CAMBOT_HOME"
sudo chown -R "$(whoami)" "$CAMBOT_HOME"

# Copy application packages (preserving structure)
info "Copying application files..."
for pkg in cambot-integrations cambot-core cambot-workflows cambot-channels cambot-llm cambot-agent; do
  if [ -d "$SOURCE_DIR/$pkg" ]; then
    # Remove old dist but preserve runtime data
    rm -rf "$CAMBOT_HOME/$pkg/dist"
    mkdir -p "$CAMBOT_HOME/$pkg"
    # Copy everything from source, preserving existing data dirs
    cp -r "$SOURCE_DIR/$pkg/." "$CAMBOT_HOME/$pkg/"
  fi
done

# Copy Docker assets for UI (optional)
[ -f "$SOURCE_DIR/docker-compose.yml" ] && cp "$SOURCE_DIR/docker-compose.yml" "$CAMBOT_HOME/"
[ -d "$SOURCE_DIR/docker" ] && cp -r "$SOURCE_DIR/docker" "$CAMBOT_HOME/"
[ -d "$SOURCE_DIR/cambot-core-ui" ] && cp -r "$SOURCE_DIR/cambot-core-ui" "$CAMBOT_HOME/"

# Copy version stamp
[ -f "$SOURCE_DIR/VERSION" ] && cp "$SOURCE_DIR/VERSION" "$CAMBOT_HOME/"

ok "Application files installed to $CAMBOT_HOME"

# ---------------------------------------------------------------------------
# 3. Install native dependencies
# ---------------------------------------------------------------------------
echo ""
echo "── Step 3/7: Install Dependencies ───────────────────────────"

# Install in dependency order (leaf packages first)
for pkg in cambot-integrations cambot-channels cambot-core cambot-workflows cambot-llm cambot-agent; do
  info "Installing dependencies for $pkg..."
  (cd "$CAMBOT_HOME/$pkg" && bun install --production 2>&1 | tail -1)
done

ok "All dependencies installed"

# ---------------------------------------------------------------------------
# 4. Create runtime directories
# ---------------------------------------------------------------------------
echo ""
echo "── Step 4/7: Runtime Directories ────────────────────────────"

AGENT_DIR="$CAMBOT_HOME/cambot-agent"
mkdir -p "$AGENT_DIR/store"
mkdir -p "$AGENT_DIR/data/workflows"
mkdir -p "$AGENT_DIR/data/ipc"
mkdir -p "$AGENT_DIR/data/sessions"
mkdir -p "$AGENT_DIR/data/logs"
mkdir -p "$AGENT_DIR/groups/main"
mkdir -p "$AGENT_DIR/logs"

# Mount allowlist (security config — outside project root)
MOUNT_ALLOWLIST="$HOME/.config/cambot-agent/mount-allowlist.json"
if [ ! -f "$MOUNT_ALLOWLIST" ]; then
  mkdir -p "$(dirname "$MOUNT_ALLOWLIST")"
  cat > "$MOUNT_ALLOWLIST" <<'ALLOWLIST'
{
  "allowedRoots": [],
  "blockedPatterns": [],
  "nonMainReadOnly": true
}
ALLOWLIST
  ok "Created mount allowlist at $MOUNT_ALLOWLIST"
fi

ok "Runtime directories created"

# ---------------------------------------------------------------------------
# 5. Build ephemeral agent container image
# ---------------------------------------------------------------------------
echo ""
echo "── Step 5/7: Build Agent Container ──────────────────────────"

info "Building cambot-agent-claude Docker image (this takes a few minutes)..."
(cd "$AGENT_DIR/container" && bash build.sh)

ok "Agent container image built"

# ---------------------------------------------------------------------------
# 6. Configure environment
# ---------------------------------------------------------------------------
echo ""
echo "── Step 6/7: Configuration ──────────────────────────────────"

ENV_FILE="$AGENT_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
  cp "$AGENT_DIR/.env.example" "$ENV_FILE"
  warn "Created $ENV_FILE from template."
  echo ""
  echo "  You MUST edit this file to set your API keys:"
  echo "    $ENV_FILE"
  echo ""
  echo "  At minimum, set:"
  echo "    ANTHROPIC_API_KEY=sk-ant-..."
  echo "    CHANNELS=cli,web"
  echo ""
else
  ok ".env file already exists (preserved)"
fi

# ---------------------------------------------------------------------------
# 7. Install launchd service
# ---------------------------------------------------------------------------
echo ""
echo "── Step 7/7: System Service ─────────────────────────────────"

NODE_PATH="$(which node)"
BUN_PATH="$(which bun)"
USER_HOME="$HOME"

# Generate the plist with resolved paths
mkdir -p "$(dirname "$PLIST_PATH")"
cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_PATH}</string>
        <string>${AGENT_DIR}/dist/main.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${AGENT_DIR}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${USER_HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>${USER_HOME}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${AGENT_DIR}/logs/cambot-agent.log</string>
    <key>StandardErrorPath</key>
    <string>${AGENT_DIR}/logs/cambot-agent.error.log</string>
    <key>ThrottleInterval</key>
    <integer>10</integer>
</dict>
</plist>
PLIST

ok "Launchd service installed at $PLIST_PATH"

echo ""
echo "============================================"
echo "  Installation Complete!"
echo "============================================"
echo ""
echo "  Install path : $CAMBOT_HOME"
echo "  Agent dir    : $AGENT_DIR"
echo "  Config       : $AGENT_DIR/.env"
echo "  Logs         : $AGENT_DIR/logs/"
echo "  Service      : $PLIST_PATH"
echo ""
echo "  Next steps:"
echo "    1. Edit $AGENT_DIR/.env with your API keys"
echo "    2. Start the service:"
echo "       launchctl load $PLIST_PATH"
echo ""
echo "    Or run manually first to test:"
echo "       cd $AGENT_DIR && node dist/main.js"
echo ""
echo "  Service commands:"
echo "    Start   : launchctl load $PLIST_PATH"
echo "    Stop    : launchctl unload $PLIST_PATH"
echo "    Restart : launchctl kickstart -k gui/\$(id -u)/$PLIST_LABEL"
echo "    Logs    : tail -f $AGENT_DIR/logs/cambot-agent.log"
echo ""
