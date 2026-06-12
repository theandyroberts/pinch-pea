#!/bin/bash
# Package the game per the platform layout: logic.js + index.html at the ZIP ROOT.
set -euo pipefail
cd "$(dirname "$0")/../public"
rm -f ../pinchy-pea.zip
zip -qr ../pinchy-pea.zip . -x "*.DS_Store"
cd ..
ls -la pinchy-pea.zip
unzip -l pinchy-pea.zip | head -12
