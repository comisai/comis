#!/usr/bin/env bash
# Push the WHOLE current scripts/ kit to the VPS in ONE step (no drift), and render the box-side
# rig config (/root/comis-rig.env) from the local .live-env. Run from anywhere — it resolves its
# own dir. WHY: the scripts ON THE BOX drift from this local kit (helpers go missing, stale
# one-offs linger — cost archaeology + per-run scp's), and the box-side helpers/scripts need the
# same per-box values (.live-env) the local scripts auto-source. The emulator (test/live/) is
# deployed separately (deploy-emu.sh); the daemon code via install-vps.sh / deploy-dist.sh.
#
#   Setup once:  cp .live-env.example .live-env  &&  edit it (VPS=user@host; GWTOKEN optional —
#                it auto-fetches from the box when unset)
#   Then:        bash deploy-scripts.sh            # .live-env is auto-sourced; or pass VPS=… inline
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$HERE/.live-env" ] && . "$HERE/.live-env" # per-box rig config (VPS ssh target, GWTOKEN, …) — see .live-env.example
# shellcheck source=./_remote-root.sh
. "$HERE/_remote-root.sh"
VPS="${VPS:?set VPS=user@host in scripts/.live-env (see .live-env.example) or the env}"
COMIS_USER="${COMIS_USER:-comis}"
COMIS_HOME="${COMIS_HOME:-/home/$COMIS_USER}"
DATA="${DATA:-$COMIS_HOME/.comis}"
PKG="${PKG:-$COMIS_HOME/.npm-global/lib/node_modules/comisai}"
SERVICE="${SERVICE:-comis}"
GW_PORT="${GW_PORT:-4766}"
CHATID="${CHATID:-678314278}"
EMU_DIR="${EMU_DIR:-/root/comis-emu}"

# /root — ALL driver/oracle helpers, pushed FIRST (the token auto-fetch below uses rig-token.mjs).
# GLOB every *.mjs + the box-run *.sh (a hardcoded list silently DROPPED new helpers —
# reflect-run.mjs/seed.mjs didn't deploy; a glob means a new helper auto-deploys, no list to
# maintain). _rig.mjs rides the same glob, so the `./_rig.mjs` imports resolve on the box exactly
# like they do locally; config.example.yaml ships for init-config.mjs (the fresh-box bootstrap).
# LOCAL-only scripts (the deploy-*/install-* family, run-linux-tests, verify-build, rig-doctor, and
# this transport helper) are excluded from the /root push. A tar stream works for both a direct-root
# SSH target and an unprivileged target using REMOTE_SUDO=1; no protected staging path is needed.
box_files=("$HERE"/*.mjs "$HERE/config.example.yaml")
for file in "$HERE"/*.sh; do
  case "$(basename "$file")" in
  deploy-scripts.sh|deploy-dist.sh|deploy-emu.sh|install-vps.sh|run-linux-tests.sh|verify-build.sh|rig-doctor.sh|_remote-root.sh) ;;
  *) box_files+=("$file") ;;
  esac
done
relative_files=()
for file in "${box_files[@]}"; do relative_files+=("${file#"$HERE/"}"); done
tar --no-xattrs -C "$HERE" -cf - "${relative_files[@]}" | remote_root "tar -xf - -C /root"

# GWTOKEN auto-fetch — when .live-env doesn't carry it, resolve it FROM THE BOX so the rendered
# rig env (and every RPC helper) still works: the secrets store first (`comis secrets get` — the
# production `comis init` flow), then a config.yaml literal (rig-token.mjs — the hand-written /
# init-config.mjs flow). Also self-heals token ROTATION: a re-deploy re-fetches the current value
# instead of shipping a stale one that 4001s mid-run.
if [ -z "${GWTOKEN:-}" ]; then
  GWTOKEN="$(remote_root "su - $COMIS_USER -c 'comis secrets get --offline COMIS_GATEWAY_TOKEN' 2>/dev/null" | tail -1 | tr -d '[:space:]')" || true
  src="the box secrets store"
  if [ "${#GWTOKEN}" -lt 32 ]; then
    GWTOKEN="$(remote_root 'node /root/rig-token.mjs 2>/dev/null' | tr -d '[:space:]')" || true
    src="the config.yaml literal"
  fi
  if [ "${#GWTOKEN}" -ge 32 ]; then
    echo "GWTOKEN auto-fetched from $src (set it in .live-env to skip this ssh round-trip)"
  else
    GWTOKEN=""
    echo "⚠ GWTOKEN unset and not resolvable from the box (fresh box with no config yet?) — the RPC"
    echo "  helpers will 401 until it exists. Fresh box: run 'node /root/init-config.mjs' next (it"
    echo "  generates the token and updates /root/comis-rig.env itself)."
  fi
fi

# /root/comis-rig.env — the box-side rig config, rendered from THIS .live-env. Box scripts source it;
# .mjs helpers read it via _rig.mjs. The `${VAR:-…}` form keeps explicit-env-wins semantics on the box.
# 0600: it carries GWTOKEN (root already reads config.yaml on this rig, so no new exposure).
remote_root "umask 077 && cat > /root/comis-rig.env" <<EOF
# Rendered by deploy-scripts.sh from the local scripts/.live-env — do not hand-edit (re-deploy instead).
export COMIS_USER="\${COMIS_USER:-$COMIS_USER}"
export COMIS_HOME="\${COMIS_HOME:-$COMIS_HOME}"
export DATA="\${DATA:-$DATA}"
export PKG="\${PKG:-$PKG}"
export SERVICE="\${SERVICE:-$SERVICE}"
export GW_PORT="\${GW_PORT:-$GW_PORT}"
export CHATID="\${CHATID:-$CHATID}"
export EMU_DIR="\${EMU_DIR:-$EMU_DIR}"
export GWTOKEN="\${GWTOKEN:-${GWTOKEN:-}}"
EOF

remote_root '
  echo "=== kit on /root ==="; ls -1 /root/*.mjs /root/clean-restart.sh /root/restart-daemon.sh /root/models-sweep.sh 2>/dev/null
  echo "=== rig env ==="; ls -l /root/comis-rig.env; grep -c "^export" /root/comis-rig.env
'
echo "kit deployed to $VPS (install-vps.sh installs the daemon; setup-vps.sh preps the box once)"
