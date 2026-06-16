#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$ROOT/build/macos"
APP="$BUILD/LLM Wiki Agent.app"
CONTENTS="$APP/Contents"
MACOS="$CONTENTS/MacOS"
RESOURCES="$CONTENTS/Resources"
AGENT="$RESOURCES/agent"
APP_ICON="$ROOT/native/macos/LLMWikiAgent/Resources/AppIcon.icns"
MACOS_ARCH="${MACOS_ARCH:-}"

rm -rf "$APP"
mkdir -p "$MACOS" "$RESOURCES" "$AGENT"

if [ ! -f "$APP_ICON" ]; then
  "$ROOT/scripts/generate_app_icon.sh"
fi

SWIFTC_ARGS=(
  "$ROOT/native/macos/LLMWikiAgent/Sources/LLMWikiAgent/main.swift"
  -o "$MACOS/LLMWikiAgent"
  -framework AppKit
  -framework WebKit
  -framework ServiceManagement
)
if [ -n "$MACOS_ARCH" ]; then
  SWIFTC_ARGS=(-target "$MACOS_ARCH-apple-macosx13.0" "${SWIFTC_ARGS[@]}")
fi
swiftc "${SWIFTC_ARGS[@]}"

cat > "$CONTENTS/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>LLMWikiAgent</string>
  <key>CFBundleIdentifier</key><string>local.llmwiki.agent</string>
  <key>CFBundleName</key><string>LLM Wiki Agent</string>
  <key>CFBundleDisplayName</key><string>LLM Wiki Agent</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.1</string>
  <key>CFBundleVersion</key><string>2</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
</dict>
</plist>
PLIST

cp "$APP_ICON" "$RESOURCES/AppIcon.icns"
cp "$ROOT/package.json" "$AGENT/package.json"
cp "$ROOT/README.md" "$AGENT/README.md"
cp "$ROOT/config.example.env" "$RESOURCES/config.example.env"
cp -R "$ROOT/src" "$AGENT/src"
cp -R "$ROOT/docs" "$AGENT/docs"
if [ -d "$ROOT/media" ]; then
  cp -R "$ROOT/media" "$AGENT/media"
fi
find "$AGENT" -name '.DS_Store' -delete

echo "Built: $APP"
