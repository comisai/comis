#!/usr/bin/env bash
# LOCAL — overlay this checkout's built dist onto the VPS daemon's source tree (no rebuild on the box;
# when the build under test adds no new third-party deps, node_modules on the VPS is fine). Run from anywhere in the repo
# AFTER `pnpm build`.
#   Setup once:  cp scripts/.live-env.example scripts/.live-env  &&  set VPS=user@host (+ SRC).
#   Then (after `pnpm build`):  ./deploy-dist.sh        # .live-env is auto-sourced; or pass VPS=… inline
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$HERE/.live-env" ] && . "$HERE/.live-env"   # per-box rig config (VPS ssh target, SRC, …) — see .live-env.example
REPO="${REPO:-$(git rev-parse --show-toplevel)}"
VPS="${VPS:?set VPS=user@host in scripts/.live-env (see .live-env.example) or the env}"
SRC="${SRC:-/root/comis-src}"

echo "Overlaying $REPO/packages/*/dist  →  $VPS:$SRC …"
# (macOS tar emits harmless 'Ignoring unknown extended header keyword LIBARCHIVE.xattr…' lines.)
( cd "$REPO" && tar czf - packages/*/dist 2>/dev/null ) \
  | ssh -o ConnectTimeout=20 "$VPS" "tar xzf - -C '$SRC' 2>/dev/null && echo extracted"

echo "Verify (recursive — top-level globs miss dist subdirs):"
ssh -o ConnectTimeout=15 "$VPS" "
  echo -n '  orchestrate dist: '; find '$SRC/packages' -path '*/dist/*' -name 'orchestrate-tool.js' | head -1
  echo -n '  REVOKE wiring   : '; grep -lq 'capEndpointHandle?.leaseManager' '$SRC/packages/daemon/dist/daemon.js' && echo present || echo 'ABSENT (pre-b7b5b48c)'
"
echo "Done. Next:  ssh $VPS 'WIPE_CRONS=1 bash /root/clean-restart.sh'   # deploy-scripts.sh installs it to /root/, not /root/lt-scripts"
