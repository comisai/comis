#!/usr/bin/env bash
# VPS (run as ROOT) — sweep a list of models. For each: swap config.model + clean-slate restart + a PONG
# turn, then report the ACTUAL modelId the turn ran (must == config = no silent substitution) and any
# not_found/error (a retired/unavailable alias = NO-ACCESS, not a Comis bug). Restores PRIMARY at the end.
# Run BACKGROUNDED:  MODELS="…" PRIMARY="…" nohup bash models-sweep.sh >/root/sweep.out 2>&1 &
#
#   Codex:     MODELS="gpt-5.5 gpt-5.4 gpt-5.4-mini gpt-5.3-codex-spark"          PRIMARY=gpt-5.5
#   Anthropic: MODELS="claude-opus-4-8 claude-sonnet-4-6 claude-haiku-4-5 claude-opus-4-0"  PRIMARY=claude-sonnet-4-6
# (Get the valid set from:  node -e 'import("@earendil-works/pi-ai").then(m=>console.log(m.getModels("<provider>").map(x=>x.id)))')
set +e
[ -f /root/comis-rig.env ] && . /root/comis-rig.env
DATA="${DATA:-/home/comis/.comis}"
COMIS_USER="${COMIS_USER:-comis}"
SERVICE="${SERVICE:-comis}"
CHATID="${CHATID:-678314278}"
: "${MODELS:?set MODELS to a space-separated list}"
PRIMARY="${PRIMARY:-$(echo "$MODELS" | awk '{print $1}')}"

for M in $MODELS; do
  echo "########## SWEEP $M ##########"
  sudo -u "$COMIS_USER" sed -i "s/^    model: .*/    model: $M/" "$DATA/config.yaml"
  systemctl stop "$SERVICE" 2>/dev/null
  sleep 1
  # Per-model log wipe — else the `grep modelId | tail` ground truth below reads modelIds accumulated
  # across ALL prior models in the sweep and a silent substitution on model N hides behind model N-1's
  # id (the stale-log trap).
  sudo -u "$COMIS_USER" bash -c "rm -rf '$DATA/workspace/sessions/default/$CHATID'; rm -f '$DATA'/memory.db '$DATA'/memory.db-wal '$DATA'/memory.db-shm; rm -f '$DATA'/logs/*.log"
  bash /root/restart-daemon.sh >/dev/null 2>&1
  sleep 3
  node /root/drive.mjs "$CHATID" "Reply with exactly the token PONG-OK and nothing else." 6000 80000 2>&1 \
    | grep -aE "SUBSTANTIVE|PONG|NO SUBSTANTIVE" | head -2
  echo "--- ground truth for $M (configured=$M) ---"
  grep -ahoE "modelId\":\"[^\"]+\"|not_found_error|\"type\":\"[a-z_]*error|finishReason\":\"error" \
    "$DATA"/logs/daemon*.log 2>/dev/null | grep -avE "nomic" | sort -u | tail -3
done

sudo -u "$COMIS_USER" sed -i "s/^    model: .*/    model: $PRIMARY/" "$DATA/config.yaml"
echo "########## SWEEP DONE (restored $PRIMARY — restart to apply) ##########"
