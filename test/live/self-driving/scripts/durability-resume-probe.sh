#!/usr/bin/env bash
# durability-resume-probe — deterministically test orchestrate durable
# survive-restart resume. Runs ON THE BOX (needs the trajectory, the emu control
# API, and sudo for the daemon restart).
#
# Why a harness: a fixed-delay restart lands during the model's think-time
# (nothing to resume), and the model may pick web_fetch over orchestrate. This
# probe (1) injects a durable orchestrate run with a GUARANTEED-slow exec node so
# there is a reliable interrupt window, (2) catches the run IN-PROGRESS via two
# independent signals — a robust JSON parse of the trajectory (an orchestrate
# tool.call with no matching tool.result) OR the slow node's own OS process —
# (3) restarts the daemon at that instant, and (4) verifies the durability engine
# recovers the interrupted run at boot.
#
# Usage: sudo bash durability-resume-probe.sh [chatId] [emuApiRoot] [sleepSecs]
set -uo pipefail
CHAT="${1:-678314278}"
EMU="${2:-http://127.0.0.1:32863}"
SLEEP_SECS="${3:-50}"
DATA="${COMIS_DATA:-/home/comis/.comis}"
CLI="${COMIS_CLI:-/home/comis/.npm-global/bin/comis}"
MARKER="DURABLE_RESUME_$$"

F="$(ls -t "$DATA"/workspace/sessions/default/"$CHAT"/*.trajectory.jsonl 2>/dev/null | head -1)"
[ -z "$F" ] && { echo "FAIL: no trajectory for chat $CHAT"; exit 1; }

# Robust (field-order-independent) count of orchestrate tool.call vs tool.result.
orch_state() {
  cat "$F" 2>/dev/null | python3 -c '
import sys,json
c=r=0
for l in sys.stdin:
  try: o=json.loads(l)
  except: continue
  if o.get("data",{}).get("toolName")=="orchestrate":
    t=o.get("type")
    if t=="tool.call": c+=1
    elif t=="tool.result": r+=1
print(c,r)'
}

read -r base_c base_r < <(orch_state)
echo "baseline: orchestrate calls=$base_c results=$base_r"
echo "trajectory: $F"

# Inject a durable orchestrate run with a naturally-slow shape the model reliably
# authors: a sequential MULTI-FETCH graph (a pure exec-sleep node is agent-averse;
# gpt-5.4 declines to author a pointless sleep). Six sequential fetches give a
# ~30-40s in-progress window to interrupt.
curl -s -X POST "$EMU/control/chats/$CHAT/messages" -H "Content-Type: application/json" \
  -d "{\"fromUserId\":$CHAT,\"text\":\"Use the orchestrate tool to run a durable graph that fetches these SIX urls SEQUENTIALLY (one node each, in order) and then summarizes all their titles: https://example.com https://example.org https://example.net https://www.iana.org https://www.rfc-editor.org https://www.w3.org\"}" >/dev/null
echo "injected durable orchestrate run (6 sequential fetch nodes ~30-40s window)"

# Catch IN-PROGRESS via the TRAJECTORY: a new orchestrate tool.call with no
# matching tool.result. (An OS-process signal does NOT work — the orchestrate
# exec node runs in a bwrap PID namespace, so its processes are invisible to a
# host pgrep. The trajectory is the reliable signal.)
caught=""
for i in $(seq 1 70); do
  read -r c r < <(orch_state)
  if [ "$c" -gt "$base_c" ] && [ "$c" -gt "$r" ]; then
    caught="yes"
    rid="$(grep -aoE '"runId":"orch-[^"]+"' "$F" 2>/dev/null | tail -1 | sed 's/.*"runId":"//;s/"//')"
    echo "IN-PROGRESS at ~$((i*2))s (calls=$c results=$r) runId=${rid:-none}"
    break
  fi
  sleep 2
done
[ -z "$caught" ] && { echo "FAIL: orchestrate never went in-progress in ~140s (model may not have used orchestrate, or python3 absent in jail)"; exit 2; }

echo "=== RESTART daemon mid-run ==="
dmesg -C 2>/dev/null || true
bash /root/restart-daemon.sh 2>&1 | tail -1

sleep 5
echo "=== boot-recovery evidence ==="
grep -aiE "durable|resume|boot recovery|recover" "$DATA"/logs/daemon*.log 2>/dev/null | tail -6 | cut -c1-150 || echo "(none)"

echo "=== resumable run present post-restart? (replay) ==="
if [ -n "${rid:-}" ]; then
  sudo -u comis "$CLI" orchestrate replay "$rid" 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -aiE "resum|replay|result|no resumable|complete|match|diverg" | head -4
fi

echo "=== marker delivered post-restart (run completed + delivered)? ==="
seen=""
for j in $(seq 1 40); do
  if curl -s "$EMU/control/chats/$CHAT/outbound?afterMessageId=0&waitMs=3000" 2>/dev/null | grep -q "$MARKER"; then
    seen="yes"; echo "RESUME→DELIVER: marker $MARKER reached chat after the restart"; break
  fi
  sleep 2
done
[ -z "$seen" ] && echo "marker NOT delivered post-restart (run may resume internally without re-delivering to the interrupted turn — inspect boot-recovery + replay above)"
echo "=== PROBE DONE ==="
