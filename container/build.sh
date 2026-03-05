#!/bin/bash
# Build the CamBot-Agent agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="cambot-agent-claude"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

# Verify container runtime is available
if ! command -v "$CONTAINER_RUNTIME" &>/dev/null; then
  # On Windows, docker.exe may not be on bash's PATH — try the common location
  if [ -x "/c/Program Files/Docker/Docker/resources/bin/docker.exe" ]; then
    CONTAINER_RUNTIME="/c/Program Files/Docker/Docker/resources/bin/docker.exe"
  else
    echo "Error: '$CONTAINER_RUNTIME' not found in PATH." >&2
    echo "Make sure Docker Desktop is running and docker is on your PATH." >&2
    exit 1
  fi
fi

echo "Building CamBot-Agent agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

# Copy cambot-llm into build context (Dockerfile COPY needs it local)
AGENTS_SRC="$(cd "$SCRIPT_DIR/../../cambot-llm" && pwd)"
AGENTS_DST="$SCRIPT_DIR/cambot-llm"
if [ -d "$AGENTS_SRC" ]; then
  echo "Copying cambot-llm into build context..."
  rm -rf "$AGENTS_DST"
  mkdir -p "$AGENTS_DST"
  cp -r "$AGENTS_SRC/src" "$AGENTS_DST/src"
  cp "$AGENTS_SRC/package.json" "$AGENTS_DST/"
  cp "$AGENTS_SRC/tsconfig.json" "$AGENTS_DST/"
fi

# Copy agent-runner into build context (now lives at repo root, not inside container/)
RUNNER_SRC="$(cd "$SCRIPT_DIR/../agent-runner" && pwd)"
RUNNER_DST="$SCRIPT_DIR/cambot-agent-runner"
if [ -d "$RUNNER_SRC" ]; then
  echo "Copying agent-runner into build context..."
  rm -rf "$RUNNER_DST"
  mkdir -p "$RUNNER_DST"
  cp -r "$RUNNER_SRC/src" "$RUNNER_DST/src"
  find "$RUNNER_DST/src" -name '*.test.ts' -delete
  cp "$RUNNER_SRC/package.json" "$RUNNER_DST/"
  cp "$RUNNER_SRC/tsconfig.json" "$RUNNER_DST/"
fi

${CONTAINER_RUNTIME} build -t "${IMAGE_NAME}:${TAG}" .

# Clean up copied sources from build context
rm -rf "$AGENTS_DST"
rm -rf "$RUNNER_DST"

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${IMAGE_NAME}:${TAG}"
