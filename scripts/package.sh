#!/usr/bin/env bash
# Build the load-unpacked package Chrome wants: manifest.json at the archive
# root, no tests, docs, node_modules or dotfiles. Uses python3's zipfile so it
# needs no `zip` binary; CI and any dev machine with python3 can run it.
set -euo pipefail
cd "$(dirname "$0")/.."
out="${1:-dist/gitlab-draft-hider.zip}"
mkdir -p "$(dirname "$out")"
rm -f "$out"
python3 -m zipfile -c "$out" manifest.json src icons README.md
echo "wrote $out"
