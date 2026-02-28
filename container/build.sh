#!/bin/bash
# Build the CamBot-Agent agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="cambot-agent-agent"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

echo "Building CamBot-Agent agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

# Copy cambot-agents into build context (Dockerfile COPY needs it local)
AGENTS_SRC="$(cd "$SCRIPT_DIR/../../cambot-agents" && pwd)"
AGENTS_DST="$SCRIPT_DIR/cambot-agents"
if [ -d "$AGENTS_SRC" ]; then
  echo "Copying cambot-agents into build context..."
  rm -rf "$AGENTS_DST"
  mkdir -p "$AGENTS_DST"
  cp -r "$AGENTS_SRC/src" "$AGENTS_DST/src"
  cp "$AGENTS_SRC/package.json" "$AGENTS_DST/"
  cp "$AGENTS_SRC/tsconfig.json" "$AGENTS_DST/"
fi

${CONTAINER_RUNTIME} build -t "${IMAGE_NAME}:${TAG}" .

# Clean up copied cambot-agents from build context
rm -rf "$AGENTS_DST"

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${IMAGE_NAME}:${TAG}"
