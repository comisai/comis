#!/usr/bin/env bash
# VPS (run as ROOT) — restart the PRODUCTION daemon (systemd) and verify the boot from the
# structured log. Replaces the old restart-m1.sh + daemon-supervisor.sh pair: on an installed box
# systemd owns the whole lifecycle (comis.service), INCLUDING the SIGUSR2 exit-42 hot-restart that
# config-mutating RPCs trigger (SuccessExitStatus=42 + RestartForceExitStatus=42 in the unit) — the
# supervisor loop is obsolete. Still the cure for the in-memory per-root budget meter: a restart
# resets it (01-SETUP §3) — run between heavy workloads exactly like restart-m1 used to be.
#
#   Usage:  bash /root/restart-daemon.sh
# Env: SERVICE (comis), DATA (/home/comis/.comis), GW_PORT (4766) — /root/comis-rig.env (rendered
# by deploy-scripts.sh) supplies per-box values; explicit env still wins.
set -uo pipefail
[ -f /root/comis-rig.env ] && . /root/comis-rig.env
SERVICE="${SERVICE:-comis}"
DATA="${DATA:-/home/comis/.comis}"
GW_PORT="${GW_PORT:-4766}"

MARK="$(date +%s)"
systemctl restart "$SERVICE" || {
  echo "systemctl restart $SERVICE FAILED:"
  systemctl status "$SERVICE" --no-pager 2>&1 | tail -8
  exit 1
}

# Authoritative boot record = the structured Pino log (daemon.*.log), not the journal capture.
# Wait for a 'Comis daemon started' line stamped AFTER the restart mark.
booted=""
for _ in $(seq 1 30); do
  line="$(grep -ah 'Comis daemon started' "$DATA"/logs/daemon*.log 2>/dev/null | tail -1)"
  ts="$(printf '%s' "$line" | grep -oE '"time":"[^"]+"' | head -1 | cut -d'"' -f4)"
  if [ -n "$ts" ] && [ "$(date -d "$ts" +%s 2>/dev/null || echo 0)" -ge "$MARK" ]; then
    booted=1
    echo "BOOT OK: $(printf '%s' "$line" | grep -oE '"version":"[^"]+"|"model":"[^"]+"' | tr '\n' ' ') at $ts"
    break
  fi
  sleep 1
done
if [ -z "$booted" ]; then
  echo "NO fresh 'Comis daemon started' within 30s — status + journal tail:"
  systemctl is-active "$SERVICE" || true
  journalctl -u "$SERVICE" --since "@$MARK" --no-pager 2>/dev/null | tail -12
  exit 1
fi

ss -ltnp 2>/dev/null | grep -q ":$GW_PORT" && echo "gateway UP :$GW_PORT" || {
  echo "gateway DOWN — :$GW_PORT not listening (config gateway.enabled? boot FATAL?)"
  exit 1
}
