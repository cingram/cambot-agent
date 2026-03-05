#!/bin/bash
set -e

# Fast container startup: skip tsc when hot-mounted source matches the pre-built image.
#
# The Dockerfile bakes compiled dist/ and source hashes at build time.
# At runtime we compare the mounted source hash against the baked-in hash.
# If they match (common case — no code edits since last image build), we use
# the pre-built dist directly, cutting ~10-30s off container startup.

hash_dir() {
  find "$1" -name '*.ts' -not -path '*/node_modules/*' -exec md5sum {} + 2>/dev/null | sort | md5sum | cut -d' ' -f1
}

# --- Rebuild cambot-llm only if source changed from build ---
CAMBOT_AGENTS_HASH=$(hash_dir /cambot-llm/src)
CAMBOT_AGENTS_BUILD_HASH=""
[ -f /cambot-llm/.source-hash ] && CAMBOT_AGENTS_BUILD_HASH=$(cat /cambot-llm/.source-hash)

if [ "$CAMBOT_AGENTS_HASH" != "$CAMBOT_AGENTS_BUILD_HASH" ]; then
  echo "[entrypoint] cambot-llm source changed, recompiling..." >&2
  cd /cambot-llm && npx tsc 2>&1 >&2
else
  echo "[entrypoint] cambot-llm unchanged, skipping tsc" >&2
fi

# --- Rebuild agent-runner only if source changed from build ---
RUNNER_HASH=$(hash_dir /app/src)
RUNNER_BUILD_HASH=""
[ -f /app/.source-hash ] && RUNNER_BUILD_HASH=$(cat /app/.source-hash)

if [ "$RUNNER_HASH" != "$RUNNER_BUILD_HASH" ]; then
  echo "[entrypoint] agent-runner source changed, recompiling to /tmp/dist..." >&2
  cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
  ln -sf /app/node_modules /tmp/dist/node_modules
  DIST_DIR="/tmp/dist"
else
  echo "[entrypoint] agent-runner unchanged, using pre-built dist" >&2
  DIST_DIR="/app/dist"
fi

# Read stdin (secrets JSON) to temp file, then run agent
cat > /tmp/input.json
node "$DIST_DIR/index.js" < /tmp/input.json
