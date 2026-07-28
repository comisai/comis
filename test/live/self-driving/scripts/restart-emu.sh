#!/usr/bin/env bash
# (Re)launch the Telegram emulator so it SURVIVES the shell that started it, then print the new
# kernel-allocated port + wiring.
#
# RIG_MODE=remote (default) — VPS, run as ROOT; the emulator lives in $EMU_DIR (deploy-emu.sh rsyncs
#   test/live/ there) and must outlive the ssh channel.
#     ssh root@<vps> 'bash /root/restart-emu.sh'
# RIG_MODE=local — THIS machine; the emulator runs straight out of the checkout (no rsync — EMU_DIR
#   defaults to the repo root) and binds loopback next to the local daemon.
#     ./restart-emu.sh
#
# WHY THIS EXISTS (two traps that together cost ~6 cycles):
#  (1) pkill SELF-MATCH — `pkill -f "vps-emu"` matches the shell running THIS command (its argv
#      contains "vps-emu.ts") → it kills itself → empty output / ssh exit 255, emulator never
#      relaunched. MUST anchor `^node ` (the bash/ssh wrapper argv starts with "bash"/"sshd", never
#      "node"). Same class as the `pkill -f daemon.js` trap in 01-SETUP.
#  (2) BG-OVER-SSH DIES — `nohup … &` / `setsid … &` inside an ssh command dies when the channel
#      closes despite nohup/setsid. tmux fully detaches and persists.
#
# Then re-wire the daemon: the port CHANGES (kernel-allocated) →
#   remote:  node /root/wire-emu.mjs && bash /root/restart-daemon.sh
#   local:   node ./wire-emu.mjs && ./restart-daemon.sh
#
# EMU_GROUPS (a JSON array of {chatId, members:[{id,firstName,username?}], botId, botUsername}) is
# passed through to the launcher. Group chats CANNOT be created over the /control API — only at
# emulator launch — so a run that drives group/mention behaviour MUST set this (in .live-env or
# inline) or those arcs are undrivable.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$HERE/.live-env" ] && . "$HERE/.live-env"
# shellcheck source=./_rig.sh
. "$HERE/_rig.sh" 2>/dev/null || {
  echo "missing $HERE/_rig.sh — re-run deploy-scripts.sh (the kit ships as a unit)" >&2
  exit 2
}
for _f in "${RIG_ENV:-}" "$HERE/.rig-env" /root/comis-rig.env; do
  # shellcheck disable=SC1090 # the rig env path is mode-resolved at run time
  [ -n "$_f" ] && [ -f "$_f" ] && . "$_f" && break
done
rig_defaults
if rig_is_local; then
  EMU_LOG="${EMU_LOG:-/tmp/comis-emu.log}"
  # tsx from the workspace (a devDependency of this repo) — never assume a global install locally.
  if command -v tsx >/dev/null 2>&1; then TSX="tsx"; else TSX="pnpm -s exec tsx"; fi
else
  EMU_LOG="${EMU_LOG:-/root/emu.log}"
  TSX="tsx"
fi

# (1) Kill the old emulator with an ANCHORED pattern (never matches this shell).
pkill -9 -f "^node .*vps-emu" 2>/dev/null
tmux kill-session -t emu 2>/dev/null
sleep 2

# (2) Launch it detached. tmux when available (the only thing that survives an ssh close); locally a
# plain nohup suffices when tmux is absent, since there is no channel to close.
: >"$EMU_LOG"
LAUNCH="cd '$EMU_DIR' && exec env EMU_GROUPS='${EMU_GROUPS:-}' $TSX test/live/bin/vps-emu.ts"
if command -v tmux >/dev/null 2>&1; then
  tmux new-session -d -s emu "$LAUNCH > '$EMU_LOG' 2>&1"
elif rig_is_local; then
  nohup bash -c "$LAUNCH" >"$EMU_LOG" 2>&1 &
  disown 2>/dev/null || true
else
  echo "tmux missing on the box — install it (setup-vps.sh) or the emulator dies with the ssh channel"
  exit 1
fi
sleep 8

# Report the new wiring (the port the daemon's apiRoot must point at).
if grep -aq EMU_UP "$EMU_LOG"; then
  echo "EMU UP:"
  grep -a EMU_UP "$EMU_LOG" | tail -1
  PORT=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).port)' "${EMU_JSON:-/tmp/comis-emu.json}" 2>/dev/null)
  if rig_is_local; then
    echo "NEXT: node $HERE/wire-emu.mjs && $HERE/restart-daemon.sh   # wires apiRoot → http://127.0.0.1:${PORT}"
  else
    echo "NEXT: node /root/wire-emu.mjs && bash /root/restart-daemon.sh   # wires apiRoot → http://127.0.0.1:${PORT}"
  fi
else
  echo "EMU FAILED to start — tail $EMU_LOG:"
  tail -15 "$EMU_LOG"
  exit 1
fi
