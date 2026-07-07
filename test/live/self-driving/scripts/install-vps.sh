#!/usr/bin/env bash
# LOCAL — (re)install the CURRENT checkout onto the VPS as the PRODUCTION installation, through the
# real installer (`website/public/install.sh --tarball`). ONE command covers both box states:
#   • FRESH box   → full bootstrap: system deps (node, ffmpeg, bubblewrap, tmux, build tools, uv,
#                   rust), the dedicated service user, the ~/.npm-global prefix, the systemd unit
#                   (comis.service incl. exit-42 hot-restart handling), enable + start.
#   • EXISTING    → in-place reinstall/upgrade of the `comisai` package from this checkout's build
#                   (config.yaml / secrets / data dir untouched; unit refreshed only if the
#                   installer's template changed).
# The daemon then runs EXACTLY like a user install — systemd, `--permission`, as $COMIS_USER, code at
# $PKG/node_modules/@comis/*/dist — so the live test exercises the same target installation users get.
#
#   Setup once:  cp .live-env.example .live-env  &&  edit VPS=root@host (rest has sane defaults)
#   Then:        ./install-vps.sh               # pnpm build → pack → ship → install.sh → verify
#                SKIP_BUILD=1 ./install-vps.sh  # reuse the existing local dist (already built)
#
# For the fast fix-verify loop AFTER the first install, use deploy-dist.sh (dist overlay + restart);
# come back here whenever third-party deps changed (the overlay ships code, not node_modules).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$HERE/.live-env" ] && . "$HERE/.live-env" # per-box rig config — see .live-env.example
REPO="${REPO:-$(git rev-parse --show-toplevel)}"
VPS="${VPS:?set VPS=user@host in scripts/.live-env (see .live-env.example) or the env}"
COMIS_USER="${COMIS_USER:-comis}"
COMIS_HOME="${COMIS_HOME:-/home/$COMIS_USER}"
DATA="${DATA:-$COMIS_HOME/.comis}"
PKG="${PKG:-$COMIS_HOME/.npm-global/lib/node_modules/comisai}"
SERVICE="${SERVICE:-comis}"

if [ "${SKIP_BUILD:-0}" != 1 ]; then
  echo "1) pnpm build (SKIP_BUILD=1 to reuse the existing dist)…"
  (cd "$REPO" && pnpm build >/dev/null)
fi

echo "2) Pack the umbrella package (prepack bundles every @comis/* into the tarball)…"
rm -f "$REPO"/packages/comis/comisai-*.tgz
# --config.node-linker=hoisted: bundledDependencies needs the hoisted linker (same flag CI's
# `pnpm publish -r` uses in npm-publish.yml); the default isolated linker refuses to pack.
(cd "$REPO/packages/comis" && pnpm pack --config.node-linker=hoisted >/dev/null)
TGZ="$(ls -t "$REPO"/packages/comis/comisai-*.tgz | head -1)"
[ -f "$TGZ" ] || { echo "pack produced no comisai-*.tgz"; exit 1; }
SHA="$(cd "$REPO" && git rev-parse --short HEAD)"
DIRTY="$(cd "$REPO" && git diff --quiet && git diff --cached --quiet && echo clean || echo dirty)"
echo "   $(basename "$TGZ")  (build $SHA/$DIRTY)"

echo "3) Ship tarball + installer to ${VPS}…"
scp -o ConnectTimeout=20 "$TGZ" "$REPO/website/public/install.sh" "$VPS:/root/"

echo "4) Run the production installer (--tarball --no-init; non-interactive over ssh)…"
# shellcheck disable=SC2029 # remote expansion of $(basename …) is intentional
ssh -o ConnectTimeout=20 -o ServerAliveInterval=10 "$VPS" \
  "bash /root/install.sh --tarball /root/$(basename "$TGZ") --no-init" || {
  echo "installer FAILED — rerun with VERBOSE: ssh $VPS 'bash /root/install.sh --tarball /root/$(basename "$TGZ") --no-init --verbose'"
  exit 1
}

echo "5) Restart the service onto the new code + verify (an installer UPGRADE does not restart a"
echo "   running daemon — without this the old code keeps serving; live-proven on the first run)…"
# Self-contained on purpose: on a fresh box the kit helpers (restart-daemon.sh) aren't deployed yet.
ssh -o ConnectTimeout=20 -o ServerAliveInterval=10 "$VPS" "
  set -u
  echo '$SHA $DIRTY  deployed '\$(date -u +%Y-%m-%dT%H:%M:%SZ) > /root/comis-deployed-build
  echo -n '  cli loads    : '; su - $COMIS_USER -c 'comis --version' || { echo 'BROKEN — bundled-deps repair did not hold'; exit 1; }
  MARK=\$(date +%s)
  systemctl restart $SERVICE || { systemctl status $SERVICE --no-pager | tail -8; exit 1; }
  booted=''
  for _ in \$(seq 1 30); do
    line=\$(grep -ah 'Comis daemon started' '$DATA'/logs/daemon*.log 2>/dev/null | tail -1)
    ts=\$(printf '%s' \"\$line\" | grep -oE '\"time\":\"[^\"]+\"' | head -1 | cut -d'\"' -f4)
    [ -n \"\$ts\" ] && [ \$(date -d \"\$ts\" +%s 2>/dev/null || echo 0) -ge \$MARK ] && { booted=1; break; }
    sleep 1
  done
  [ -n \"\$booted\" ] || { echo '  NO fresh daemon boot within 30s:'; journalctl -u $SERVICE --since @\$MARK --no-pager | tail -12; exit 1; }
  echo -n '  service      : '; systemctl is-active $SERVICE
  echo -n '  unit exec    : '; systemctl show -p ExecStart $SERVICE 2>/dev/null | grep -oE '[^ ]*daemon\.js' | head -1
  echo -n '  fresh boot   : '; printf '%s' \"\$line\" | grep -oE '\"time\":\"[^\"]+\"|\"version\":\"[^\"]+\"' | tr '\n' ' '; echo
"
LOCAL_VER="$(node -p "require('$REPO/packages/comis/package.json').version")"
echo "Done. Local build $LOCAL_VER @ $SHA/$DIRTY is installed AND serving on $VPS."
echo "Next: ./deploy-scripts.sh (push helpers + rig env), ssh \$VPS 'bash /root/setup-vps.sh' (once),"
echo "      WIRE=1 ./deploy-emu.sh (emulator), then phase0."
