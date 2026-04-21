#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMIS_DIR="$HOME/.comis"

mkdir -p "$COMIS_DIR"
cp "$SCRIPT_DIR/config.test.yaml" "$COMIS_DIR/config.test.yaml"
echo "Installed test config to $COMIS_DIR/config.test.yaml"
