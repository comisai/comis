#!/usr/bin/env bash
# VPS — ONCE per box, run as ROOT, AFTER install-vps.sh put the production installation in place.
# Preps the box for the rig: emulator runtime (tsx) + data-dir ownership + a layout sanity print.
# Prereq: deploy-scripts.sh pushed the kit and rendered the selected rig env on the box. For an
# isolated non-default tuple, pass that exact RIG_ENV when invoking this helper.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_rig.sh
source "$HERE/_rig.sh"
rig_load_env "$HERE/.live-env" "${RIG_ENV:-}" "$HERE/.rig-env" /root/comis-rig.env
rig_banner

echo "1) Emulator runtime — tsx (vps-emu.ts is TypeScript; restart-emu.sh execs \`tsx\`)…"
command -v tsx >/dev/null 2>&1 || npm install -g tsx >/dev/null
echo "   tsx: $(command -v tsx || echo MISSING)"

echo "2) Chown $DATA back to $COMIS_USER (clear root-owned leftovers from any root-run helper)…"
chown -R "$COMIS_USER:$COMIS_USER" "$DATA"

echo "3) Layout sanity (the production installation this rig targets)…"
echo -n "   service      : "; systemctl is-active "$SERVICE" 2>/dev/null || echo "not-active"
echo -n "   daemon dist  : "; ls "$PKG/node_modules/@comis/daemon/dist/daemon.js" 2>/dev/null || echo "MISSING — run install-vps.sh first"
echo -n "   cli          : "; su - "$COMIS_USER" -c 'command -v comis' 2>/dev/null || echo "MISSING from $COMIS_USER PATH"
echo -n "   rpc client   : "; ls "$PKG/node_modules/@comis/cli/dist/client/rpc-client.js" 2>/dev/null || echo "MISSING"
echo -n "   jail deps    : "; for b in bwrap tmux ffmpeg; do printf '%s:%s ' "$b" "$(command -v $b >/dev/null && echo ok || echo MISSING)"; done; echo

echo "Done."
echo "  daemon restart : bash $KIT_DIR/restart-daemon.sh        (systemd; boot-verified)"
echo "  clean slate    : bash $KIT_DIR/clean-restart.sh         (wipe test state + restart)"
echo "  driver         : node $KIT_DIR/drive.mjs <chatId> \"<text>\""
echo "  rpc            : node $KIT_DIR/revoke.mjs <method> [k] [v]   (env defaults via $RIG_ENV)"
