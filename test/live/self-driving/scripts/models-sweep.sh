#!/usr/bin/env bash
# VPS (run as ROOT) — sweep a list of models. For each: swap config.model + clean-restart + a PONG turn,
# then report the ACTUAL modelId the turn ran (must == config = no silent substitution) and any
# not_found/error (a retired/unavailable alias = NO-ACCESS, not a Comis bug). Restores PRIMARY at the end.
# Run BACKGROUNDED:  MODELS="…" PRIMARY="…" nohup bash models-sweep.sh >/root/sweep.out 2>&1 &
#
#   Codex:     MODELS="gpt-5.5 gpt-5.4 gpt-5.4-mini gpt-5.3-codex-spark"          PRIMARY=gpt-5.5
#   Anthropic: MODELS="claude-opus-4-8 claude-sonnet-4-6 claude-haiku-4-5 claude-opus-4-0"  PRIMARY=claude-sonnet-4-6
# (Get the valid set from:  node -e 'import("@earendil-works/pi-ai").then(m=>console.log(m.getModels("<provider>").map(x=>x.id)))')
set +e
DATA="${DATA:-/home/comis/.comis}"
CHATID="${CHATID:-678314278}"
: "${MODELS:?set MODELS to a space-separated list}"
PRIMARY="${PRIMARY:-$(echo "$MODELS" | awk '{print $1}')}"

for M in $MODELS; do
  echo "########## SWEEP $M ##########"
  sudo -u comis sed -i "s/^    model: .*/    model: $M/" "$DATA/config.yaml"
  pkill -9 -f "^node .*daemon\.js" 2>/dev/null; sleep 2
  # Truncate the SUPERVISOR log too ($HOME/comis-m1.log lives OUTSIDE $DATA/logs, so the rm above never
  # touches it) — else `grep modelId | tail` below reads modelIds accumulated across ALL prior models in
  # the sweep and a silent substitution on model N hides behind model N-1's id (stale-log trap, codex run
  # 2026-06-25; same class as clean-restart.sh's `: > comis-m1.log`).
  sudo -u comis bash -c "rm -rf '$DATA/workspace/sessions/default/$CHATID'; rm -f '$DATA'/memory.db '$DATA'/memory.db-wal '$DATA'/memory.db-shm; rm -f '$DATA'/logs/*.log; : > /home/comis/comis-m1.log"
  su - comis -c "bash /home/comis/restart-m1.sh" >/dev/null 2>&1
  sleep 14
  node /root/drive.mjs "$CHATID" "Reply with exactly the token PONG-OK and nothing else." 6000 80000 2>&1 \
    | grep -aE "SUBSTANTIVE|PONG|NO SUBSTANTIVE" | head -2
  echo "--- ground truth for $M (configured=$M) ---"
  grep -aoE "modelId\":\"[^\"]+\"|not_found_error|\"type\":\"[a-z_]*error|finishReason\":\"error" \
    /home/comis/comis-m1.log 2>/dev/null | grep -avE "nomic" | sort -u | tail -3
done

sudo -u comis sed -i "s/^    model: .*/    model: $PRIMARY/" "$DATA/config.yaml"
echo "########## SWEEP DONE (restored $PRIMARY — restart to apply) ##########"
