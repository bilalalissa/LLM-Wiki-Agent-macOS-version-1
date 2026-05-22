#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
"$ROOT/scripts/build_macos_app.sh"

APP="$ROOT/build/macos/LLM Wiki Agent.app"
TARGET="/Applications/LLM Wiki Agent.app"

osascript -e 'tell application "LLM Wiki Agent" to quit' >/dev/null 2>&1 || true
pkill -x LLMWikiAgent >/dev/null 2>&1 || true
pkill -f "$TARGET/Contents/Resources/agent/src/server.mjs" >/dev/null 2>&1 || true
pkill -f "$ROOT/build/macos/LLM Wiki Agent.app/Contents/Resources/agent/src/server.mjs" >/dev/null 2>&1 || true
sleep 0.5

if [[ -d "$TARGET" ]]; then
  rm -rf "$TARGET"
fi
cp -R "$APP" "$TARGET"
touch "$TARGET"

echo "Installed: $TARGET"
echo "Open it from /Applications or run: open '$TARGET'"
