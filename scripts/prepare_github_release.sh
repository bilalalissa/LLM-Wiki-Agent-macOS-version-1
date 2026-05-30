#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/release-template/llm-wiki-agent"

rm -rf "$OUT"
mkdir -p "$OUT"

copy_file() {
  local src="$1"
  local dst="$2"
  mkdir -p "$(dirname "$dst")"
  cp "$src" "$dst"
}

copy_dir() {
  local src="$1"
  local dst="$2"
  mkdir -p "$dst"
  (cd "$src" && tar --exclude='.DS_Store' --exclude='.git' --exclude='.gitignore' --exclude='.env' --exclude='.env.*' -cf - .) | (cd "$dst" && tar -xf -)
}

copy_file "$ROOT/README.md" "$OUT/README.md"
copy_file "$ROOT/package.json" "$OUT/package.json"
copy_file "$ROOT/config.example.env" "$OUT/config.example.env"
copy_dir "$ROOT/src" "$OUT/src"
copy_dir "$ROOT/docs" "$OUT/docs"
copy_dir "$ROOT/extension/arc-clipper" "$OUT/extension/arc-clipper"
if [ -d "$ROOT/media" ]; then
  copy_dir "$ROOT/media" "$OUT/media"
fi
copy_dir "$ROOT/native" "$OUT/native"
copy_dir "$ROOT/scripts" "$OUT/scripts"

find "$OUT" -name '.*' -print -exec rm -rf {} +
find "$OUT" \( -path '*/Eng-vault*' -o -path '*/Arb-vault*' -o -path '*/Mixed-vault*' \) -print -exec rm -rf {} +

echo "Prepared GitHub upload folder: $OUT"
echo "Dotfiles included:"
find "$OUT" -name '.*' -print
