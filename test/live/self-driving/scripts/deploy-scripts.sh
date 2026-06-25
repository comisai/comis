#!/usr/bin/env bash
# Push the WHOLE current scripts/ kit to the VPS in ONE step (no drift). Run from anywhere — it resolves
# its own dir. WHY: the framework is gitignored, so the scripts ON THE BOX drift from this local kit
# (codex-30uc run 2026-06-25: clean-restart.sh + a codex models-sweep.sh were MISSING on the box, and
# stale one-offs like anthro-sweep.sh lingered — cost archaeology + per-run scp's). This keeps /root +
# /home/comis in sync with the kit you actually edited. The emulator (test/live/) is deployed separately
# (rsync per 01-SETUP §4); the daemon dist via deploy-dist.sh.
#
#   Setup once:  cp .live-env.example .live-env  &&  edit it (VPS=user@host, GWTOKEN, …)
#   Then:        bash deploy-scripts.sh            # .live-env is auto-sourced; or pass VPS=… inline
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$HERE/.live-env" ] && . "$HERE/.live-env"   # per-box rig config (VPS ssh target, GWTOKEN, …) — see .live-env.example
VPS="${VPS:?set VPS=user@host in scripts/.live-env (see .live-env.example) or the env}"

# /root — the root-run + driver/oracle scripts (drive/revoke/cfg-patch/db/logscan/model-battery + the sweeps)
scp -o ConnectTimeout=15 \
  "$HERE"/drive.mjs "$HERE"/revoke.mjs "$HERE"/cfg-patch.mjs "$HERE"/db.mjs "$HERE"/logscan.mjs "$HERE"/model-battery.mjs \
  "$HERE"/clean-restart.sh "$HERE"/models-sweep.sh "$HERE"/deploy-dist.sh "$HERE"/setup-vps.sh \
  "$VPS:/root/"

# /home/comis — the comis-run launcher + SIGUSR2 supervisor (must be comis-owned + executable)
scp -o ConnectTimeout=15 "$HERE"/restart-m1.sh "$HERE"/daemon-supervisor.sh "$VPS:/tmp/"
ssh -o ConnectTimeout=15 "$VPS" '
  install -o comis -g comis -m 0755 /tmp/restart-m1.sh      /home/comis/restart-m1.sh
  install -o comis -g comis -m 0755 /tmp/daemon-supervisor.sh /home/comis/daemon-supervisor.sh
  rm -f /tmp/restart-m1.sh /tmp/daemon-supervisor.sh
  echo "=== kit on /root ==="; ls -1 /root/*.mjs /root/clean-restart.sh /root/models-sweep.sh 2>/dev/null
  echo "=== comis-side ==="; ls -l /home/comis/restart-m1.sh /home/comis/daemon-supervisor.sh
'
echo "kit deployed to $VPS (run setup-vps.sh ONCE per box first for perms/chown)"
