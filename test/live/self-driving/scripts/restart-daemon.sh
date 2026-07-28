#!/usr/bin/env bash
# Restart the daemon under test and VERIFY the boot from the structured log — the one restart entry
# point both rigs share. It is also the cure for the in-memory per-root budget meter: a restart
# resets it (01-SETUP §3), so run it between heavy workloads.
#
# RIG_MODE=remote (default) — VPS, run as ROOT. systemd owns the whole lifecycle (comis.service),
#   INCLUDING the SIGUSR2 exit-42 hot-restart that config-mutating RPCs trigger (SuccessExitStatus=42
#   + RestartForceExitStatus=42 in the unit).
#     Usage:  bash /root/restart-daemon.sh
#
# RIG_MODE=local — THIS machine. There is no systemd, so the lifecycle is explicit: stop the running
#   daemon, relaunch it detached from this checkout's dist, then run the SAME boot verification.
#   pm2 is used when it already supervises the service (LOCAL_SUPERVISOR=auto detects it); otherwise
#   the daemon is relaunched directly, which is the shape a production install runs anyway.
#     Usage:  ./restart-daemon.sh            # from scripts/, with RIG_MODE=local in .live-env
#             LOCAL_SUPERVISOR=direct ./restart-daemon.sh
#
# Env: SERVICE, DATA, GW_PORT — the rig env file supplies per-rig values; explicit env still wins.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$HERE/.live-env" ] && . "$HERE/.live-env"
# The kit ships as a unit, so a missing _rig.sh is a stale deploy — fail LOUD naming the fix rather
# than silently falling back to one mode's behaviour on the other mode's rig.
# shellcheck source=./_rig.sh
. "$HERE/_rig.sh" 2>/dev/null || {
  echo "missing $HERE/_rig.sh — re-run deploy-scripts.sh (the kit ships as a unit)" >&2
  exit 2
}
for _f in "${RIG_ENV:-}" "$HERE/.rig-env" /root/comis-rig.env; do
  # shellcheck disable=SC1090 # the rig env path is mode-resolved at run time
  [ -n "$_f" ] && [ -f "$_f" ] && . "$_f" && break
done
rig_defaults
SERVICE="${SERVICE:-comis}"
DATA="${DATA:-/home/comis/.comis}"
GW_PORT="${GW_PORT:-4766}"

MARK="$(date +%s)"

if rig_is_local; then
  # ---- LOCAL: explicit stop → detached relaunch --------------------------------------------------
  if [ "${LOCAL_SUPERVISOR:-auto}" != "direct" ] && rig_pm2_manages; then
    echo "supervisor: pm2 (${SERVICE})"
    pm2 restart "$SERVICE" --update-env >/dev/null || {
      echo "pm2 restart $SERVICE FAILED:"
      pm2 describe "$SERVICE" 2>&1 | tail -8
      exit 1
    }
  else
    ENTRY="$(rig_daemon_entry)"
    if [ -z "$ENTRY" ]; then
      echo "no daemon dist found (PKG=$PKG, REPO=${REPO:-unset}) — run 'pnpm build' in the checkout first"
      exit 1
    fi
    pid="$(rig_daemon_pid)"
    if [ -n "$pid" ]; then
      kill "$pid" 2>/dev/null
      for _ in $(seq 1 15); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 1
      done
      kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null
    fi
    echo "supervisor: direct ($ENTRY)"
    # COMIS_CONFIG_PATHS must be on the command line: an `export` does not survive into a process
    # backgrounded from a tool/agent shell, and the daemon then boots against a different config
    # than the one this rig just wired (the silent wrong-config class).
    COMIS_CONFIG_PATHS="$DATA/config.yaml" nohup node ${NODE_ARGS:-} "$ENTRY" \
      >>"$DATA/daemon.console.log" 2>&1 &
    disown 2>/dev/null || true
  fi
else
  # ---- REMOTE: systemd owns the lifecycle ---------------------------------------------------------
  systemctl restart "$SERVICE" || {
    echo "systemctl restart $SERVICE FAILED:"
    systemctl status "$SERVICE" --no-pager 2>&1 | tail -8
    exit 1
  }
fi

# Authoritative boot record = the structured Pino log (daemon.*.log), not the journal / console
# capture. Wait for a 'Comis daemon started' line stamped AFTER the restart mark.
booted=""
for _ in $(seq 1 30); do
  line="$(grep -ah 'Comis daemon started' "$DATA"/logs/daemon*.log 2>/dev/null | tail -1)"
  ts="$(printf '%s' "$line" | grep -oE '"time":"[^"]+"' | head -1 | cut -d'"' -f4)"
  if [ -n "$ts" ] && [ "$(rig_epoch "$ts")" -ge "$MARK" ]; then
    booted=1
    echo "BOOT OK: $(printf '%s' "$line" | grep -oE '"version":"[^"]+"|"model":"[^"]+"' | tr '\n' ' ') at $ts"
    break
  fi
  sleep 1
done
if [ -z "$booted" ]; then
  echo "NO fresh 'Comis daemon started' within 30s — diagnostics:"
  if rig_is_local; then
    tail -12 "$DATA/daemon.console.log" 2>/dev/null
  else
    systemctl is-active "$SERVICE" || true
    journalctl -u "$SERVICE" --since "@$MARK" --no-pager 2>/dev/null | tail -12
  fi
  exit 1
fi

if rig_port_listening "$GW_PORT"; then
  echo "gateway UP :$GW_PORT"
else
  echo "gateway DOWN — :$GW_PORT not listening (config gateway.enabled? boot FATAL?)"
  exit 1
fi
