#!/bin/bash
# ===========================================================================
# CamBot-Agent — Build Deployment Package
# ===========================================================================
# Run this on the development machine (Windows/macOS/Linux).
# Produces a self-contained tarball for deployment to a Mac Mini.
#
# Usage:
#   bash scripts/package-deploy.sh [version]
#
# Output:
#   cambot-deploy-<version>.tar.gz   (in the monorepo root)
# ===========================================================================
set -euo pipefail

VERSION="${1:-$(date +%Y%m%d-%H%M%S)}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MONO_ROOT="$(cd "$AGENT_ROOT/.." && pwd)"
STAGE_DIR="$MONO_ROOT/.deploy-stage"
ARCHIVE="$MONO_ROOT/cambot-deploy-${VERSION}.tar.gz"

echo "=== CamBot Deploy Packager ==="
echo "  Version : $VERSION"
echo "  Mono    : $MONO_ROOT"
echo "  Output  : $ARCHIVE"
echo ""

# ---------------------------------------------------------------------------
# 1. Build all TypeScript packages (dependency order)
# ---------------------------------------------------------------------------
echo "[1/5] Building TypeScript packages..."

PACKAGES=(cambot-integrations cambot-core cambot-workflows cambot-channels cambot-llm)
for pkg in "${PACKAGES[@]}"; do
  echo "  Building $pkg..."
  (cd "$MONO_ROOT/$pkg" && bun run build)
done

echo "  Building cambot-agent..."
(cd "$AGENT_ROOT" && bun run build)

echo "  Building agent-runner..."
(cd "$AGENT_ROOT/agent-runner" && bun run build)

# ---------------------------------------------------------------------------
# 2. Prepare staging directory
# ---------------------------------------------------------------------------
echo "[2/5] Staging files..."

rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR/cambot"

# Copy deploy scripts into tarball root
cp "$AGENT_ROOT/deploy/install.sh"   "$STAGE_DIR/install.sh"
cp "$AGENT_ROOT/deploy/update.sh"    "$STAGE_DIR/update.sh"
cp "$AGENT_ROOT/deploy/uninstall.sh" "$STAGE_DIR/uninstall.sh"
chmod +x "$STAGE_DIR"/*.sh

# ---------------------------------------------------------------------------
# 3. Copy each package (dist + package.json + tsconfig.json, no node_modules)
# ---------------------------------------------------------------------------
echo "[3/5] Copying packages..."

copy_package() {
  local name="$1"
  local src="$MONO_ROOT/$name"
  local dst="$STAGE_DIR/cambot/$name"
  mkdir -p "$dst"

  # Core files
  cp "$src/package.json" "$dst/"
  [ -f "$src/tsconfig.json" ] && cp "$src/tsconfig.json" "$dst/"
  [ -f "$src/bun.lock" ]      && cp "$src/bun.lock" "$dst/"

  # Compiled output
  if [ -d "$src/dist" ]; then
    cp -r "$src/dist" "$dst/dist"
  fi
}

for pkg in "${PACKAGES[@]}"; do
  copy_package "$pkg"
done

# cambot-agent: dist + source assets that stay on host
DST_AGENT="$STAGE_DIR/cambot/cambot-agent"
mkdir -p "$DST_AGENT"
cp "$AGENT_ROOT/package.json"   "$DST_AGENT/"
cp "$AGENT_ROOT/tsconfig.json"  "$DST_AGENT/"
[ -f "$AGENT_ROOT/bun.lock" ] && cp "$AGENT_ROOT/bun.lock" "$DST_AGENT/"
cp -r "$AGENT_ROOT/dist"       "$DST_AGENT/dist"

# agents.yaml (config)
[ -f "$AGENT_ROOT/agents.yaml" ] && cp "$AGENT_ROOT/agents.yaml" "$DST_AGENT/"

# Container directory (Dockerfile, entrypoint, skills, mcp config)
cp -r "$AGENT_ROOT/container" "$DST_AGENT/container"
# Remove build context copies that build.sh creates temporarily
rm -rf "$DST_AGENT/container/cambot-llm"
rm -rf "$DST_AGENT/container/cambot-agent-runner"

# Agent-runner (full source — mounted into ephemeral containers)
mkdir -p "$DST_AGENT/agent-runner"
cp "$AGENT_ROOT/agent-runner/package.json"  "$DST_AGENT/agent-runner/"
cp "$AGENT_ROOT/agent-runner/tsconfig.json" "$DST_AGENT/agent-runner/"
cp -r "$AGENT_ROOT/agent-runner/src"        "$DST_AGENT/agent-runner/src"
# Remove test files from agent-runner source
find "$DST_AGENT/agent-runner/src" -name '*.test.ts' -delete 2>/dev/null || true
# Pre-built dist for agent-runner
if [ -d "$AGENT_ROOT/agent-runner/dist" ]; then
  cp -r "$AGENT_ROOT/agent-runner/dist" "$DST_AGENT/agent-runner/dist"
fi

# Launchd template
[ -d "$AGENT_ROOT/launchd" ] && cp -r "$AGENT_ROOT/launchd" "$DST_AGENT/launchd"

# Deploy scripts (for reference inside install tree)
cp -r "$AGENT_ROOT/deploy" "$DST_AGENT/deploy"

# .env example
cp "$AGENT_ROOT/.env.example" "$DST_AGENT/.env.example"

# cambot-llm: full source needed by ephemeral containers
DST_LLM="$STAGE_DIR/cambot/cambot-llm"
mkdir -p "$DST_LLM"
cp "$MONO_ROOT/cambot-llm/package.json"  "$DST_LLM/"
cp "$MONO_ROOT/cambot-llm/tsconfig.json" "$DST_LLM/"
cp -r "$MONO_ROOT/cambot-llm/src"        "$DST_LLM/src"
if [ -d "$MONO_ROOT/cambot-llm/dist" ]; then
  cp -r "$MONO_ROOT/cambot-llm/dist" "$DST_LLM/dist"
fi

# cambot-core-ui: copy source for Docker build on target
if [ -d "$MONO_ROOT/cambot-core-ui" ]; then
  DST_UI="$STAGE_DIR/cambot/cambot-core-ui"
  mkdir -p "$DST_UI"
  # Copy everything except node_modules, .next, and other build artifacts
  rsync -a \
    --exclude='node_modules' \
    --exclude='.next' \
    --exclude='.turbo' \
    "$MONO_ROOT/cambot-core-ui/" "$DST_UI/" 2>/dev/null \
  || (
    # Fallback if rsync not available (Windows Git Bash)
    cp -r "$MONO_ROOT/cambot-core-ui" "$DST_UI.tmp"
    rm -rf "$DST_UI.tmp/node_modules" "$DST_UI.tmp/.next" "$DST_UI.tmp/.turbo"
    rm -rf "$DST_UI"
    mv "$DST_UI.tmp" "$DST_UI"
  )
fi

# Docker compose and Dockerfiles for UI
[ -f "$MONO_ROOT/docker-compose.yml" ] && cp "$MONO_ROOT/docker-compose.yml" "$STAGE_DIR/cambot/"
[ -d "$MONO_ROOT/docker" ] && cp -r "$MONO_ROOT/docker" "$STAGE_DIR/cambot/docker"

# ---------------------------------------------------------------------------
# 4. Write version stamp
# ---------------------------------------------------------------------------
echo "[4/5] Writing version stamp..."
cat > "$STAGE_DIR/cambot/VERSION" <<EOF
version: $VERSION
built: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
host: $(hostname)
EOF

# ---------------------------------------------------------------------------
# 5. Create archive
# ---------------------------------------------------------------------------
echo "[5/5] Creating archive..."
(cd "$STAGE_DIR" && tar czf "$ARCHIVE" .)

# Cleanup
rm -rf "$STAGE_DIR"

SIZE=$(du -h "$ARCHIVE" | cut -f1)
echo ""
echo "=== Package Complete ==="
echo "  File : $ARCHIVE"
echo "  Size : $SIZE"
echo ""
echo "Transfer to Mac Mini and run:"
echo "  tar xzf cambot-deploy-${VERSION}.tar.gz"
echo "  bash install.sh"
