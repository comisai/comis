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
#   pm2 is used when it already supervises the service. Otherwise `auto` uses tmux when available so
#   shells/agent runners that reap background descendants cannot kill the daemon after this script
#   exits; a plain direct launch remains the final fallback.
#     Usage:  ./restart-daemon.sh            # from scripts/, with RIG_MODE=local in .live-env
#             LOCAL_SUPERVISOR=tmux ./restart-daemon.sh
#             LOCAL_SUPERVISOR=direct ./restart-daemon.sh
#
# Env: SERVICE, DATA, GW_PORT — the rig env file supplies per-rig values; explicit env still wins.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The kit ships as a unit, so a missing _rig.sh is a stale deploy — fail LOUD naming the fix rather
# than silently falling back to one mode's behaviour on the other mode's rig.
# shellcheck source=./_rig.sh
. "$HERE/_rig.sh" 2>/dev/null || {
  echo "missing $HERE/_rig.sh — re-run deploy-scripts.sh (the kit ships as a unit)" >&2
  exit 2
}
rig_load_env "$HERE/.live-env" "$HERE/.rig-env" /root/comis-rig.env
SERVICE="${SERVICE:-comis}"
DATA="${DATA:-/home/comis/.comis}"
GW_PORT="${GW_PORT:-4766}"

if rig_is_local; then
  if ! COMIS_TRAJECTORY_DIR="$(rig_local_trajectory_dir)"; then
    exit 2
  fi
  export COMIS_TRAJECTORY_DIR
  node "$HERE/local-config.mjs" validate "$DATA/config.yaml" "$DATA" "$GW_PORT" || exit $?
fi

MARK="$(date +%s)"

if rig_is_local; then
  # ---- LOCAL: explicit stop → detached relaunch --------------------------------------------------
  local_supervisor="${LOCAL_SUPERVISOR:-auto}"
  rig_assert_local_lifecycle_owner || exit $?
  use_pm2=0
  use_tmux=0
  case "$local_supervisor" in
  auto)
    if rig_pm2_manages; then
      use_pm2=1
    elif command -v tmux >/dev/null 2>&1; then
      use_tmux=1
    fi
    ;;
  pm2)
    if rig_pm2_manages; then
      use_pm2=1
    else
      echo "LOCAL_SUPERVISOR=pm2 but pm2 is not managing '$SERVICE'"
      exit 1
    fi
    ;;
  tmux)
    if command -v tmux >/dev/null 2>&1; then
      use_tmux=1
    else
      echo "LOCAL_SUPERVISOR=tmux but tmux is not installed"
      exit 1
    fi
    ;;
  direct) ;;
  *)
    echo "LOCAL_SUPERVISOR must be auto|pm2|tmux|direct (got '$local_supervisor')"
    exit 2
    ;;
  esac

  if [ "$use_pm2" = 1 ]; then
    echo "supervisor: pm2 (${SERVICE})"
    COMIS_DATA_DIR="$DATA" COMIS_CONFIG_PATHS="$DATA/config.yaml" COMIS_TRAJECTORY_DIR="$COMIS_TRAJECTORY_DIR" \
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
    if [ "$use_tmux" = 1 ]; then
      tmux_session="${LOCAL_TMUX_SESSION:-comis-${SERVICE}}"
      tmux kill-session -t "$tmux_session" 2>/dev/null || true
      for _ in $(seq 1 15); do
        rig_port_listening "$GW_PORT" || break
        sleep 1
      done
      if rig_port_listening "$GW_PORT"; then
        echo "gateway port $GW_PORT is still owned after stopping tmux session '$tmux_session'; refusing to kill another process"
        exit 1
      fi
      echo "supervisor: tmux ($tmux_session, $ENTRY)"
      # Keep COMIS_CONFIG_PATHS on the child command line. The tmux server owns
      # the child after this shell exits, including under PTY/agent runners that
      # reap ordinary nohup descendants. Exit 42 is the daemon's requested
      # config-reload contract, so the local supervisor must relaunch it just as
      # the production systemd unit does. Any other exit remains terminal.
      # `status` is a read-only special parameter in zsh, which tmux commonly
      # selects as the local command shell, so use a portable variable name.
      # Redirect the whole supervisor loop so shell-level failures are visible.
      tmux new-session -d -s "$tmux_session" \
        "while true; do env COMIS_DATA_DIR='$DATA' COMIS_CONFIG_PATHS='$DATA/config.yaml' COMIS_TRAJECTORY_DIR='$COMIS_TRAJECTORY_DIR' node ${NODE_ARGS:-} '$ENTRY'; daemon_exit_code=\$?; if [ \"\$daemon_exit_code\" -eq 42 ]; then continue; fi; exit \"\$daemon_exit_code\"; done >>'$DATA/daemon.console.log' 2>&1"
      tmux set-environment -t "$tmux_session" COMIS_LOCAL_DATA_OWNER "$DATA"
    else
      pid="$(LOCAL_SUPERVISOR=direct rig_daemon_pid)"
      if [ -n "$pid" ]; then
        kill "$pid" 2>/dev/null
        for _ in $(seq 1 15); do
          kill -0 "$pid" 2>/dev/null || break
          sleep 1
        done
        kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null
      fi
      for _ in $(seq 1 15); do
        rig_port_listening "$GW_PORT" || break
        sleep 1
      done
      if rig_port_listening "$GW_PORT"; then
        echo "gateway port $GW_PORT is owned by an unscoped process; refusing to stop it"
        exit 1
      fi
      echo "supervisor: direct ($ENTRY)"
      pid_file="${LOCAL_DAEMON_PID_FILE:-$DATA/.local-daemon.pid}"
      # shellcheck disable=SC2016 # trap variables expand inside the nested supervisor shell
      COMIS_LOCAL_DATA="$DATA" COMIS_LOCAL_ENTRY="$ENTRY" COMIS_LOCAL_PID_FILE="$pid_file" COMIS_LOCAL_TRAJECTORY_DIR="$COMIS_TRAJECTORY_DIR" \
        nohup bash -c '
          trap '\''[ -n "${daemon_pid:-}" ] && kill "$daemon_pid" 2>/dev/null || true; rm -f "$COMIS_LOCAL_PID_FILE"; exit 143'\'' TERM INT
          trap '\''rm -f "$COMIS_LOCAL_PID_FILE"'\'' EXIT
          while true; do
            env COMIS_DATA_DIR="$COMIS_LOCAL_DATA" COMIS_CONFIG_PATHS="$COMIS_LOCAL_DATA/config.yaml" COMIS_TRAJECTORY_DIR="$COMIS_LOCAL_TRAJECTORY_DIR" node ${NODE_ARGS:-} "$COMIS_LOCAL_ENTRY" &
            daemon_pid=$!
            umask 077
            printf "%s\n" "$daemon_pid" >"$COMIS_LOCAL_PID_FILE"
            wait "$daemon_pid"
            daemon_exit_code=$?
            [ "$daemon_exit_code" -eq 42 ] || exit "$daemon_exit_code"
          done
        ' >>"$DATA/daemon.console.log" 2>&1 &
      disown 2>/dev/null || true
    fi
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
# The budget covers supervisor spawn + node startup + the whole boot sequence, not boot alone.
# A cold boot on a populated data root spends ~8s before the daemon writes its FIRST log line
# (tmux/systemd spawn, node module graph) and the boot itself can then run 20s+ — wiring channels,
# resolving operation models, reconciling cron/follow-up ownership, seeding skills. At 30s total
# that left ~22s of real headroom and a 22.4s boot reported "NO fresh 'Comis daemon started'" 0.8s
# before the line landed: a healthy daemon that reads as broken, which is the exact cycle-burner
# this boot-verify exists to retire. The loop exits the moment the line appears, so a generous
# ceiling costs a slow rig nothing and costs a fast one nothing at all.
BOOT_WAIT_SECS="${BOOT_WAIT_SECS:-90}"
for _ in $(seq 1 "$BOOT_WAIT_SECS"); do
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
  echo "NO fresh 'Comis daemon started' within ${BOOT_WAIT_SECS}s — diagnostics:"
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
