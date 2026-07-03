#!/usr/bin/env bash
# drive-sim-workload.sh — the per-workload ACC→REFLECT composition for the memory/learning sim catalog.
#
# This loop was hand-orchestrated ~14x per run (restart→connect→reset→2 byte-identical feeders→reflect→read)
# before being standardized here — the missing COMPOSITION over the primitives
# (restart-m1.sh / drive.mjs / reflect-run.mjs / db.mjs).
#
# Runs ON the box, AS ROOT (it orchestrates restart-m1 as comis + the gateway-token RPCs). Needs the
# revoke.mjs env: COMIS_CONFIG_PATHS + COMIS_GATEWAY_TOKEN (export them, or this sources ~/.comis/.env).
#
#   bash drive-sim-workload.sh <workload> [variant=A] [feeder1=678314279] [feeder2=678314280]
#
# Steps: restart-m1 (resets the per-root meter — avoids a spurious-abort from an accumulated meter) → disconnect ALL sim
# servers + connect THIS workload's server (one server at a time, no tool confusion) → reset the 2 feeder
# sessions (clear cross-workload LCD) → 2 BYTE-IDENTICAL feeders (the topicKey card-2 bar) → reflect-run →
# read GROUND TRUTH (mental_models delta + the newest skill row + a grounding grep of its body).
set -uo pipefail

WL="${1:?usage: drive-sim-workload.sh <workload> [variant=A] [feeder1] [feeder2]}"
VARIANT="${2:-A}"
F1="${3:-678314279}"
F2="${4:-678314280}"
DATA="${DATA:-/home/comis/.comis}"
SRC="${COMIS_SRC:-/root/comis-src}"
CLI="node $SRC/packages/cli/dist/cli.js"
[ -f "$HOME/.comis/.env" ] && . "$HOME/.comis/.env" 2>/dev/null || true
[ -f /home/comis/.comis/.env ] && . /home/comis/.comis/.env 2>/dev/null || true
export COMIS_CONFIG_PATHS="${COMIS_CONFIG_PATHS:-$DATA/config.yaml}"

# workload → MCP server name (the sim/README dir↔server map).
declare -A SERVER=(
  [package-delivery]=depot-sim [threat-hunting]=th-sim [market-making]=mm-sim [icu-clinical]=icu-sim
  [contract-negotiation]=nego-sim [wildfire-command]=fire-sim [content-moderation]=mod-sim
  [grid-operator]=grid-sim [lab-research]=lab-sim [customer-success]=cs-sim [aml-investigations]=aml-sim
  [tutoring]=tutor-sim [humanitarian-logistics]=relief-sim [precision-apiary]=apiary-sim
)
# workload → the canonical BYTE-IDENTICAL feeder prompt (the #5 prompt table — was re-derived per run).
declare -A PROMPT=(
  [package-delivery]="Deliver this package to Priya using the depot-sim console. Accept the package, find which office she is in, navigate there, and deliver it."
  [threat-hunting]="Work the open SOC alert on the threat-hunting console: open an investigation, gather the evidence, decide what is malicious, and resolve the case."
  [market-making]="Run a market-making session on the mm-sim desk: read the market, set a strategy, work the book with two-sided quotes, manage your inventory, adapt if the regime shifts, and settle for the graded result."
  [icu-clinical]="Assess the ICU patient on the icu-sim bedside console: open an assessment, gather vitals, labs, notes and the guideline, build a differential, order the discriminating workup, and finalize the diagnosis with a calibrated confidence."
  [contract-negotiation]="You are the buyer negotiating on the nego-sim desk. Goal: close the deal at a price at or below the fair-market level (use market_comparables). Counter their anchor with offers; accept ONLY once the price is within the fair-market range; walk away if it never gets there. Do not keep raising your own offer."
  [wildfire-command]="Command the wildland fire on the fire-sim console: open the incident, size up the weather, fuels, terrain, spread forecast and resources, set a suppression tactic and containment line, assign crews and aircraft while heeding the safety posture, order evacuations where people are at risk, and declare containment."
  [content-moderation]="Work the trust & safety moderation queue on the mod-sim console: open a review, and for each item read the content, the reports, the reporter history and the policy, then decide keep or remove with a rationale — weigh report reliability over raw report count — action accounts only when confident, and submit the verdict."
  [grid-operator]="Operate the balancing-authority interval on the grid-sim console: read load, generation, forecast, reserves, asset health and frequency, position the area (commit reserves, set the dispatch strategy, adjust set-points) to keep frequency and balance within limits at reasonable cost, then settle the interval."
  [lab-research]="Run a research campaign on the lab-sim bench toward the target: survey the inventory, protocols, instruments and literature; queue a validated protocol and read its result; record observations and flag any retracted premise; close the campaign when you reach the target."
  [customer-success]="Run the quarterly portfolio review on the cs-sim console: for every account gather usage, health, contacts and renewal terms, corroborate across them (a high health score is not proof an account is safe — read the stakeholder map), flag churn risks with the driving signal, propose evidence-tied plays using comparable peers, forecast renewals, and close the quarter."
  [aml-investigations]="Investigate the AML referral on the aml-sim console: open the case, pull the account activity, money-flow graph and KYC facts, weigh any inbound tip against its source trust, identify the laundering typology by its behavioral signature, file findings or SARs only where the evidence supports, clear benign entities, and resolve the case."
  [tutoring]="Tutor the student on the tutor-sim console: read the student in, set an initial hypothesis about their misconception, test it with problems and diagnostics, revise your hypothesis if the evidence does not fit, give hints that target the actual misconception, and assess mastery on a related transfer topic."
  [humanitarian-logistics]="Coordinate the relief operation on the relief-sim console: open the operation, assess the crises, the live route status, the field reports (weigh each by its source reliability), inventory and needs, prioritize the area, choose a passable route, allocate supplies, dispatch the convoy, and confirm delivery."
  [precision-apiary]="Manage the apiary season on the apiary-sim console: survey and inspect the hives, sample pest pressure, read the forage map, weather and harvest forecast, then treat, place and harvest hives at the right times, and close the season."
)

# --check: a map-completeness WIRING-GUARD (drift catcher) — assert the embedded SERVER+PROMPT maps cover
# EVERY real sim workload dir (a `tools.json`), so a workload added to sim/ but not registered here is
# caught loudly instead of silently un-drivable. Runs offline (no daemon); SIM_DIR overrides the box path.
if [ "$WL" = "--check" ]; then
  SIM_DIR="${SIM_DIR:-/home/comis/sim}"
  miss=0 n=0
  for d in "$SIM_DIR"/*/; do
    w="$(basename "$d")"
    [ -f "$d/tools.json" ] || continue          # only real workloads (skip shared/bin)
    n=$((n + 1))
    if [ -z "${SERVER[$w]:-}" ]; then echo "MISSING SERVER entry: $w"; miss=$((miss + 1)); fi
    if [ -z "${PROMPT[$w]:-}" ]; then echo "MISSING PROMPT entry: $w"; miss=$((miss + 1)); fi
  done
  if [ "$n" -eq 0 ]; then echo "check: no sim workloads found under $SIM_DIR (set SIM_DIR)"; exit 2; fi
  if [ "$miss" -eq 0 ]; then echo "OK: all $n sim workloads covered by the SERVER+PROMPT maps"; exit 0; fi
  echo "FAIL: $miss unregistered map entr(y/ies) across $n workloads"; exit 1
fi

SRV="${SERVER[$WL]:-}"
P="${PROMPT[$WL]:-}"
if [ -z "$SRV" ] || [ -z "$P" ]; then
  echo "unknown workload '$WL'. known: ${!SERVER[*]}" >&2; exit 2
fi
echo "== drive-sim-workload: $WL (server=$SRV variant=$VARIANT feeders=$F1,$F2) =="

# 1) restart-m1 — fresh per-root meter (a reused sender's accumulated meter spuriously aborts later turns).
su - comis -c 'bash /home/comis/restart-m1.sh' >/dev/null 2>&1
for i in $(seq 1 30); do ss -ltnp 2>/dev/null | grep -q ':4766' && break; sleep 2; done

# 2) one server at a time: disconnect every known sim server, then connect THIS one on the chosen variant.
for s in "${SERVER[@]}"; do $CLI mcp disconnect "$s" >/dev/null 2>&1; done
$CLI mcp connect "$SRV" --transport stdio --command node \
  --args /home/comis/sim/bin/mcp-server.mjs "$WL" "$VARIANT" 2>&1 | grep -iE 'connected|tool|error' | head -1

# 3) reset the 2 feeder sessions (clear any prior workload's LCD — cross-task contamination trap).
for s in "$F1" "$F2"; do
  node /root/revoke.mjs session.reset_conversation "{\"session_key\":\"default:$s:$s:peer:$s\"}" >/dev/null 2>&1
done

# baseline the store so the delta is attributable.
MM0=$(su - comis -c 'node /root/db.mjs count mental_models' 2>/dev/null | grep -oE '[0-9]+' | head -1)

# 4) two BYTE-IDENTICAL feeders (distinct (session,sender) → the card-2 corroboration bar).
echo "-- feeder-1 ($F1) --"; node /root/drive.mjs "$F1" "$P" 2>&1 | tail -1
echo "-- feeder-2 ($F2) --"; node /root/drive.mjs "$F2" "$P" 2>&1 | tail -1

# 5) reflect (polls the EXACT 'Reflection complete (all kinds)' marker — never the dispatch line).
echo "-- reflect --"; node /root/reflect-run.mjs Reflection 120 2>&1 | tail -1

# 6) GROUND TRUTH: the mm delta + the newest skill row + a grounding grep of its body.
MM1=$(su - comis -c 'node /root/db.mjs count mental_models' 2>/dev/null | grep -oE '[0-9]+' | head -1)
echo "-- mental_models: ${MM0:-?} -> ${MM1:-?} (admit if +1) --"
echo "-- newest skill --"; su - comis -c 'node /root/db.mjs pick mental_models name,kind,state,trust_level,proof_count 1' 2>/dev/null
echo "-- grounding: surface facts memorized as instructions? (want NONE outside topicTokens) --"
su - comis -c 'node /root/db.mjs pick mental_models body 1' 2>/dev/null \
  | grep -oiE 'priya|3-01|ws-07|alvarez|MRN-[0-9]+|maya|ACC-[0-9]+' | sort -u | head \
  || echo "(no obvious memorized surface fact in the body)"
echo "== done: $WL =="
