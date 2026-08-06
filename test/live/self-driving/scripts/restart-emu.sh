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
# WHY THIS EXISTS (two traps that together cost cycles):
#  (1) PROCESS-WIDE KILL — a host may carry several isolated local rigs. A `pkill -f vps-emu`
#      or fixed `tmux kill-session -t emu` stops every rig (and can self-match the wrapper). The
#      selected wiring file carries the exact pid, and the selected tmux name is DATA/SERVICE-scoped.
#  (2) BG-OVER-SSH DIES — `nohup … &` / `setsid … &` inside an ssh command dies when the channel
#      closes despite nohup/setsid. tmux fully detaches and persists.
#
# Then re-wire the daemon: the port CHANGES (kernel-allocated) →
#   remote:  node /root/wire-emu.mjs && bash /root/restart-daemon.sh
#   local:   node ./wire-emu.mjs && ./restart-daemon.sh
#
# EMU_GROUPS (a JSON array of {chatId, members:[{id,firstName,username?}], botId, botUsername,
# supergroup?, forum?}) is passed through to the launcher. Group chats CANNOT be created over the
# /control API — only at emulator launch — so a run that drives group/mention behaviour MUST set
# this (in .live-env or inline) or those arcs are undrivable. Topic scenarios require both
# `supergroup:true` and `forum:true`.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_rig.sh
. "$HERE/_rig.sh" 2>/dev/null || {
  echo "missing $HERE/_rig.sh — re-run deploy-scripts.sh (the kit ships as a unit)" >&2
  exit 2
}
rig_load_env "$HERE/.live-env" "$HERE/.rig-env" /root/comis-rig.env
if rig_is_local; then
  # tsx from the workspace (a devDependency of this repo) — never assume a global install locally.
  if command -v tsx >/dev/null 2>&1; then TSX="tsx"; else TSX="pnpm -s exec tsx"; fi
else
  TSX="tsx"
fi

# (1) Stop ONLY the emulator owned by this selected wiring/session tuple.
old_pid="$(rig_emu_pid)"
if command -v tmux >/dev/null 2>&1 && tmux has-session -t "$EMU_TMUX_SESSION" 2>/dev/null; then
  if rig_is_local; then
    owner="$(tmux show-environment -t "$EMU_TMUX_SESSION" COMIS_EMU_DATA_OWNER 2>/dev/null)"
    if [ "${owner#COMIS_EMU_DATA_OWNER=}" != "$DATA" ]; then
      echo "tmux emulator session '$EMU_TMUX_SESSION' belongs to another DATA root; refusing to stop it" >&2
      exit 2
    fi
  fi
  tmux kill-session -t "$EMU_TMUX_SESSION"
fi
if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
  kill "$old_pid" 2>/dev/null || true
  for _ in $(seq 1 15); do
    kill -0 "$old_pid" 2>/dev/null || break
    sleep 1
  done
  kill -0 "$old_pid" 2>/dev/null && kill -9 "$old_pid" 2>/dev/null || true
fi

# (2) Launch it detached. tmux when available (the only thing that survives an ssh close); locally a
# plain nohup suffices when tmux is absent, since there is no channel to close.
: >"$EMU_LOG"
LAUNCH="cd '$EMU_DIR' && exec env EMU_JSON='$EMU_JSON' EMU_GROUPS='${EMU_GROUPS:-}' $TSX test/live/bin/vps-emu.ts"
if command -v tmux >/dev/null 2>&1; then
  tmux new-session -d -s "$EMU_TMUX_SESSION" "$LAUNCH > '$EMU_LOG' 2>&1"
  tmux set-environment -t "$EMU_TMUX_SESSION" COMIS_EMU_DATA_OWNER "$DATA"
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
  PORT=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).port)' "$EMU_JSON" 2>/dev/null)
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
