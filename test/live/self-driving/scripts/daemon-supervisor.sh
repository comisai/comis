#!/usr/bin/env bash
# comis-daemon-supervisor — relaunch the daemon on exit code 42 (Comis's SIGUSR2 restart-hint).
#
# WHY: many config-write RPCs (config.patch/apply, heartbeat.update, gateway.restart, token
# create/rotate/revoke, skills_manage → config persistence) call process.kill(pid,"SIGUSR2") on
# success; the SIGUSR2 handler exits 42 (setup-shutdown.ts:695) expecting a supervisor (systemd
# Restart=on-failure / pm2) to relaunch. The bare `setsid node &` launch had none → a config-mutating
# RPC left the daemon DEAD. This loop is that missing supervisor.
#
# Relaunch ONLY on 42 (the restart hint). Any other exit — 0 (clean SIGINT), a crash, or 137 (SIGKILL
# from restart-m1.sh's pkill) — breaks the loop so a real stop stays stopped. Reads SRC/DATA/HOME from
# the env exported by restart-m1.sh before setsid.
SRC="${SRC:-/root/comis-src}"
DATA="${DATA:-/home/comis/.comis}"
LOG="$HOME/comis-m1.log"

while true; do
  node --permission --allow-addons --allow-worker --allow-fs-read=* \
    --allow-fs-write="$DATA" --allow-fs-write="$HOME/.npm" --allow-fs-write="$HOME/.pi" --allow-fs-write=/tmp \
    --allow-child-process "$SRC/packages/daemon/dist/daemon.js" >>"$LOG" 2>&1 </dev/null
  ec=$?
  if [ "$ec" = 42 ]; then
    echo "[supervisor] daemon exited 42 (SIGUSR2 restart) — relaunching $(date -u +%H:%M:%SZ)" >>"$LOG"
    sleep 1
  else
    echo "[supervisor] daemon exited $ec (not a restart) — stopping $(date -u +%H:%M:%SZ)" >>"$LOG"
    break
  fi
done
