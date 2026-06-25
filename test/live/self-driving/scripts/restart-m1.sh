#!/usr/bin/env bash
# VPS — kill + (re)launch the daemon AS the comis user (production-faithful: --permission, run as comis
# so os.homedir()=/home/comis and writes land in the allowed ~/.comis). Installed by setup-vps.sh to
# /home/comis/restart-m1.sh. Invoke via:  su - comis -c 'bash /home/comis/restart-m1.sh'
#
# Launches the daemon UNDER A SUPERVISOR (daemon-supervisor.sh) that relaunches on exit 42 — Comis's
# SIGUSR2 restart-hint, fired by config.patch/apply, heartbeat.update, gateway.restart, token ops, and
# skills_manage. Without it, the first config-mutating RPC leaves the daemon dead (F-RIG-1).
#
# Override via env: SRC (src tree), DATA (data dir). GWTOKEN (the ≥32-char gateway token) is read from
# the env or the sourced ~/.comis/.env below — NO literal default in the repo (set it per box; see
# scripts/.live-env.example). It MUST match config.yaml's gateway.tokens[].secret.
SRC="${SRC:-/root/comis-src}"
DATA="${DATA:-/home/comis/.comis}"
SUPERVISOR="${SUPERVISOR:-$HOME/daemon-supervisor.sh}"

# Anchored ^node so we never match this shell (whose argv contains "daemon.js"). Also stop any prior
# supervisor loop (else it would relaunch the daemon we just killed).
pkill -9 -f "^node .*daemon\.js" 2>/dev/null
pkill -9 -f "daemon-supervisor\.sh" 2>/dev/null
sleep 1

set -a; . "$DATA/.env"; set +a            # SECRETS_MASTER_KEY (+ GWTOKEN) for the encrypted store / gateway
: "${GWTOKEN:?set GWTOKEN in ~/.comis/.env or the env (see scripts/.live-env.example) — must match config.yaml secret}"
export COMIS_CONFIG_PATHS="$DATA/config.yaml"
export COMIS_GATEWAY_TOKEN="$GWTOKEN"
export SRC DATA                            # consumed by the supervisor loop
cd "$SRC"
setsid bash "$SUPERVISOR" >/dev/null 2>&1 </dev/null &
sleep 1
echo "relaunched daemon as $(whoami) under supervisor (relaunch-on-42; log: $HOME/comis-m1.log)"
