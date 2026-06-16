#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARCH="${MACOS_ARCH:-x86_64}"
LABEL="${DMG_ARCH_LABEL:-Intel}"
APP_NAME="LLM Wiki Agent.app"
VOL_NAME="LLM Wiki Agent ${LABEL}"
BUILD="$ROOT/build/macos"
DIST="$ROOT/build/dist"
STAGING="$BUILD/dmg-${ARCH}"
DMG="$DIST/LLM-Wiki-Agent-macOS-${LABEL}.dmg"

MACOS_ARCH="$ARCH" "$ROOT/scripts/build_macos_app.sh"

rm -rf "$STAGING"
mkdir -p "$STAGING" "$DIST"
ditto "$BUILD/$APP_NAME" "$STAGING/$APP_NAME"
ln -s /Applications "$STAGING/Applications"

xattr -cr "$STAGING/$APP_NAME"
codesign --force --deep --sign - "$STAGING/$APP_NAME" >/dev/null
rm -f "$DMG"
hdiutil create \
  -volname "$VOL_NAME" \
  -srcfolder "$STAGING" \
  -ov \
  -format UDZO \
  -fs HFS+ \
  "$DMG" >/dev/null

echo "Built DMG: $DMG"
file "$STAGING/$APP_NAME/Contents/MacOS/LLMWikiAgent"
lipo -archs "$STAGING/$APP_NAME/Contents/MacOS/LLMWikiAgent"
