#!/usr/bin/env bash
# LOCAL RIG — bring the whole local rig up in one command, then gate on it.
#
# The local twin of `install-vps.sh` + `WIRE=1 deploy-emu.sh` + `phase0-check.sh`: build this
# checkout, launch the emulator on loopback, point the daemon's Telegram adapter at it, restart the
# daemon, and prove the rig is coherent. No VPS, no ssh, no deploy — the checkout IS the build.
#
#   ./local-up.sh              # build + emulator + wire + restart + rig-doctor
#   SKIP_BUILD=1 ./local-up.sh # skip `pnpm build` (you just built)
#   DATA=~/.comis-live ./local-up.sh
#
# ⚠ WHAT THIS MUTATES. It rewrites `channels.telegram` in $DATA/config.yaml to point at the local
# emulator, preserving the original ONCE at $DATA/config.pre-emu.yaml. With the default
# DATA=~/.comis that is YOUR everyday install: its real bot stops receiving until you restore.
#   restore:  cp $DATA/config.pre-emu.yaml $DATA/config.yaml && ./restart-daemon.sh
# To leave your everyday install untouched, point DATA at a dedicated dir and give it its own
# gateway port (GW_PORT) — see `01-SETUP.md §Local mode`.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$HERE/.live-env" ] && . "$HERE/.live-env"
# Local mode is the whole point of this script — assert it rather than inheriting a stray remote
# setting from .live-env and silently doing nothing local.
RIG_MODE=local
export RIG_MODE
# shellcheck source=./_remote-root.sh
. "$HERE/_remote-root.sh"
rig_defaults
REPO="${REPO:-$(git rev-parse --show-toplevel)}"

echo "=== local-up — $(rig_banner) ==="

if [ ! -f "$DATA/config.yaml" ]; then
  echo "no $DATA/config.yaml — bootstrap a config first:"
  echo "  node $REPO/packages/cli/dist/cli.js init          # the wizard, or"
  echo "  DATA='$DATA' node $HERE/init-config.mjs           # the rig template (generated token + CHATID allowlisted)"
  exit 1
fi

if [ "${SKIP_BUILD:-0}" != 1 ]; then
  echo "1) pnpm build (the daemon under test is this checkout's dist)…"
  (cd "$REPO" && pnpm build)
else
  echo "1) build skipped (SKIP_BUILD=1)"
fi

echo "2) (re)launch the emulator on loopback…"
bash "$HERE/restart-emu.sh"

echo "3) wire channels.telegram → the emulator, then restart the daemon…"
node "$HERE/wire-emu.mjs"
bash "$HERE/restart-daemon.sh"

echo "4) render the rig env (gateway token for the RPC oracles)…"
bash "$HERE/deploy-scripts.sh" || echo "  (rig env render reported a problem — rig-doctor will name it)"

echo "5) coherence gate…"
bash "$HERE/rig-doctor.sh"

cat <<EOF

local rig up. Drive it:
  node $HERE/drive.mjs \$CHATID "reply with PONG42"
Ground truth:
  node $HERE/db.mjs sql "SELECT COUNT(*) FROM lcd_messages"
  node $REPO/packages/cli/dist/cli.js explain "<sessionKey|traceId>"
Restore your real Telegram config when done:
  cp $DATA/config.pre-emu.yaml $DATA/config.yaml && $HERE/restart-daemon.sh
EOF
