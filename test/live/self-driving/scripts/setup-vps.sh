#!/usr/bin/env bash
# VPS — ONCE per box, run as ROOT. Makes the rig comis-runnable and installs the VPS-side helpers.
# Prereq: scp this scripts/ folder to the VPS first, e.g.  scp -r scripts root@<vps>:/root/lt-scripts
# Then:  ssh root@<vps> 'bash /root/lt-scripts/setup-vps.sh'
set -euo pipefail
SRC="${SRC:-/root/comis-src}"
DATA="${DATA:-/home/comis/.comis}"
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "1) Open $SRC for comis read/traverse (the daemon runs as comis but the code is root-owned)…"
chmod o+x /root
chmod -R o+rX "$SRC"

echo "2) Chown $DATA back to comis (clear root-owned leftovers from any prior root daemon)…"
chown -R comis:comis "$DATA"

echo "3) Install VPS-side helpers…"
install -o comis -g comis -m 0755 "$HERE/restart-m1.sh" /home/comis/restart-m1.sh
cp "$HERE/drive.mjs"  /root/drive.mjs
cp "$HERE/revoke.mjs" /root/revoke.mjs

echo "Done."
echo "  daemon launcher : su - comis -c 'bash /home/comis/restart-m1.sh'   (or use clean-restart.sh)"
echo "  driver          : node /root/drive.mjs <chatId> \"<text>\""
echo "  rpc             : COMIS_CONFIG_PATHS=$DATA/config.yaml COMIS_GATEWAY_TOKEN=<tok> node /root/revoke.mjs <method> [k] [v]"
echo "Reminder: config.yaml needs a LITERAL gateway token + the emulator apiRoot from /tmp/comis-emu.json."
