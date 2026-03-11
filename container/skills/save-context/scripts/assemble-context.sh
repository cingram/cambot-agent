#!/usr/bin/env bash
# Assemble context snapshot from all workspace sources.
# Output goes to stdout — the agent pipes it to save_context.
set -euo pipefail

echo "# Context Dump"
echo ""
if [ -f /workspace/context-dump.md ]; then
  cat /workspace/context-dump.md
else
  echo "_(not found)_"
fi

echo ""
echo ""
echo "# Group Memory"
echo ""
if [ -f /workspace/group/CLAUDE.md ]; then
  cat /workspace/group/CLAUDE.md
else
  echo "_(not found)_"
fi

echo ""
echo ""
echo "# Snapshots"
for f in /workspace/snapshots/*.json /workspace/snapshots/**/*.json; do
  [ -f "$f" ] || continue
  echo ""
  echo "## $(basename "$f")"
  echo '```json'
  cat "$f"
  echo ""
  echo '```'
done

echo ""
echo ""
echo "# Environment"
echo ""
echo "HOME=$HOME"
echo "NODE_VERSION=$(node --version 2>/dev/null || echo 'n/a')"
echo "BUN_VERSION=$(bun --version 2>/dev/null || echo 'n/a')"
echo ""
echo "## Extra Mounts"
ls /workspace/extra/ 2>/dev/null || echo "_(none)_"
