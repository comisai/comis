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
#
# RIG_MODE=local: there is nothing to push — the kit IS this directory. The script then only does the
# half that still matters locally: resolve the gateway token and render the rig env file
# (scripts/.rig-env) the same helpers read, so the RPC oracles work without an env prefix.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELECTED_RIG_ENV="${RIG_ENV:-$HERE/.rig-env}"
# shellcheck source=./_remote-root.sh
. "$HERE/_remote-root.sh"
rig_load_env "$HERE/.live-env" "$SELECTED_RIG_ENV"
PKG="${PKG:-$COMIS_HOME/.npm-global/lib/node_modules/comisai}"
if ! rig_is_local; then
  VPS="${VPS:?set VPS=user@host in scripts/.live-env (see .live-env.example) or the env}"
fi

# $KIT_DIR — ALL driver/oracle helpers, pushed FIRST (the token auto-fetch below uses rig-token.mjs).
# GLOB every *.mjs + the box-run *.sh (a hardcoded list silently DROPPED new helpers —
# reflect-run.mjs/seed.mjs didn't deploy; a glob means a new helper auto-deploys, no list to
# maintain). _rig.mjs rides the same glob, so the `./_rig.mjs` imports resolve on the box exactly
# like they do locally; config.example.yaml ships for init-config.mjs (the fresh-box bootstrap).
# LOCAL-only scripts (the deploy-*/install-* family, run-linux-tests, verify-build, rig-doctor, and
# this transport helper) are excluded from the remote kit push. A tar stream works for both a direct-root
# SSH target and an unprivileged target using REMOTE_SUDO=1; no protected staging path is needed.
if rig_is_local; then
  echo "local rig — kit push skipped (the helpers ARE $HERE); rendering $RIG_ENV only"
else
  box_files=("$HERE"/*.mjs "$HERE/config.example.yaml")
  for file in "$HERE"/*.sh; do
    case "$(basename "$file")" in
    deploy-scripts.sh | deploy-dist.sh | deploy-emu.sh | install-vps.sh | run-linux-tests.sh | verify-build.sh | rig-doctor.sh | local-up.sh | _remote-root.sh) ;;
    *) box_files+=("$file") ;;
    esac
  done
  relative_files=()
  for file in "${box_files[@]}"; do relative_files+=("${file#"$HERE/"}"); done
  COPYFILE_DISABLE=1 tar --no-xattrs -C "$HERE" -cf - "${relative_files[@]}" |
    remote_root "mkdir -p '$KIT_DIR' && tar -xf - -C '$KIT_DIR'"
fi

# GWTOKEN auto-fetch — when .live-env doesn't carry it, resolve it FROM THE BOX so the rendered
# rig env (and every RPC helper) still works: the secrets store first (`comis secrets get` — the
# production `comis init` flow), then a config.yaml literal (rig-token.mjs — the hand-written /
# init-config.mjs flow). Also self-heals token ROTATION: a re-deploy re-fetches the current value
# instead of shipping a stale one that 4001s mid-run.
#
# A NON-EMPTY .live-env token is never trusted as belonging to the selected rig. The gateway health
# endpoint is public, so probing it with an Authorization header cannot validate a token. Resolve the
# selected rig's encrypted store (or literal config fallback) every time instead. This also makes local
# multi-rig switching safe: a checkout-level .rig-env may describe a different isolated DATA root.
resolved_gateway_token=""
if rig_is_local; then
  # The `comis` CLI is not on PATH in a checkout — call the built dist directly.
  resolved_gateway_token="$(
    COMIS_DATA_DIR="$DATA" COMIS_CONFIG_PATHS="$DATA/config.yaml" \
      node "$REPO/packages/cli/dist/cli.js" secrets get --offline COMIS_GATEWAY_TOKEN 2>/dev/null \
      | tail -1 | tr -d '[:space:]'
  )" || true
  src="the local secrets store"
else
  resolved_gateway_token="$(
    remote_root "su - $COMIS_USER -c 'comis secrets get --offline COMIS_GATEWAY_TOKEN' 2>/dev/null" \
      | tail -1 | tr -d '[:space:]'
  )" || true
  src="the box secrets store"
fi
if [ "${#resolved_gateway_token}" -lt 32 ]; then
  resolved_gateway_token="$(remote_root "node '$KIT_DIR/rig-token.mjs' 2>/dev/null" | tr -d '[:space:]')" || true
  src="the config.yaml literal"
fi
if [ "${#resolved_gateway_token}" -ge 32 ]; then
  if [ -n "${GWTOKEN:-}" ] && [ "$GWTOKEN" != "$resolved_gateway_token" ]; then
    echo "⚠ the configured GWTOKEN does not match the selected rig — using its resolved token"
  fi
  GWTOKEN="$resolved_gateway_token"
  echo "GWTOKEN resolved from $src"
elif [ -z "${GWTOKEN:-}" ] || [ "${#GWTOKEN}" -lt 32 ]; then
  GWTOKEN=""
  echo "⚠ GWTOKEN unset and not resolvable from the rig (no config yet?) — the RPC helpers will 401"
  echo "  until it exists. Fresh rig: run 'node $KIT_DIR/init-config.mjs' next (it generates the"
  echo "  token and updates $RIG_ENV itself)."
fi

# The rig env file — rendered from THIS .live-env. Rig-side scripts source it; the .mjs helpers read
# it via _rig.mjs. The `${VAR:-…}` form keeps explicit-env-wins semantics. Local RPC clients resolve
# the gateway token from the encrypted store through the config reference, so persisting the token in
# the local data root would create secret residency. Remote rigs retain the protected box-side value.
# RIG_MODE is rendered too, so a helper invoked bare (no .live-env in scope) still resolves the right
# data dir / layout instead of silently assuming the production-install one.
rendered_gateway_token="${GWTOKEN:-}"
if rig_is_local; then rendered_gateway_token=""; fi
remote_root "umask 077 && cat > '$RIG_ENV'" <<EOF
# Rendered by deploy-scripts.sh from the local scripts/.live-env — do not hand-edit (re-render instead).
export RIG_MODE="\${RIG_MODE:-$(rig_mode)}"
export COMIS_USER="\${COMIS_USER:-$COMIS_USER}"
export COMIS_HOME="\${COMIS_HOME:-$COMIS_HOME}"
export DATA="\${DATA:-$DATA}"
export PKG="\${PKG:-$PKG}"
export SERVICE="\${SERVICE:-$SERVICE}"
export GW_PORT="\${GW_PORT:-$GW_PORT}"
export COMIS_TRAJECTORY_DIR="\${COMIS_TRAJECTORY_DIR:-${COMIS_TRAJECTORY_DIR:-}}"
export CHATID="\${CHATID:-$CHATID}"
export EMU_DIR="\${EMU_DIR:-$EMU_DIR}"
export GWTOKEN="\${GWTOKEN:-${rendered_gateway_token:-}}"
EOF

remote_root "
  echo '=== kit at $KIT_DIR ==='; ls -1 '$KIT_DIR'/*.mjs '$KIT_DIR'/clean-restart.sh '$KIT_DIR'/restart-daemon.sh '$KIT_DIR'/models-sweep.sh 2>/dev/null | head -40
  echo '=== rig env ==='; ls -l '$RIG_ENV'; grep -c '^export' '$RIG_ENV'
"
if rig_is_local; then
  echo "local rig env rendered at $RIG_ENV (pnpm build produces the daemon under test; ./local-up.sh brings the rig up)"
else
  echo "kit deployed to $VPS (install-vps.sh installs the daemon; setup-vps.sh preps the box once)"
fi
