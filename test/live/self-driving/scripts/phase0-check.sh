#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# phase0-check.sh — PREFLIGHT readiness gate for a webhook→claude TERMINAL-DRIVE test. Run ON THE VPS.
#
# WHY: a webhook→claude run can burn turns discovering the rig wasn't ready ONE
# check at a time — a FATAL config (the terminal schema needs a full `worker` + `defaults` block, not
# optional), webhooks that were off, a missing terminal allow-entry, the daemon pinned to a stale dist.
# Each was a hand-grep after a failed drive. This gate runs ALL of them BEFORE you POST, so a red rig
# fails in 2s with a named cause instead of a silent dead-lettered drive minutes later.
#
# It is READ-ONLY (no restart, no config edit) and needs NO gateway token or HMAC secret — the webhook
# probe is deliberately UNSIGNED (expects 401), which proves the route is mounted AND auth is active
# without holding the secret. Exit 0 = ready to drive; non-zero = a named blocker (count in the summary).
#
# Usage (on the VPS):   bash /root/phase0-check.sh [webhookPath]     # default path: devtask
#   Env: DATA (default /home/comis/.comis), GW_PORT (4766), GW_HOST (127.0.0.1), WH_BASE (/hooks),
#        COMIS_USER (comis). Override WH_PATH via arg 1.

set -uo pipefail
[ -f /root/comis-rig.env ] && . /root/comis-rig.env
DATA="${DATA:-/home/comis/.comis}"
GW_HOST="${GW_HOST:-127.0.0.1}"
GW_PORT="${GW_PORT:-4766}"
WH_BASE="${WH_BASE:-/hooks}"
WH_PATH="${1:-devtask}"
COMIS_USER="${COMIS_USER:-comis}"
SERVICE="${SERVICE:-comis}"
CONFIG="${COMIS_CONFIG:-$DATA/config.yaml}"

fails=0
pass() { printf '  \033[32mPASS\033[0m  %-22s %s\n' "$1" "$2"; }
fail() { printf '  \033[31mFAIL\033[0m  %-22s %s\n' "$1" "$2"; fails=$((fails+1)); }
warn() { printf '  \033[33mWARN\033[0m  %-22s %s\n' "$1" "$2"; }

echo "=== phase0 preflight (DATA=$DATA, gateway=$GW_HOST:$GW_PORT, hook=$WH_BASE/$WH_PATH) ==="

# 1) daemon process alive + the systemd unit healthy (the production install runs under comis.service)
if pgrep -f 'node.*daemon\.js' >/dev/null 2>&1; then
  pass "daemon-process" "node …/daemon.js is running (pid $(pgrep -f 'node.*daemon\.js' | head -1))"
else
  fail "daemon-process" "no 'node …/daemon.js' — start it (restart-daemon.sh / clean-restart.sh)"
fi
if command -v systemctl >/dev/null 2>&1 && [ -f "/etc/systemd/system/$SERVICE.service" ]; then
  state=$(systemctl is-active "$SERVICE" 2>/dev/null)
  if [ "$state" = "active" ]; then
    pass "service" "$SERVICE.service active"
  else
    fail "service" "$SERVICE.service is '$state' — systemctl status $SERVICE / journalctl -u $SERVICE"
  fi
else
  warn "service" "no $SERVICE.service unit — not the production systemd install? (source-rig runs are legacy)"
fi

# 2) gateway TCP port bound — pure-bash /dev/tcp connect, no curl/ss needed
if timeout 3 bash -c "exec 3<>/dev/tcp/$GW_HOST/$GW_PORT" 2>/dev/null; then
  pass "gateway-port" "$GW_HOST:$GW_PORT accepts connections"
else
  fail "gateway-port" "$GW_HOST:$GW_PORT not listening — gateway didn't bind (config? FATAL boot?)"
fi

# 3) clean boot — the LAST boot record is a healthy start, not a FATAL. The structured Pino log is
#    authoritative (CLAUDE.md), not the pm2/stdout capture. Compare the most-recent marker of each.
LOG_GLOB=("$DATA"/logs/daemon*.log)
if [ -e "${LOG_GLOB[0]}" ]; then
  last_start=$(sudo -u "$COMIS_USER" bash -lc "grep -h 'Comis daemon started' ${DATA}/logs/daemon*.log 2>/dev/null | tail -1 | grep -oE '\"time\":\"[^\"]+\"' | head -1" 2>/dev/null)
  last_fatal=$(sudo -u "$COMIS_USER" bash -lc "grep -h 'Bootstrap failed' ${DATA}/logs/daemon*.log 2>/dev/null | tail -1 | grep -oE '\"time\":\"[^\"]+\"' | head -1" 2>/dev/null)
  if [ -n "$last_start" ] && { [ -z "$last_fatal" ] || [[ "$last_fatal" < "$last_start" ]]; }; then
    pass "clean-boot" "last boot record = 'Comis daemon started' (${last_start#*:})"
  elif [ -n "$last_fatal" ]; then
    fail "clean-boot" "most-recent boot = FATAL Bootstrap failed (${last_fatal#*:}) — restore config.last-good.yaml"
  else
    warn "clean-boot" "no 'Comis daemon started' record found — is this the right DATA/logs dir?"
  fi
else
  warn "clean-boot" "no $DATA/logs/daemon*.log — cannot verify boot health"
fi

# 4) webhook route mounted + HMAC active — UNSIGNED POST must be 401 (mounted+auth), NOT 404 (route
#    absent → webhooks off / wrong path) and NOT a refused connection (gateway down). Needs no secret.
# NOTE: the env vars MUST precede `node` — after `node -e 'script'` they become argv, not env
# (process.env.P would be undefined → port NaN → a bogus ECONNREFUSED). Caught live: gateway-port
# PASSed but this probe "ECONNREFUSED"'d the SAME port.
status=$(H="$GW_HOST" P="$GW_PORT" PP="$WH_BASE/$WH_PATH" node -e '
  const http=require("http");
  const body=Buffer.from("{}");
  const req=http.request({host:process.env.H,port:+process.env.P,path:process.env.PP,method:"POST",
    headers:{"content-type":"application/json","content-length":body.length}},
    r=>{r.resume();r.on("end",()=>{console.log(r.statusCode);process.exit(0)})});
  req.on("error",e=>{console.log("ERR:"+(e.code||e.message));process.exit(0)});
  req.write(body);req.end();
' 2>/dev/null)
case "$status" in
  401) pass "webhook-mounted" "unsigned POST → 401 (route mounted, HMAC active — auth-before-turn holds)";;
  404) fail "webhook-mounted" "unsigned POST → 404 (route ABSENT — webhooks disabled or wrong path '$WH_PATH')";;
  2*)  fail "webhook-mounted" "unsigned POST → $status (route mounted but HMAC NOT enforced — a security regression!)";;
  ERR:*) fail "webhook-mounted" "probe failed ($status) — gateway not reachable";;
  *)   warn "webhook-mounted" "unsigned POST → ${status:-<none>} (unexpected — inspect manually)";;
esac

# 4b) msteams ingress mounted + BF-JWT active (ONLY when channels.msteams is enabled) — an
#     UNSIGNED POST to /channels/msteams/api/messages must be 401 (route mounted + the Bearer
#     pre-gate active), NOT 404 (channel disabled / not built) and NOT 2xx (auth bypassed). This
#     is the Teams analog of the webhook probe: the inbound is a signed webhook, so the missing-
#     bearer pre-gate is the liveness proof. Skipped (as a note) when msteams is not enabled.
if [ -f "$CONFIG" ] && sudo -u "$COMIS_USER" test -r "$CONFIG" 2>/dev/null \
   && sudo -u "$COMIS_USER" grep -qE '^\s*msteams:\s*$' "$CONFIG" 2>/dev/null \
   && sudo -u "$COMIS_USER" sed -n '/^\s*msteams:/,/^\s*[a-z]/p' "$CONFIG" 2>/dev/null | grep -qE 'enabled:\s*true'; then
  tstatus=$(H="$GW_HOST" P="$GW_PORT" node -e '
    const http=require("http");
    const body=Buffer.from("{}");
    const req=http.request({host:process.env.H,port:+process.env.P,path:"/channels/msteams/api/messages",method:"POST",
      headers:{"content-type":"application/json","content-length":body.length}},
      r=>{r.resume();r.on("end",()=>{console.log(r.statusCode);process.exit(0)})});
    req.on("error",e=>{console.log("ERR:"+(e.code||e.message));process.exit(0)});
    req.write(body);req.end();
  ' 2>/dev/null)
  case "$tstatus" in
    401) pass "msteams-mounted" "unsigned POST → 401 (ingress mounted, BF-JWT pre-gate active)";;
    404) fail "msteams-mounted" "unsigned POST → 404 (ingress ABSENT — msteams disabled or credentials failed to validate)";;
    2*)  fail "msteams-mounted" "unsigned POST → $tstatus (mounted but auth NOT enforced — a security regression!)";;
    ERR:*) fail "msteams-mounted" "probe failed ($tstatus) — gateway not reachable";;
    *)   warn "msteams-mounted" "unsigned POST → ${tstatus:-<none>} (unexpected — inspect manually)";;
  esac
else
  warn "msteams-mounted" "channels.msteams not enabled — skipping the Teams ingress probe (Telegram is the default drive target)"
fi

# 5) terminal capability config present — the drive needs the `terminal` tool allowed for its origin/agent
#    AND a complete `worker` block (the FATAL this run hit: schema requires worker.{maxSessions,idleTtlMs,
#    ringBytes,stuckMs,maxConcurrentAttentionTurns} + defaults.{cols,rows,scrollback}).
if [ -f "$CONFIG" ] && sudo -u "$COMIS_USER" test -r "$CONFIG" 2>/dev/null; then
  cfg=$(sudo -u "$COMIS_USER" cat "$CONFIG" 2>/dev/null)
  if grep -q 'terminal' <<<"$cfg"; then
    missing=""
    for k in maxSessions idleTtlMs ringBytes stuckMs maxConcurrentAttentionTurns; do
      grep -qE "^[[:space:]]*$k:" <<<"$cfg" || missing="$missing $k"
    done
    if [ -z "$missing" ]; then
      pass "terminal-config" "terminal present + worker block complete"
    else
      fail "terminal-config" "terminal present but worker block MISSING:$missing (schema requires them → FATAL boot)"
    fi
  else
    warn "terminal-config" "no 'terminal' key in config — is the terminal tool enabled for this drive?"
  fi
else
  warn "terminal-config" "cannot read $CONFIG as $COMIS_USER — skip config shape check"
fi

# 6) jail deps present — a terminal drive spawns claude under bwrap in a tmux pane
for bin in bwrap tmux node; do
  if command -v "$bin" >/dev/null 2>&1; then pass "jail-dep:$bin" "$(command -v "$bin")"
  else fail "jail-dep:$bin" "not on PATH — the bwrap/tmux jail cannot launch"; fi
done

echo
if [ "$fails" -eq 0 ]; then echo -e "\033[32m✅ phase0 GREEN — rig ready to drive\033[0m"; exit 0
else echo -e "\033[31m❌ phase0: $fails blocker(s) — fix before driving\033[0m"; exit 1; fi
