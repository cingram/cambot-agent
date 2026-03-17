#!/bin/bash
# ===========================================================================
# CamBot-Agent — Standalone Installer
# ===========================================================================
# Downloads and installs CamBot from GitHub Releases. No tarball needed.
#
# Quick install:
#   bash /opt/cambot/cambot-agent/deploy/install.sh
#
# Or run locally:
#   bash install.sh [--version v1.2.3] [--home /opt/cambot] [--no-service]
#
# Idempotent: running twice is safe. Never deletes user data.
# ===========================================================================

# Fix Windows line endings if present (self-heal for CRLF contamination)
# Note: uses printf instead of grep -P which macOS doesn't support
if [[ -f "${BASH_SOURCE[0]}" ]] && [[ "$(cat "${BASH_SOURCE[0]}")" == *$'\r'* ]]; then
  sed -i'' -e $'s/\r$//' "${BASH_SOURCE[0]}"
  exec bash "${BASH_SOURCE[0]}" "$@"
fi

set -eo pipefail

# ---------------------------------------------------------------------------
# Defaults & argument parsing
# ---------------------------------------------------------------------------
CAMBOT_HOME="${CAMBOT_HOME:-/opt/cambot}"
INSTALL_VERSION="latest"
INSTALL_SERVICE=true
GITHUB_OWNER="cingram"
GITHUB_REPO="cambot-agent"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)  INSTALL_VERSION="$2"; shift 2 ;;
    --home)     CAMBOT_HOME="$2"; shift 2 ;;
    --no-service) INSTALL_SERVICE=false; shift ;;
    --help|-h)
      echo "Usage: install.sh [--version v1.2.3] [--home /opt/cambot] [--no-service]"
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
# Banner
# ---------------------------------------------------------------------------
echo ""
echo "============================================"
echo "  CamBot-Agent Installer"
echo "============================================"
echo ""
info "Install path : $CAMBOT_HOME"
info "Version      : $INSTALL_VERSION"
info "Service      : $INSTALL_SERVICE"
echo ""

# ===========================================================================
# Step 1: Platform Detection
# ===========================================================================
step "Step 1/8: Platform Detection"

OS="$(uname -s)"
ARCH="$(uname -m)"
IS_WSL=false

case "$OS" in
  Darwin)
    PLATFORM="macos"
    ok "macOS detected ($ARCH)"
    ;;
  Linux)
    PLATFORM="linux"
    if grep -qi microsoft /proc/version 2>/dev/null; then
      IS_WSL=true
      warn "WSL detected — some features may need manual configuration"
    fi
    ok "Linux detected ($ARCH)"
    ;;
  *)
    fail "Unsupported OS: $OS. CamBot requires macOS or Linux."
    ;;
esac

case "$ARCH" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64)  ARCH="x64" ;;
  *) fail "Unsupported architecture: $ARCH" ;;
esac

# ===========================================================================
# Step 2: Prerequisites
# ===========================================================================
step "Step 2/8: Prerequisites"

install_homebrew() {
  if ! command -v brew &>/dev/null; then
    info "Installing Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    # Add brew to PATH for this session
    if [ -d /opt/homebrew ]; then
      eval "$(/opt/homebrew/bin/brew shellenv)"
    elif [ -d /home/linuxbrew ]; then
      eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
    fi
  else
    ok "Homebrew already installed"
  fi
}

install_node() {
  if command -v node &>/dev/null; then
    local NODE_VER
    NODE_VER=$(node --version | sed 's/v//' | cut -d. -f1)
    if [ "$NODE_VER" -ge 20 ]; then
      ok "Node.js $(node --version) already installed"
      return
    fi
    warn "Node.js v${NODE_VER} is too old, installing v22..."
  else
    info "Installing Node.js v22..."
  fi

  if [ "$PLATFORM" = "macos" ]; then
    brew install node@22
  else
    # Use NodeSource for Linux
    if command -v apt-get &>/dev/null; then
      curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
      sudo apt-get install -y nodejs
    elif command -v dnf &>/dev/null; then
      curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
      sudo dnf install -y nodejs
    else
      fail "Could not install Node.js — install Node.js 22+ manually and re-run"
    fi
  fi
}

install_bun() {
  if command -v bun &>/dev/null; then
    ok "Bun $(bun --version) already installed"
  else
    info "Installing Bun..."
    if [ "$PLATFORM" = "macos" ]; then
      brew install oven-sh/bun/bun
    else
      curl -fsSL https://bun.sh/install | bash
      export PATH="$HOME/.bun/bin:$PATH"
    fi
  fi
}

install_docker() {
  if command -v docker &>/dev/null; then
    if docker info &>/dev/null 2>&1; then
      ok "Docker $(docker --version | cut -d' ' -f3 | tr -d ',') is running"
      return
    fi
    warn "Docker is installed but not running."
    if [ "$PLATFORM" = "macos" ]; then
      open -a Docker 2>/dev/null || true
    fi
    fail "Start Docker and re-run this script."
  fi

  info "Installing Docker..."
  if [ "$PLATFORM" = "macos" ]; then
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
    # Linux: install via convenience script
    curl -fsSL https://get.docker.com | sudo sh
    sudo usermod -aG docker "$USER"
    warn "Docker installed. You may need to log out and back in for group changes."
    warn "Then re-run this script."
    fail "Re-run after Docker group is active (log out/in)."
  fi
}

install_uv() {
  if command -v uv &>/dev/null; then
    ok "uv already installed"
  else
    info "Installing uv (Python package manager)..."
    if [ "$PLATFORM" = "macos" ]; then
      brew install uv
    else
      curl -LsSf https://astral.sh/uv/install.sh | sh
      export PATH="$HOME/.local/bin:$PATH"
    fi
  fi
}

install_gh() {
  if command -v gh &>/dev/null; then
    ok "GitHub CLI already installed"
  else
    info "Installing GitHub CLI..."
    if [ "$PLATFORM" = "macos" ]; then
      brew install gh
    elif command -v apt-get &>/dev/null; then
      (type -p wget >/dev/null || sudo apt-get install wget -y) \
        && sudo mkdir -p -m 755 /etc/apt/keyrings \
        && out=$(mktemp) \
        && wget -nv -O"$out" https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        && cat "$out" | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
        && sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
        && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
        && sudo apt-get update \
        && sudo apt-get install gh -y
    elif command -v dnf &>/dev/null; then
      sudo dnf install gh -y
    else
      fail "Could not install GitHub CLI — install it manually: https://cli.github.com"
    fi
  fi
}

install_claude_code() {
  if command -v claude &>/dev/null; then
    ok "Claude Code already installed"
  else
    info "Installing Claude Code..."
    npm install -g @anthropic-ai/claude-code
  fi

  # Check for existing credentials
  CREDS_FILE="$HOME/.claude/.credentials.json"
  if [ -f "$CREDS_FILE" ] && grep -q "accessToken" "$CREDS_FILE" 2>/dev/null; then
    ok "Claude Code OAuth credentials found"
  else
    warn "No Claude Code credentials found. Starting login..."
    echo ""
    echo "  A browser window should open for Anthropic OAuth login."
    echo "  If no browser opens, copy the URL printed below into any browser."
    echo ""
    claude auth login 2>&1 || true
    # Re-check
    if [ -f "$CREDS_FILE" ] && grep -q "accessToken" "$CREDS_FILE" 2>/dev/null; then
      ok "Claude Code authenticated"
    else
      warn "Claude Code authentication not completed."
      warn "Run 'claude' manually after install to authenticate."
    fi
  fi
}

install_build_tools() {
  if [ "$PLATFORM" = "macos" ]; then
    if ! xcode-select -p &>/dev/null; then
      info "Installing Xcode command line tools..."
      xcode-select --install 2>/dev/null || true
      warn "Accept the Xcode license and re-run if needed."
    else
      ok "Xcode CLI tools installed"
    fi
  else
    if command -v apt-get &>/dev/null; then
      if ! dpkg -s build-essential &>/dev/null 2>&1; then
        info "Installing build-essential..."
        sudo apt-get update && sudo apt-get install -y build-essential python3
      else
        ok "Build tools installed"
      fi
    fi
  fi
}

# Install prerequisites in order
if [ "$PLATFORM" = "macos" ]; then
  install_homebrew
fi
install_build_tools
install_node
install_bun
install_docker
install_uv
install_gh
install_claude_code

# Verify gh authentication
step "Step 2b/8: GitHub Authentication"
if ! gh auth status &>/dev/null 2>&1; then
  warn "GitHub CLI is not authenticated."
  warn "Private repos require authentication. Run:"
  echo ""
  echo "    gh auth login"
  echo ""
  echo "  Then re-run this installer."
  fail "GitHub CLI authentication required."
else
  ok "GitHub CLI authenticated"
fi

# ===========================================================================
# Step 3: Download Release
# ===========================================================================
step "Step 3/8: Download Release"

DOWNLOAD_DIR="$(mktemp -d)"
trap 'rm -rf "$DOWNLOAD_DIR"' EXIT

if [ "$INSTALL_VERSION" = "latest" ]; then
  info "Fetching latest release..."
  INSTALL_VERSION=$(gh release view --repo "$GITHUB_OWNER/$GITHUB_REPO" --json tagName -q '.tagName')
  ok "Latest release: $INSTALL_VERSION"
fi

info "Downloading $INSTALL_VERSION artifacts..."
gh release download "$INSTALL_VERSION" \
  --repo "$GITHUB_OWNER/$GITHUB_REPO" \
  --dir "$DOWNLOAD_DIR" \
  --pattern "cambot-agent-*.tar.gz" \
  --pattern "cambot-ui-*.tar.gz"

AGENT_ARCHIVE=$(ls "$DOWNLOAD_DIR"/cambot-agent-*.tar.gz 2>/dev/null | head -1)
UI_ARCHIVE=$(ls "$DOWNLOAD_DIR"/cambot-ui-*.tar.gz 2>/dev/null | head -1)

[ -f "$AGENT_ARCHIVE" ] || fail "Agent artifact not found in release $INSTALL_VERSION"
ok "Downloaded agent artifact ($(du -h "$AGENT_ARCHIVE" | cut -f1))"

if [ -f "$UI_ARCHIVE" ]; then
  ok "Downloaded UI artifact ($(du -h "$UI_ARCHIVE" | cut -f1))"
else
  warn "UI artifact not found — skipping UI installation"
fi

# ===========================================================================
# Step 4: Install Application
# ===========================================================================
step "Step 4/8: Install Application"

if [ -d "$AGENT_DIR/dist" ]; then
  warn "Existing installation detected at $CAMBOT_HOME"
  info "Application files will be updated (data is preserved)."
fi

sudo mkdir -p "$CAMBOT_HOME"
sudo chown -R "$(whoami)" "$CAMBOT_HOME"

# Extract agent artifact (preserving existing store/, groups/, .env, data/)
info "Extracting agent artifact..."
EXTRACT_DIR="$(mktemp -d)"

tar xzf "$AGENT_ARCHIVE" -C "$EXTRACT_DIR"

# Copy library packages
for pkg in cambot-integrations cambot-core cambot-channels cambot-workflows cambot-llm; do
  if [ -d "$EXTRACT_DIR/$pkg" ]; then
    rm -rf "$CAMBOT_HOME/$pkg/dist"
    mkdir -p "$CAMBOT_HOME/$pkg"
    cp -r "$EXTRACT_DIR/$pkg/." "$CAMBOT_HOME/$pkg/"
  fi
done

# Copy cambot-agent (preserve runtime data directories)
if [ -d "$EXTRACT_DIR/cambot-agent" ]; then
  # Remove old dist but keep store/, data/, groups/, logs/, .env
  rm -rf "$AGENT_DIR/dist"
  rm -rf "$AGENT_DIR/container"
  rm -rf "$AGENT_DIR/agent-runner/src" "$AGENT_DIR/agent-runner/dist"

  # Create agent dir if needed
  mkdir -p "$AGENT_DIR"
  mkdir -p "$AGENT_DIR/agent-runner"

  # Copy new files (rsync-like behavior with cp)
  cp -r "$EXTRACT_DIR/cambot-agent/dist" "$AGENT_DIR/dist"
  cp "$EXTRACT_DIR/cambot-agent/package.json" "$AGENT_DIR/package.json"
  [ -f "$EXTRACT_DIR/cambot-agent/tsconfig.json" ] && \
    cp "$EXTRACT_DIR/cambot-agent/tsconfig.json" "$AGENT_DIR/tsconfig.json"
  [ -f "$EXTRACT_DIR/cambot-agent/agents.yaml" ] && \
    cp "$EXTRACT_DIR/cambot-agent/agents.yaml" "$AGENT_DIR/agents.yaml"
  [ -f "$EXTRACT_DIR/cambot-agent/.env.example" ] && \
    cp "$EXTRACT_DIR/cambot-agent/.env.example" "$AGENT_DIR/.env.example"

  cp -r "$EXTRACT_DIR/cambot-agent/container" "$AGENT_DIR/container"
  cp -r "$EXTRACT_DIR/cambot-agent/agent-runner/." "$AGENT_DIR/agent-runner/"

  # Deploy scripts
  [ -d "$EXTRACT_DIR/cambot-agent/deploy" ] && \
    cp -r "$EXTRACT_DIR/cambot-agent/deploy" "$AGENT_DIR/deploy"
fi

# Version stamp
[ -f "$EXTRACT_DIR/VERSION" ] && cp "$EXTRACT_DIR/VERSION" "$CAMBOT_HOME/"

# Extract UI artifact
if [ -f "$UI_ARCHIVE" ]; then
  info "Extracting UI artifact..."
  rm -rf "$UI_DIR"
  mkdir -p "$UI_DIR"
  tar xzf "$UI_ARCHIVE" -C "$CAMBOT_HOME"
fi

rm -rf "$EXTRACT_DIR"
ok "Application files installed to $CAMBOT_HOME"

# ===========================================================================
# Step 5: Install Dependencies
# ===========================================================================
step "Step 5/8: Install Dependencies"

for pkg in cambot-integrations cambot-channels cambot-core cambot-workflows cambot-llm cambot-agent; do
  if [ -d "$CAMBOT_HOME/$pkg" ] && [ -f "$CAMBOT_HOME/$pkg/package.json" ]; then
    info "Installing dependencies for $pkg..."
    # Remove stale lockfiles — release artifacts don't ship them but previous installs may have left them
    rm -f "$CAMBOT_HOME/$pkg/bun.lock" "$CAMBOT_HOME/$pkg/bun.lockb"
    (cd "$CAMBOT_HOME/$pkg" && bun install --production 2>&1 | tail -1)
  fi
done

# Reinstall native modules for the current platform (CI builds on Linux x64)
if [ -d "$UI_DIR/node_modules/better-sqlite3" ]; then
  info "Installing native modules for $(uname -s) $(uname -m)..."
  (cd "$UI_DIR" && npm install better-sqlite3 2>&1 | tail -1)
fi

ok "All dependencies installed"

# Seed database with agent definitions, tasks, and configuration
if [ -f "$AGENT_DIR/seed/db-seed.json" ]; then
  DB_FILE="$AGENT_DIR/store/cambot.sqlite"
  mkdir -p "$(dirname "$DB_FILE")"
  if [ -f "$DB_FILE" ]; then
    info "Importing seed data (agents, tasks, groups)..."
    (cd "$AGENT_DIR" && node scripts/import-seed.mjs \
      --db "$DB_FILE" \
      --seed seed/db-seed.json)
    ok "Seed data imported"
  else
    warn "Database not yet created — run start.sh once, then re-run install.sh to seed agents"
  fi
fi

# ===========================================================================
# Step 6: Build Agent Container
# ===========================================================================
step "Step 6/8: Build Agent Container"

info "Building cambot-agent-claude Docker image (this takes a few minutes)..."
(cd "$AGENT_DIR/container" && bash build.sh)
ok "Agent container image built"

# ===========================================================================
# Step 7: Configure
# ===========================================================================
step "Step 7/8: Configuration"

# Create runtime directories
mkdir -p "$AGENT_DIR/store"
mkdir -p "$AGENT_DIR/data/workflows"
mkdir -p "$AGENT_DIR/data/ipc"
mkdir -p "$AGENT_DIR/data/sessions"
mkdir -p "$AGENT_DIR/data/logs"
mkdir -p "$AGENT_DIR/groups/main"
mkdir -p "$AGENT_DIR/logs"
mkdir -p "$CAMBOT_HOME/logs"

# Mount allowlist (security config)
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

# Create .env from template if not exists
ENV_FILE="$AGENT_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
  if [ -f "$AGENT_DIR/.env.example" ]; then
    cp "$AGENT_DIR/.env.example" "$ENV_FILE"
  fi

  # Auto-generate CAMBOT_UI_SECRET
  UI_SECRET=$(openssl rand -hex 32)
  if grep -q '^CAMBOT_UI_SECRET=' "$ENV_FILE" 2>/dev/null; then
    sed -i.bak "s/^CAMBOT_UI_SECRET=.*/CAMBOT_UI_SECRET=$UI_SECRET/" "$ENV_FILE"
    rm -f "$ENV_FILE.bak"
  else
    echo "CAMBOT_UI_SECRET=$UI_SECRET" >> "$ENV_FILE"
  fi

  # Prompt for Anthropic API key
  echo ""
  echo "  Enter your Anthropic API key (or press Enter to skip):"
  echo -n "  ANTHROPIC_API_KEY="
  read -r API_KEY
  if [ -n "$API_KEY" ]; then
    sed -i.bak "s/^ANTHROPIC_API_KEY=.*/ANTHROPIC_API_KEY=$API_KEY/" "$ENV_FILE"
    rm -f "$ENV_FILE.bak"
    ok "API key saved"
  else
    warn "Skipped — edit $ENV_FILE before starting"
  fi

  ok "Created $ENV_FILE from template"
else
  ok ".env file already exists (preserved)"
fi

# Create/update UI .env (always — UI needs DB path, secret, and auth token from agent)
if [ -d "$UI_DIR" ]; then
  UI_ENV="$UI_DIR/.env"
  # Read CAMBOT_UI_SECRET from agent .env (or use default)
  UI_SECRET=$(grep '^CAMBOT_UI_SECRET=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || echo "0218")
  # Read WEB_AUTH_TOKEN — agent auto-generates this on first run and writes to store/web-auth-token
  WEB_AUTH_TOKEN=""
  if [ -f "$AGENT_DIR/store/web-auth-token" ]; then
    WEB_AUTH_TOKEN=$(cat "$AGENT_DIR/store/web-auth-token")
  elif grep -q '^WEB_AUTH_TOKEN=' "$ENV_FILE" 2>/dev/null; then
    WEB_AUTH_TOKEN=$(grep '^WEB_AUTH_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
  fi
  cat > "$UI_ENV" <<UIENV
CAMBOT_DB_PATH=${AGENT_DIR}/store/cambot.sqlite
CAMBOT_UI_SECRET=${UI_SECRET}
CAMBOT_WEB_AUTH_TOKEN=${WEB_AUTH_TOKEN}
CAMBOT_WEB_CHANNEL_URL=http://localhost:3100
UIENV
  if [ -n "$WEB_AUTH_TOKEN" ]; then
    ok "Created $UI_ENV (DB path + secret + auth token synced)"
  else
    warn "Created $UI_ENV — WEB_AUTH_TOKEN not yet available."
    warn "Start the agent once, then re-run install or manually add:"
    warn "  echo \"CAMBOT_WEB_AUTH_TOKEN=\$(cat $AGENT_DIR/store/web-auth-token)\" >> $UI_ENV"
  fi
fi

ok "Runtime directories and configuration ready"

# ===========================================================================
# Step 8: Install Service
# ===========================================================================
step "Step 8/8: System Service"

if ! $INSTALL_SERVICE; then
  info "Skipping service installation (--no-service)"
else
  if [ "$PLATFORM" = "macos" ]; then
    NODE_PATH="$(which node)"
    USER_HOME="$HOME"

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

  elif [ "$PLATFORM" = "linux" ]; then
    NODE_PATH="$(which node)"

    # Agent service
    sudo tee /etc/systemd/system/cambot-agent.service > /dev/null <<UNIT
[Unit]
Description=CamBot Agent
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=${AGENT_DIR}
ExecStart=${NODE_PATH} ${AGENT_DIR}/dist/main.js
Restart=always
RestartSec=10
Environment=HOME=${HOME}
Environment=PATH=${HOME}/.local/bin:${HOME}/.bun/bin:/usr/local/bin:/usr/bin:/bin
StandardOutput=append:${AGENT_DIR}/logs/cambot-agent.log
StandardError=append:${AGENT_DIR}/logs/cambot-agent.error.log

[Install]
WantedBy=multi-user.target
UNIT

    # UI service
    if [ -d "$UI_DIR" ]; then
      sudo tee /etc/systemd/system/cambot-ui.service > /dev/null <<UNIT
[Unit]
Description=CamBot UI
After=network.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=${UI_DIR}
ExecStart=${NODE_PATH} ${UI_DIR}/server.js
Restart=always
RestartSec=10
Environment=HOME=${HOME}
Environment=PORT=3000
StandardOutput=append:${CAMBOT_HOME}/logs/cambot-ui.log
StandardError=append:${CAMBOT_HOME}/logs/cambot-ui.error.log

[Install]
WantedBy=multi-user.target
UNIT
    fi

    sudo systemctl daemon-reload
    ok "Systemd services installed"
  fi
fi

# ===========================================================================
# Summary
# ===========================================================================
echo ""
echo "============================================"
echo "  Installation Complete!"
echo "============================================"
echo ""
echo "  Version    : $INSTALL_VERSION"
echo "  Install    : $CAMBOT_HOME"
echo "  Agent      : $AGENT_DIR"
echo "  UI         : $UI_DIR"
echo "  Config     : $AGENT_DIR/.env"
echo "  Logs       : $AGENT_DIR/logs/"
echo ""

echo "  Next steps:"
echo ""
echo "    1. Edit your config (if not done):"
echo "       \$EDITOR $AGENT_DIR/.env"
echo ""
echo "    2. Start everything:"
echo "       bash $AGENT_DIR/deploy/start.sh"
echo ""
echo "    3. Check status:"
echo "       bash $AGENT_DIR/deploy/start.sh status"
echo ""
echo "  Other commands:"
echo "    Stop all : bash $AGENT_DIR/deploy/start.sh stop"
echo "    Agent    : bash $AGENT_DIR/deploy/start.sh agent"
echo "    UI       : bash $AGENT_DIR/deploy/start.sh ui"
echo "    Bridge   : bash $AGENT_DIR/deploy/start.sh bridge"
echo "    Logs     : tail -f $AGENT_DIR/logs/cambot-agent.log"
echo ""
if command -v cambot-ctl &>/dev/null; then
  echo "  Or use cambot-ctl:"
  echo "    cambot-ctl start    cambot-ctl stop    cambot-ctl status"
fi
echo ""
