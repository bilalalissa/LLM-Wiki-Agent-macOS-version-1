#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
"$ROOT/scripts/build_macos_app.sh"

APP="$ROOT/build/macos/LLM Wiki Agent.app"
TARGET="/Applications/LLM Wiki Agent.app"

if [[ -d "$TARGET" ]]; then
  rm -rf "$TARGET"
fi
cp -R "$APP" "$TARGET"

echo "Installed: $TARGET"
echo "Open it from /Applications or run: open '$TARGET'"
