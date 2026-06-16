#!/bin/bash
# Package the game per the platform layout: logic.js + index.html at the ZIP ROOT.
# We stamp a build version + cache-bust query onto a STAGED COPY (the source tree
# stays clean), so every deploy fetches fresh code on the device. See the versioning spec.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/public"
ZIP="$ROOT/pinchy-pea.zip"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$SRC/." "$STAGE/"

SHA="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo nogit)"
TOKEN="$(date +%Y%m%d-%H%M%S)-$SHA"          # unique per build (timestamp), URL-safe
VERSION="$(date '+%Y-%m-%d %H:%M') · $SHA"   # human-readable label on the title screen
python3 "$ROOT/tools/stamp_version.py" "$STAGE" "$TOKEN" "$VERSION"

rm -f "$ZIP"
( cd "$STAGE" && zip -qr "$ZIP" . -x "*.DS_Store" )
ls -la "$ZIP"
unzip -l "$ZIP" | head -12
