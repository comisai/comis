#!/usr/bin/env bash
# LOCAL — get the Telegram emulator running against the rig, and optionally wire the daemon to it.
# Formalizes the 01-SETUP §4 hand-steps into one command.
#
# RIG_MODE=remote (default): rsync test/live → $EMU_DIR + ESM marker + restart-emu.sh
#   [+ wire-emu.mjs + daemon restart]. Prereqs: install-vps.sh (daemon installed), deploy-scripts.sh
#   (helpers + rig env on the box), setup-vps.sh (tsx installed).
# RIG_MODE=local: there is NOTHING to ship — the emulator runs straight out of this checkout (which
#   is already ESM), so this is just the (re)launch [+ wire]. `local-up.sh` wraps it with the build
#   and the readiness gate.
#
#   ./deploy-emu.sh          # (re)launch the emulator; prints the new wiring
#   WIRE=1 ./deploy-emu.sh   # …then also point config.yaml at it and restart the daemon
# Re-run any time test/live/ changes; the port is kernel-allocated, so every relaunch needs a
# re-wire (WIRE=1 does both) — a stale wire also silently breaks inbound media (the daemon trusts
# the configured apiRoot origin for file downloads).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$HERE/.live-env" ] && . "$HERE/.live-env"
# shellcheck source=./_remote-root.sh
. "$HERE/_remote-root.sh"
rig_defaults
REPO="${REPO:-$(git rev-parse --show-toplevel)}"

if rig_is_local; then
  echo "1) local rig — no deploy needed (the emulator runs from $EMU_DIR)"
else
  VPS="${VPS:?set VPS=user@host in scripts/.live-env (see .live-env.example) or the env}"
  echo "1) stream the emulator subtree → $VPS:$EMU_DIR (self-driving/ + logs excluded — the emulator"
  echo "   needs bin/ + emulators/ + harness/; runs/ can be hundreds of MB)…"
  (cd "$REPO/test/live" && tar --no-xattrs -cf - --exclude=node_modules --exclude=self-driving --exclude='*.log' .) |
    remote_root "rm -rf '$EMU_DIR/test/live' && mkdir -p '$EMU_DIR/test/live' && tar -xf - -C '$EMU_DIR/test/live'"
  # ESM marker so tsx treats the .ts files as ESM (same trick as the original hand-step).
  remote_root "printf '%s' '{\"type\":\"module\"}' > '$EMU_DIR/package.json'"
fi

echo "2) (Re)launch the emulator (anchored pkill + tmux)…"
if rig_is_local; then
  EMU_DIR="$EMU_DIR" bash "$HERE/restart-emu.sh"
else
  remote_root "EMU_DIR='$EMU_DIR' bash /root/restart-emu.sh"
fi

if [ "${WIRE:-0}" = 1 ]; then
  echo "3) Wire the daemon to the new emulator port + restart it…"
  if rig_is_local; then
    node "$HERE/wire-emu.mjs" && bash "$HERE/restart-daemon.sh"
  else
    remote_root "node /root/wire-emu.mjs && bash /root/restart-daemon.sh"
  fi
elif rig_is_local; then
  echo "NEXT: node $HERE/wire-emu.mjs && $HERE/restart-daemon.sh   # or re-run with WIRE=1"
else
  echo "NEXT: ssh \$VPS 'node /root/wire-emu.mjs && bash /root/restart-daemon.sh'   # or re-run with WIRE=1"
fi
