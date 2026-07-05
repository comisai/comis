#!/usr/bin/env bash
# LOCAL — overlay this checkout's built dist onto the VPS's PRODUCTION installation (the npm-global
# comisai package install-vps.sh put there). The fast fix-verify loop: after `pnpm build`, ship ONLY
# the changed code (seconds), then `ssh $VPS 'bash /root/restart-daemon.sh'`. No rebuild on the box.
#
# Layout mapping (source checkout → installed package):
#   packages/<dir>/dist   →  $PKG/node_modules/@comis/<name>/dist    (name from the package.json)
#   packages/comis/dist   →  $PKG/dist                               (the umbrella package itself)
#
#   Setup once:  cp scripts/.live-env.example scripts/.live-env  &&  set VPS=user@host (+ PKG).
#   Then (after `pnpm build`):  ./deploy-dist.sh        # .live-env is auto-sourced; or pass VPS=… inline
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$HERE/.live-env" ] && . "$HERE/.live-env" # per-box rig config (VPS ssh target, PKG, …) — see .live-env.example
REPO="${REPO:-$(git rev-parse --show-toplevel)}"
VPS="${VPS:?set VPS=user@host in scripts/.live-env (see .live-env.example) or the env}"
COMIS_USER="${COMIS_USER:-comis}"
COMIS_HOME="${COMIS_HOME:-/home/$COMIS_USER}"
PKG="${PKG:-$COMIS_HOME/.npm-global/lib/node_modules/comisai}"

# Stage the dists in the INSTALLED layout, then ship ONE tar stream.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
shipped=0
for dir in "$REPO"/packages/*/; do
  name="$(node -p "require('$dir/package.json').name" 2>/dev/null)" || continue
  [ -d "$dir/dist" ] || { echo "  ⚠ $(basename "$dir") has no dist/ — did pnpm build run?"; continue; }
  case "$name" in
  comisai) dest="$STAGE" ;;
  @comis/*) dest="$STAGE/node_modules/$name" ;;
  *) continue ;;
  esac
  mkdir -p "$dest"
  cp -R "$dir/dist" "$dest/"
  shipped=$((shipped + 1))
done
[ "$shipped" -gt 0 ] || { echo "nothing staged — run pnpm build first"; exit 1; }

echo "Overlaying $shipped package dists  →  $VPS:$PKG …"
SHA="$(cd "$REPO" && git rev-parse --short HEAD)"
DIRTY="$(cd "$REPO" && git diff --quiet && git diff --cached --quiet && echo clean || echo dirty)"
# (macOS tar emits harmless 'Ignoring unknown extended header keyword LIBARCHIVE.xattr…' lines.)
# The provenance record moves WITH the code — a dist overlay that left the install-time record in
# place made /root/comis-deployed-build lie about the running build (the stale-provenance trap).
(cd "$STAGE" && tar czf - . 2>/dev/null) \
  | ssh -o ConnectTimeout=20 "$VPS" "tar xzf - -C '$PKG' 2>/dev/null && chown -R $COMIS_USER:$COMIS_USER '$PKG' \
      && echo '$SHA $DIRTY  dist-overlay '\$(date -u +%Y-%m-%dT%H:%M:%SZ) > /root/comis-deployed-build \
      && echo extracted"

echo "Verify (recursive — top-level globs miss dist subdirs):"
ssh -o ConnectTimeout=15 "$VPS" "
  echo -n '  orchestrate dist: '; find '$PKG/node_modules/@comis/skills/dist' -name 'orchestrate-tool.js' 2>/dev/null | head -1
  echo -n '  daemon wiring   : '; ls '$PKG/node_modules/@comis/daemon/dist/wiring' >/dev/null 2>&1 && echo present || echo MISSING
"

# DEP-DRIFT GUARD. A dist overlay ships code, NOT node_modules — so a build whose HEAD
# BUMPED a third-party dep (a new export subpath, a moved file) crashes the daemon on
# boot with ERR_PACKAGE_PATH_NOT_EXPORTED / ERR_MODULE_NOT_FOUND, AFTER a clean deploy+
# restart (a cycle-costing false "the daemon is broken"). Compare the volatile,
# load-bearing deps local-vs-box; a mismatch means the box needs a FULL reinstall.
echo "Dep-drift guard (dist overlay does NOT sync node_modules):"
drift=0
for dep in @earendil-works/pi-ai @earendil-works/pi-agent-core; do
  loc="$(node -p "try{require('$REPO/node_modules/$dep/package.json').version}catch{'?'}" 2>/dev/null)"
  box="$(ssh -o ConnectTimeout=15 "$VPS" "node -p \"try{require('$PKG/node_modules/$dep/package.json').version}catch{'?'}\"" 2>/dev/null)"
  if [ "$loc" = "$box" ]; then
    echo "  ok  $dep  $loc"
  else
    echo "  ⚠  $dep  local=$loc  box=$box  — DRIFT"
    drift=1
  fi
done
if [ "$drift" = 1 ]; then
  echo "  ⚠ the installed node_modules is STALE for the deployed dist — the daemon will likely FATAL"
  echo "    on boot (ERR_PACKAGE_PATH_NOT_EXPORTED). Do a FULL reinstall from this checkout instead:"
  echo "      ./install-vps.sh    # rebuild + pack + install.sh --tarball (ships matching deps)"
fi
echo "Done. Next:  ssh \$VPS 'bash /root/restart-daemon.sh'   # or clean-restart.sh for a fresh slate"
