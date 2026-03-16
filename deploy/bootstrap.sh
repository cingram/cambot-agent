#!/bin/bash
# CamBot — Bootstrap Installer
# Downloads and runs the full installer from a private GitHub repo.
#
# Usage:
#   bash <(gh api repos/cingram/cambot-agent/contents/deploy/bootstrap.sh -H "Accept: application/vnd.github.raw")
#
# Or if you have this file locally:
#   bash bootstrap.sh [--version v1.2.3]
set -euo pipefail

REPO="cingram/cambot-agent"

# Ensure gh CLI is available
if ! command -v gh &>/dev/null; then
  echo "GitHub CLI (gh) is required for private repo access."
  echo ""
  if [ "$(uname)" = "Darwin" ]; then
    echo "Install it with:"
    echo "  /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
    echo "  brew install gh"
  else
    echo "Install it from: https://cli.github.com"
  fi
  echo ""
  echo "Then authenticate:"
  echo "  gh auth login"
  exit 1
fi

# Ensure gh is authenticated
if ! gh auth status &>/dev/null 2>&1; then
  echo "GitHub CLI is not authenticated. Run:"
  echo "  gh auth login"
  exit 1
fi

# Download and run the full installer
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

echo "Downloading CamBot installer..."
gh api "repos/$REPO/contents/deploy/install.sh" \
  -H "Accept: application/vnd.github.raw" > "$TMPDIR/install.sh"

exec bash "$TMPDIR/install.sh" "$@"
