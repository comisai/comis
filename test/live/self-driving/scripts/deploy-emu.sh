#!/usr/bin/env bash
# LOCAL — deploy the Telegram emulator (test/live/ subtree) to the VPS, (re)launch it, and
# optionally wire the daemon to it. Formalizes the 01-SETUP §4 hand-steps into one command:
#   rsync test/live → $EMU_DIR  +  ESM marker  +  restart-emu.sh  [+ wire-emu.mjs + daemon restart]
#
#   ./deploy-emu.sh          # ship + (re)launch the emulator; prints the new wiring
#   WIRE=1 ./deploy-emu.sh   # …then also point config.yaml at it and restart the daemon
# Prereqs: install-vps.sh (daemon installed), deploy-scripts.sh (helpers + rig env on the box),
# setup-vps.sh (tsx installed). Re-run any time test/live/ changes; the port is kernel-allocated,
# so every relaunch needs a re-wire (WIRE=1 does both).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$HERE/.live-env" ] && . "$HERE/.live-env"
REPO="${REPO:-$(git rev-parse --show-toplevel)}"
VPS="${VPS:?set VPS=user@host in scripts/.live-env (see .live-env.example) or the env}"
EMU_DIR="${EMU_DIR:-/root/comis-emu}"

echo "1) rsync the emulator subtree → $VPS:$EMU_DIR (self-driving/ + logs excluded — the emulator"
echo "   needs bin/ + emulators/ + harness/; runs/ can be hundreds of MB)…"
ssh -o ConnectTimeout=15 "$VPS" "mkdir -p '$EMU_DIR/test/live'" # rsync does not create nested targets
rsync -az -e "ssh -o ConnectTimeout=20" \
  --exclude=node_modules --exclude=self-driving --exclude='*.log' \
  "$REPO/test/live/" "$VPS:$EMU_DIR/test/live/"
# ESM marker so tsx treats the .ts files as ESM (same trick as the original hand-step).
ssh -o ConnectTimeout=15 "$VPS" "printf '{\"type\":\"module\"}' > '$EMU_DIR/package.json'"

echo "2) (Re)launch the emulator (anchored pkill + tmux — survives ssh close)…"
ssh -o ConnectTimeout=20 "$VPS" "EMU_DIR='$EMU_DIR' bash /root/restart-emu.sh"

if [ "${WIRE:-0}" = 1 ]; then
  echo "3) Wire the daemon to the new emulator port + restart it…"
  ssh -o ConnectTimeout=20 -o ServerAliveInterval=10 "$VPS" "node /root/wire-emu.mjs && bash /root/restart-daemon.sh"
else
  echo "NEXT: ssh \$VPS 'node /root/wire-emu.mjs && bash /root/restart-daemon.sh'   # or re-run with WIRE=1"
fi
