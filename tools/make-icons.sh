#!/usr/bin/env bash
# Regenerate the PNG icons from the SVG sources. Only needed when the artwork
# changes; the PNGs are committed so the extension and CI need no converter.
set -euo pipefail
cd "$(dirname "$0")/.."
for state in full page paused idle; do
  for size in 16 32; do
    rsvg-convert -w "$size" -h "$size" "assets/icons/funnel-$state.svg" -o "icons/icon-$size-$state.png"
  done
done
rsvg-convert -w 48 -h 48 assets/icons/funnel-full.svg -o icons/icon-48.png
rsvg-convert -w 128 -h 128 assets/icons/funnel-full.svg -o icons/icon-128.png
echo "icons written"
