#!/usr/bin/env bash
# VPS (run as ROOT) — robustly (re)launch the Telegram emulator so it SURVIVES the
# ssh session close, then print the new kernel-allocated port + wiring.
#
# WHY THIS EXISTS (two traps that together cost ~6 cycles):
#  (1) pkill SELF-MATCH — `pkill -f "vps-emu"` matches the ssh shell running THIS
#      command (its argv contains "vps-emu.ts") → it kills itself → empty output /
#      ssh exit 255, emulator never relaunched. MUST anchor `^node ` (the bash/ssh
#      wrapper argv starts with "bash"/"sshd", never "node"). Same class as the
#      `pkill -f daemon-entrypoint.js` trap in 01-SETUP.
#  (2) BG-OVER-SSH DIES — `nohup … &` / `setsid … &` inside an ssh command dies when
#      the channel closes despite nohup/setsid. tmux fully detaches and persists.
#
# Usage (re-run after editing test/live/emulators or to recover a dead emu):
#   ssh root@<vps> 'bash /root/restart-emu.sh'        # EMU_DIR from /root/comis-rig.env (default /root/comis-emu)
# Then re-wire the daemon: the port CHANGES (kernel-allocated) →
#   node /root/wire-emu.mjs && bash /root/restart-daemon.sh
set -uo pipefail
[ -f /root/comis-rig.env ] && . /root/comis-rig.env
EMU_DIR="${EMU_DIR:-/root/comis-emu}"

# (1) Kill the old emulator with an ANCHORED pattern (never matches this shell).
pkill -9 -f "^node .*vps-emu" 2>/dev/null
tmux kill-session -t emu 2>/dev/null
sleep 2

# (2) Launch inside tmux (survives ssh close).
: > /root/emu.log
tmux new-session -d -s emu "cd '$EMU_DIR' && exec tsx test/live/bin/vps-emu.ts > /root/emu.log 2>&1"
sleep 8

# Report the new wiring (the port the daemon's apiRoot must point at).
if grep -aq EMU_UP /root/emu.log; then
  echo "EMU UP:"; grep -a EMU_UP /root/emu.log | tail -1
  PORT=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("/tmp/comis-emu.json")).port)' 2>/dev/null)
  echo "NEXT: node /root/wire-emu.mjs && bash /root/restart-daemon.sh   # wires apiRoot → http://127.0.0.1:${PORT}"
else
  echo "EMU FAILED to start — tail /root/emu.log:"; tail -15 /root/emu.log
  exit 1
fi
