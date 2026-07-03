#!/usr/bin/env bash
# Copy the self-driving simulator tree (sim/) to the VPS so the running daemon (as
# user `comis`) can launch the per-workload MCP servers and discover the per-workload
# skills. Plain .mjs, zero deps — NO build step. Mirrors scripts/deploy-scripts.sh
# (auto-sources ../scripts/.live-env for the VPS ssh target).
#
#   Setup once:  cp ../scripts/.live-env.example ../scripts/.live-env  &&  edit (VPS=user@host)
#   Then:        bash deploy-sim.sh           # or:  VPS=root@host bash deploy-sim.sh
#
# After it lands, INSTALL onto the running daemon with the commands it prints
# (mcp connect + skills discoveryPath) — see sim/README.md §"Install onto the daemon".
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$HERE/../scripts/.live-env" ] && . "$HERE/../scripts/.live-env"
VPS="${VPS:?set VPS=user@host in scripts/.live-env (see .live-env.example) or pass inline}"
DEST="${SIM_DEST:-/home/comis/sim}"     # where the daemon (comis) will read the sim from

echo "Shipping sim/ → $VPS:$DEST"
# ROBUST tar-pipe (mirrors scripts/deploy-dist.sh), NOT scp -r. Two reasons it replaced scp -rq:
# (a) `scp -rq` HANGS on a high-latency link (a 2-min timeout on a 508K
# tree) — tar-over-ssh streams in one connection and does not; (b) the old order was DESTRUCTIVE on
# failure — it `rm -rf $DEST` then `mv $DEST.tmp $DEST`, so a failed/incomplete scp left the live sim
# dir WIPED (the "sim vanished" detour). Here the `rm $DEST && mv` runs ONLY after a successful extract
# in the same && chain, staged in $DEST.new, so a transfer failure leaves $DEST untouched.
tar czf - -C "$HERE/.." "$(basename "$HERE")" | ssh -o ConnectTimeout=20 -o ServerAliveInterval=10 "$VPS" "
  set -e
  rm -rf '${DEST}.new' && mkdir -p '${DEST}.new'
  tar xzf - -C '${DEST}.new' --strip-components=1     # drop the sim/ prefix → files land directly
  [ -f '${DEST}.new/bin/mcp-server.mjs' ] || { echo 'TRANSFER INCOMPLETE — keeping existing \$DEST'; exit 1; }
  rm -rf '$DEST' && mv '${DEST}.new' '$DEST'
  chown -R comis:comis '$DEST' 2>/dev/null || true
  echo '=== workloads on the box ==='
  for d in '$DEST'/*/; do [ -f \"\$d/tools.json\" ] && basename \"\$d\"; done
"
echo
echo "Deployed. Next — INSTALL onto the running daemon (CLI is not on PATH):"
echo "  # 1. connect a workload's MCP server (LIVE, no restart):"
echo "  #    NOTE: --args is VARIADIC (space-separated) — do NOT comma-join path,workload"
echo "  node packages/cli/dist/cli.js mcp connect th-sim \\"
echo "    --transport stdio --command node --args $DEST/bin/mcp-server.mjs threat-hunting"
echo "  node packages/cli/dist/cli.js mcp list          # confirm: th-sim connected, N tools"
echo "  # 2. let the agent discover that workload's SKILL.md (add to discoveryPaths + restart once):"
echo "  #    cfg-patch agents.<id>.skills.discoveryPaths += \"$DEST/threat-hunting\""
echo "  # See sim/README.md for the full from-scratch memory/learning drive."
