#!/usr/bin/env bash
# Drive the durable execution-graph restart proof through the Telegram emulator.
#
# The Node driver owns the evidence joins. This wrapper owns only the shared rig
# resolution so the same command runs against local tmux/pm2 and remote systemd.
#
# Usage:
#   durability-resume-probe.sh [chatId] [emuApiRoot] [launchWaitSeconds]
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_rig.sh
. "$HERE/_rig.sh" 2>/dev/null || {
  echo "missing $HERE/_rig.sh — deploy the complete live-test script kit" >&2
  exit 2
}
rig_load_env "$HERE/.live-env" "$HERE/.rig-env" /root/comis-rig.env
rig_banner

export COMIS_DATA_DIR="$DATA"
export COMIS_CONFIG_PATHS="$DATA/config.yaml"
exec node "$HERE/durability-resume-probe.mjs" "$@"
