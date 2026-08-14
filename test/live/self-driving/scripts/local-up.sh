#!/usr/bin/env bash
# LOCAL RIG — bring the whole local rig up in one command, then gate on it.
#
# The local twin of `install-vps.sh` + `WIRE=1 deploy-emu.sh` + `phase0-check.sh`: build this
# checkout, launch the emulator on loopback, point the daemon's Telegram adapter at it, restart the
# daemon, and prove the rig is coherent. No VPS, no ssh, no deploy — the checkout IS the build.
#
#   DATA=/absolute/rig GW_PORT=4877 SERVICE=comis-local-drive ./local-up.sh
#   SKIP_BUILD=1 DATA=/absolute/rig GW_PORT=4877 SERVICE=comis-local-drive ./local-up.sh
#
# It rewrites `channels.telegram` only in the explicitly selected isolated DATA root. The selected
# gateway port must be free or already owned by that root, and SERVICE must not be the everyday `comis`.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELECTED_DATA="${DATA:-}"
SELECTED_GW_PORT="${GW_PORT:-}"
SELECTED_SERVICE="${SERVICE:-}"
SELECTED_RIG_ENV="${RIG_ENV:-}"
SELECTED_TRAJECTORY_DIR="${COMIS_TRAJECTORY_DIR:-$SELECTED_DATA/trajectories}"
# shellcheck source=./_remote-root.sh
. "$HERE/_remote-root.sh"
RIG_MODE=local
RIG_ENV="${SELECTED_RIG_ENV:-$HERE/.rig-env}"
COMIS_DATA_DIR="$SELECTED_DATA"
COMIS_CONFIG_PATHS="$SELECTED_DATA/config.yaml"
COMIS_TRAJECTORY_DIR="$SELECTED_TRAJECTORY_DIR"
export RIG_MODE RIG_ENV COMIS_DATA_DIR COMIS_CONFIG_PATHS COMIS_TRAJECTORY_DIR
rig_load_env "$HERE/.live-env" "$HERE/.rig-env"
rig_assert_isolated_local_selection "$SELECTED_DATA" "$SELECTED_GW_PORT" "$SELECTED_SERVICE"
REPO="${REPO:-$(git rev-parse --show-toplevel)}"

if [ ! -f "$DATA/config.yaml" ]; then
  echo "no $DATA/config.yaml — bootstrap a config first:"
  echo "  RIG_MODE=local DATA='$DATA' GW_PORT='$GW_PORT' SERVICE='$SERVICE' $HERE/init-local-config.sh"
  exit 1
fi
node "$HERE/local-config.mjs" validate "$DATA/config.yaml" "$DATA" "$GW_PORT"

echo "=== local-up — $(rig_banner) ==="

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
The isolated rig remains selected by DATA=$DATA, GW_PORT=$GW_PORT, SERVICE=$SERVICE.
EOF
