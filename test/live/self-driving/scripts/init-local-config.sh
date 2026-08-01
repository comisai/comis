#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELECTED_DATA="${DATA:-}"
SELECTED_GW_PORT="${GW_PORT:-}"
SELECTED_SERVICE="${SERVICE:-}"
SELECTED_RIG_ENV="${RIG_ENV:-}"
# shellcheck source=./_remote-root.sh
. "$HERE/_remote-root.sh"
RIG_MODE=local
RIG_ENV="${SELECTED_RIG_ENV:-$HERE/.rig-env}"
COMIS_DATA_DIR="$SELECTED_DATA"
COMIS_CONFIG_PATHS="$SELECTED_DATA/config.yaml"
export RIG_MODE RIG_ENV COMIS_DATA_DIR COMIS_CONFIG_PATHS
rig_load_env "$HERE/.live-env" "$HERE/.rig-env"
rig_assert_isolated_local_selection "$SELECTED_DATA" "$SELECTED_GW_PORT" "$SELECTED_SERVICE"
node "$HERE/local-config.mjs" init "$DATA/config.yaml" "$DATA" "$GW_PORT" "$CHATID"
