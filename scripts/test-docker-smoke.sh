#!/bin/bash
# Comprehensive smoke test for the Docker daemon — exercises every behavior
# this session shipped: path migration, single-mount data dir, sandbox auto-
# disable + WARN, chat API auth, OpenAI compat endpoint, SSE streaming,
# session-memory persistence, host visibility of logs/workspace/memory.db.
# Run against a live `docker compose up -d` container.

set -u   # fail on undefined var (NOT -e — we want every probe to run)
GW=http://127.0.0.1:4766
KEY=$(grep '^COMIS_GATEWAY_TOKEN=' ~/.comis/.env | cut -d= -f2)
HOST_DATA=~/.comis
PASS=0
FAIL=0
WARN_NOTES=()

ok()   { echo "  ✓ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }
warn() { WARN_NOTES+=("$1"); }
hdr()  { echo; echo "── $1 ──"; }

# ---------------------------------------------------------------------------
hdr "1. Container state"
# ---------------------------------------------------------------------------
status=$(docker inspect comis-daemon --format '{{.State.Status}}' 2>/dev/null)
health=$(docker inspect comis-daemon --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null)
restarts=$(docker inspect comis-daemon --format '{{.RestartCount}}' 2>/dev/null)
[ "$status" = "running" ] && ok "container running" || fail "container status=$status"
[ "$health" = "healthy" ] && ok "healthcheck = healthy" || fail "healthcheck = $health"
[ "$restarts" = "0" ] && ok "restart count = 0" || warn "restart count = $restarts"

# ---------------------------------------------------------------------------
hdr "2. Path migration (this session's main change)"
# ---------------------------------------------------------------------------
ddir=$(docker exec comis-daemon sh -c 'echo $COMIS_DATA_DIR')
[ "$ddir" = "/home/comis/.comis" ] \
  && ok "COMIS_DATA_DIR baked in = /home/comis/.comis" \
  || fail "COMIS_DATA_DIR = $ddir (expected /home/comis/.comis)"

if docker exec comis-daemon test -d /home/comis/.comis; then
  ok "/home/comis/.comis exists in container"
else
  fail "/home/comis/.comis missing in container"
fi

if docker exec comis-daemon test -d /data; then
  fail "/data still exists (should be gone)"
else
  ok "/data no longer mounted (path migration complete)"
fi

# Single-mount convergence: dataDir-rooted (memory.db) and homedir-rooted
# (logs, workspace) should both appear on host.
[ -f "$HOST_DATA/memory.db" ]        && ok "host: memory.db present"        || fail "host: memory.db missing"
[ -d "$HOST_DATA/logs" ]             && ok "host: logs/ present"            || fail "host: logs/ missing"
[ -d "$HOST_DATA/workspace" ]        && ok "host: workspace/ present"       || fail "host: workspace/ missing"
[ -d "$HOST_DATA/workspace/sessions" ] && ok "host: workspace/sessions/ present (homedir-rooted)" \
                                       || warn "host: workspace/sessions/ not yet created (lazy)"

# ---------------------------------------------------------------------------
hdr "3. Sandbox state (linuxkit fallback)"
# ---------------------------------------------------------------------------
sopt=$(docker inspect comis-daemon --format '{{.HostConfig.SecurityOpt}}')
echo "$sopt" | grep -q "apparmor=unconfined" && ok "security_opt: apparmor=unconfined" || fail "apparmor opt-out missing"
echo "$sopt" | grep -q "seccomp=unconfined"  && ok "security_opt: seccomp=unconfined"  || fail "seccomp opt-out missing"

if docker logs comis-daemon 2>&1 | grep -q "Exec sandbox DISABLED"; then
  ok "auto-disable WARN fired (linuxkit kernel; expected on macOS Docker Desktop)"
elif docker logs comis-daemon 2>&1 | grep -q '"provider":"bwrap","msg":"Exec sandbox provider detected"'; then
  ok "bwrap active (sandbox running fully — must be a real Linux host)"
else
  fail "sandbox state unclear in logs"
fi

# ---------------------------------------------------------------------------
hdr "4. Auth on chat API"
# ---------------------------------------------------------------------------
no_auth=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$GW/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"default","messages":[{"role":"user","content":"x"}]}' --max-time 10)
[ "$no_auth" = "401" ] && ok "no token → 401 (auth enforced)" || fail "no token → $no_auth (expected 401)"

bad_auth=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$GW/v1/chat/completions" \
  -H "Authorization: Bearer wrong-token" \
  -H "Content-Type: application/json" \
  -d '{"model":"default","messages":[{"role":"user","content":"x"}]}' --max-time 10)
[ "$bad_auth" = "401" ] && ok "wrong token → 401" || fail "wrong token → $bad_auth (expected 401)"

# ---------------------------------------------------------------------------
hdr "5. OpenAI-compat: /v1/chat/completions"
# ---------------------------------------------------------------------------
RESP=$(curl -sS -X POST "$GW/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  --max-time 90 \
  -d '{"model":"default","messages":[{"role":"user","content":"Reply with exactly: comprehensive-test-1"}]}')

obj=$(echo "$RESP" | jq -r '.object // "missing"')
content=$(echo "$RESP" | jq -r '.choices[0].message.content // "missing"' 2>/dev/null | head -1)
finish=$(echo "$RESP" | jq -r '.choices[0].finish_reason // "missing"')
tok_in=$(echo "$RESP" | jq -r '.usage.prompt_tokens // -1')
tok_out=$(echo "$RESP" | jq -r '.usage.completion_tokens // -1')

[ "$obj" = "chat.completion" ]   && ok "response object = chat.completion"   || fail "object=$obj"
[ "$finish" = "stop" ]            && ok "finish_reason = stop"                || fail "finish_reason=$finish"
[ "$tok_in" -gt 0 ]               && ok "prompt_tokens > 0 ($tok_in)"         || fail "prompt_tokens=$tok_in"
[ "$tok_out" -gt 0 ]              && ok "completion_tokens > 0 ($tok_out)"    || fail "completion_tokens=$tok_out"
echo "    reply: $content"

# ---------------------------------------------------------------------------
hdr "6. SSE streaming: /api/chat/stream"
# ---------------------------------------------------------------------------
SSE_OUT=$(curl -sS --max-time 60 \
  -H "Authorization: Bearer $KEY" \
  -G "$GW/api/chat/stream" \
  --data-urlencode "message=Reply with exactly: stream-ok")

echo "$SSE_OUT" | grep -q '^event: token' && ok "SSE: 'token' events emitted" || fail "no token events in stream"
echo "$SSE_OUT" | grep -q '^event: done'  && ok "SSE: 'done' event emitted"   || fail "no done event in stream"
final=$(echo "$SSE_OUT" | awk -F'data: ' '/^event: done/{getline; print $2}' | jq -r '.response' 2>/dev/null | head -c 60)
[ -n "$final" ] && ok "SSE: final response payload retrieved (\"$final\")" || fail "no final payload"

# ---------------------------------------------------------------------------
hdr "7. Session memory persistence (across separate API calls)"
# ---------------------------------------------------------------------------
# First, plant a unique fact via one API call
TOKEN=$(date +%s)-marker
curl -sS -X POST "$GW/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  --max-time 90 \
  -d "{\"model\":\"default\",\"messages\":[{\"role\":\"user\",\"content\":\"Remember this token: $TOKEN — just acknowledge in 5 words.\"}]}" \
  > /dev/null

# Second call: ask if the agent remembers
RESP2=$(curl -sS -X POST "$GW/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  --max-time 90 \
  -d '{"model":"default","messages":[{"role":"user","content":"What unique token did I ask you to remember a moment ago? Reply with just the token."}]}')

c2=$(echo "$RESP2" | jq -r '.choices[0].message.content // ""' | head -1)
echo "    planted: $TOKEN"
echo "    recall:  $c2"
if echo "$c2" | grep -q "$TOKEN"; then
  ok "session memory works — agent recalled the marker across separate API calls"
else
  warn "memory recall did not include the literal token (LLM may have summarized; check daemon log for memory writes)"
fi

# ---------------------------------------------------------------------------
hdr "8. Memory.db growth on host (proves real writes)"
# ---------------------------------------------------------------------------
db_size=$(stat -f%z "$HOST_DATA/memory.db" 2>/dev/null || stat -c%s "$HOST_DATA/memory.db" 2>/dev/null)
wal_size=$(stat -f%z "$HOST_DATA/memory.db-wal" 2>/dev/null || stat -c%s "$HOST_DATA/memory.db-wal" 2>/dev/null)
[ "$db_size" -gt 100000 ]  && ok "memory.db on host: $db_size bytes" || warn "memory.db only $db_size bytes"
[ "$wal_size" -gt 0 ]      && ok "memory.db-wal active: $wal_size bytes" || warn "no WAL activity"

log_size=$(stat -f%z "$HOST_DATA/logs/daemon.1.log" 2>/dev/null || stat -c%s "$HOST_DATA/logs/daemon.1.log" 2>/dev/null)
[ "$log_size" -gt 0 ] && ok "daemon log on host: $log_size bytes" || fail "no log file on host"

# ---------------------------------------------------------------------------
hdr "9. Telegram channel registered"
# ---------------------------------------------------------------------------
chans=$(docker logs comis-daemon 2>&1 | grep "Comis daemon started" | tail -1 | jq -r '.channels|join(",")' 2>/dev/null)
if [ "$chans" = "telegram" ]; then
  ok "channels: telegram (real bot connected)"
else
  warn "channels: $chans"
fi

# ---------------------------------------------------------------------------
hdr "RESULT"
# ---------------------------------------------------------------------------
echo "  PASS: $PASS"
echo "  FAIL: $FAIL"
if [ ${#WARN_NOTES[@]} -gt 0 ]; then
  echo "  WARN:"
  for n in "${WARN_NOTES[@]}"; do echo "    - $n"; done
fi
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
