#!/usr/bin/env bash
# drive-sim-workload.sh — the per-workload ACC→REFLECT composition for the memory/learning sim catalog.
#
# This loop was hand-orchestrated ~14x per run (restart→connect→reset→2 byte-identical feeders→reflect→read)
# before being standardized here — the missing COMPOSITION over the primitives
# (restart-daemon.sh / drive.mjs / reflect-run.mjs / db.mjs).
#
# Runs ON the box, AS ROOT (it orchestrates the systemd restart + the gateway-token RPCs). Needs the
# revoke.mjs env: COMIS_CONFIG_PATHS + COMIS_GATEWAY_TOKEN (export them, or /root/comis-rig.env + the
# data-dir .env supply them).
#
#   bash drive-sim-workload.sh <workload> [variant=A] [feeder1=678314279] [feeder2=678314280]
#
# Steps: daemon restart (resets the per-root meter — avoids a spurious-abort from an accumulated meter) → disconnect ALL sim
# servers + connect THIS workload's server (one server at a time, no tool confusion) → reset the 2 feeder
# sessions (clear cross-workload LCD) → 2 BYTE-IDENTICAL feeders (the topicKey card-2 bar) → reflect-run →
# read GROUND TRUTH (mental_models delta + the newest skill row + a grounding grep of its body).
set -uo pipefail

WL="${1:?usage: drive-sim-workload.sh <workload> [variant=A] [feeder1] [feeder2]}"
VARIANT="${2:-A}"
F1="${3:-678314279}"
F2="${4:-678314280}"
[ -f /root/comis-rig.env ] && . /root/comis-rig.env
DATA="${DATA:-/home/comis/.comis}"
COMIS_HOME="${COMIS_HOME:-/home/${COMIS_USER:-comis}}"
PKG="${PKG:-$COMIS_HOME/.npm-global/lib/node_modules/comisai}"
GW_PORT="${GW_PORT:-4766}"
TENANT_ID="${TENANT_ID:-default}"
AGENT_ID="${AGENT_ID:-default}"
# The installed CLI dist (COMIS_SRC overrides to a source checkout's packages/cli/dist/cli.js).
if [ -n "${COMIS_SRC:-}" ]; then CLI="node $COMIS_SRC/packages/cli/dist/cli.js"; else CLI="node $PKG/node_modules/@comis/cli/dist/cli.js"; fi
[ -f "$DATA/.env" ] && . "$DATA/.env" 2>/dev/null || true
export COMIS_CONFIG_PATHS="${COMIS_CONFIG_PATHS:-$DATA/config.yaml}"
export COMIS_GATEWAY_TOKEN="${COMIS_GATEWAY_TOKEN:-${GWTOKEN:-}}"

# Keep this script runnable on the repository's supported macOS/Bash 3.2 host. Bash associative arrays
# require Bash 4, so the workload registry uses case functions plus an indexed server list.
ALL_WORKLOADS=(package-delivery threat-hunting market-making icu-clinical contract-negotiation wildfire-command content-moderation grid-operator lab-research customer-success aml-investigations tutoring humanitarian-logistics precision-apiary)
ALL_SERVERS=(depot-sim th-sim mm-sim icu-sim nego-sim fire-sim mod-sim grid-sim lab-sim cs-sim aml-sim tutor-sim relief-sim apiary-sim)

server_for() {
  case "$1" in
    package-delivery) printf '%s' depot-sim ;;
    threat-hunting) printf '%s' th-sim ;;
    market-making) printf '%s' mm-sim ;;
    icu-clinical) printf '%s' icu-sim ;;
    contract-negotiation) printf '%s' nego-sim ;;
    wildfire-command) printf '%s' fire-sim ;;
    content-moderation) printf '%s' mod-sim ;;
    grid-operator) printf '%s' grid-sim ;;
    lab-research) printf '%s' lab-sim ;;
    customer-success) printf '%s' cs-sim ;;
    aml-investigations) printf '%s' aml-sim ;;
    tutoring) printf '%s' tutor-sim ;;
    humanitarian-logistics) printf '%s' relief-sim ;;
    precision-apiary) printf '%s' apiary-sim ;;
    *) return 1 ;;
  esac
}

prompt_for() {
  case "$1" in
    package-delivery) printf '%s' "Deliver this package to Priya using the depot-sim console. Accept the package, find which office she is in, navigate there, and deliver it." ;;
    threat-hunting) printf '%s' "Work the open SOC alert on the threat-hunting console: open an investigation, gather the evidence, decide what is malicious, and resolve the case." ;;
    market-making) printf '%s' "Run a market-making session on the mm-sim desk: read the market, set a strategy, work the book with two-sided quotes, manage your inventory, adapt if the regime shifts, and settle for the graded result." ;;
    icu-clinical) printf '%s' "Assess the ICU patient on the icu-sim bedside console: open an assessment, gather vitals, labs, notes and the guideline, build a differential, order the discriminating workup, and finalize the diagnosis with a calibrated confidence." ;;
    contract-negotiation) printf '%s' "You are the buyer negotiating on the nego-sim desk. Goal: close the deal at a price at or below the fair-market level (use market_comparables). Counter their anchor with offers; accept ONLY once the price is within the fair-market range; walk away if it never gets there. Do not keep raising your own offer." ;;
    wildfire-command) printf '%s' "Command the wildland fire on the fire-sim console: open the incident, size up the weather, fuels, terrain, spread forecast and resources, set a suppression tactic and containment line, assign crews and aircraft while heeding the safety posture, order evacuations where people are at risk, and declare containment." ;;
    content-moderation) printf '%s' "Work the trust & safety moderation queue on the mod-sim console: open a review, and for each item read the content, the reports, the reporter history and the policy, then decide keep or remove with a rationale — weigh report reliability over raw report count — action accounts only when confident, and submit the verdict." ;;
    grid-operator) printf '%s' "Operate the balancing-authority interval on the grid-sim console: read load, generation, forecast, reserves, asset health and frequency, position the area (commit reserves, set the dispatch strategy, adjust set-points) to keep frequency and balance within limits at reasonable cost, then settle the interval." ;;
    lab-research) printf '%s' "Run a research campaign on the lab-sim bench toward the target: survey the inventory, protocols, instruments and literature; queue a validated protocol and read its result; record observations and flag any retracted premise; close the campaign when you reach the target." ;;
    customer-success) printf '%s' "Run the quarterly portfolio review on the cs-sim console: for every account gather usage, health, contacts and renewal terms, corroborate across them (a high health score is not proof an account is safe — read the stakeholder map), flag churn risks with the driving signal, propose evidence-tied plays using comparable peers, forecast renewals, and close the quarter." ;;
    aml-investigations) printf '%s' "Investigate the AML referral on the aml-sim console: open the case, pull the account activity, money-flow graph and KYC facts, weigh any inbound tip against its source trust, identify the laundering typology by its behavioral signature, file findings or SARs only where the evidence supports, clear benign entities, and resolve the case." ;;
    tutoring) printf '%s' "Tutor the student on the tutor-sim console: read the student in, set an initial hypothesis about their misconception, test it with problems and diagnostics, revise your hypothesis if the evidence does not fit, give hints that target the actual misconception, and assess mastery on a related transfer topic." ;;
    humanitarian-logistics) printf '%s' "Coordinate the relief operation on the relief-sim console: open the operation, assess the crises, the live route status, the field reports (weigh each by its source reliability), inventory and needs, prioritize the area, choose a passable route, allocate supplies, dispatch the convoy, and confirm delivery." ;;
    precision-apiary) printf '%s' "Manage the apiary season on the apiary-sim console: survey and inspect the hives, sample pest pressure, read the forage map, weather and harvest forecast, then treat, place and harvest hives at the right times, and close the season." ;;
    *) return 1 ;;
  esac
}

# The runtime maps authenticated platform subjects to canonical principals before it creates a session key.
# Resolve that same authority from the running emulator instead of hand-building a display key from the raw
# sender id; a stale display key makes reset_conversation a silent no-op and contaminates the next workload.
canonical_session_key() {
  node - "$1" "$TENANT_ID" "$AGENT_ID" <<'NODE'
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
(async () => {
  const [senderId, tenantId, agentId] = process.argv.slice(2);
  const emu = JSON.parse(readFileSync('/tmp/comis-emu.json', 'utf8'));
  const response = await fetch(`${emu.apiRoot}/bot${emu.botToken}/getMe`);
  const body = await response.json();
  if (!response.ok || body?.ok !== true || !body?.result?.id) throw new Error('emulator getMe did not return a bot id');
  const fields = [tenantId, agentId, 'telegram', `telegram-${body.result.id}`, senderId];
  const assertionKey = fields.map((field) => `${Buffer.byteLength(field, 'utf8')}:${field}`).join('');
  const principalId = `platform_${createHash('sha256').update(assertionKey, 'utf8').digest('base64url')}`;
  process.stdout.write(`${tenantId}:agent:${agentId}:${principalId}:telegram:peer:${principalId}`);
})().catch((error) => {
  console.error(error?.message || String(error));
  process.exit(1);
});
NODE
}

# --check: a map-completeness WIRING-GUARD (drift catcher) — assert the embedded SERVER+PROMPT maps cover
# EVERY real sim workload dir (a `tools.json`), so a workload added to sim/ but not registered here is
# caught loudly instead of silently un-drivable. Runs offline (no daemon); SIM_DIR overrides the box path.
if [ "$WL" = "--check" ]; then
  SIM_DIR="${SIM_DIR:-${COMIS_HOME:-/home/comis}/sim}"
  miss=0 n=0
  for d in "$SIM_DIR"/*/; do
    w="$(basename "$d")"
    [ -f "$d/tools.json" ] || continue          # only real workloads (skip shared/bin)
    n=$((n + 1))
    if ! server_for "$w" >/dev/null; then echo "MISSING SERVER entry: $w"; miss=$((miss + 1)); fi
    if ! prompt_for "$w" >/dev/null; then echo "MISSING PROMPT entry: $w"; miss=$((miss + 1)); fi
  done
  if [ "$n" -eq 0 ]; then echo "check: no sim workloads found under $SIM_DIR (set SIM_DIR)"; exit 2; fi
  if [ "$miss" -eq 0 ]; then echo "OK: all $n sim workloads covered by the SERVER+PROMPT maps"; exit 0; fi
  echo "FAIL: $miss unregistered map entr(y/ies) across $n workloads"; exit 1
fi

SRV="$(server_for "$WL" 2>/dev/null || true)"
P="$(prompt_for "$WL" 2>/dev/null || true)"
if [ -z "$SRV" ] || [ -z "$P" ]; then
  echo "unknown workload '$WL'. known: ${ALL_WORKLOADS[*]}" >&2; exit 2
fi
echo "== drive-sim-workload: $WL (server=$SRV variant=$VARIANT feeders=$F1,$F2) =="

connect_workload_server() {
  $CLI mcp disconnect "$SRV" >/dev/null 2>&1 || true
  $CLI mcp connect "$SRV" --transport stdio --command node \
    --args "${SIM_DIR:-$COMIS_HOME/sim}/bin/mcp-server.mjs" "$WL" "$VARIANT" \
    2>&1 | grep -iE 'connected|tool|error' | head -1
}

# 1) daemon restart — fresh per-root meter (a reused sender's accumulated meter spuriously aborts later turns).
bash /root/restart-daemon.sh >/dev/null 2>&1
for i in $(seq 1 30); do ss -ltnp 2>/dev/null | grep -q ":$GW_PORT" && break; sleep 2; done

# 2) one server at a time: disconnect every known sim server, then connect THIS one on the chosen variant.
for s in "${ALL_SERVERS[@]}"; do $CLI mcp disconnect "$s" >/dev/null 2>&1; done
connect_workload_server

# 3) reset the 2 feeder sessions (clear any prior workload's LCD — cross-task contamination trap).
for s in "$F1" "$F2"; do
  session_key="$(canonical_session_key "$s")" || { echo "failed to resolve canonical session for $s" >&2; exit 1; }
  conversation_ref="$(node /root/db.mjs pickw lcd_messages conversation_ref session_key "$session_key" 1 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s)[0]?.conversation_ref||"")}catch{process.exit(1)}})')" || {
      echo "failed to resolve conversation authority for $s ($session_key)" >&2
      exit 1
    }
  # A sender that has never driven this clean slate has no conversation to reset.
  [ -z "$conversation_ref" ] && continue
  reset_result="$(node /root/revoke.mjs session.reset_conversation \
    "{\"tenant_id\":\"$TENANT_ID\",\"agent_id\":\"$AGENT_ID\",\"conversation_ref\":\"$conversation_ref\"}" 2>&1)"
  echo "$reset_result" | grep -q "\"conversationRef\":\"$conversation_ref\"" || {
    echo "session reset failed for $s ($conversation_ref): $reset_result" >&2
    exit 1
  }
done

# baseline the store so the delta is attributable.
MM0=$(node /root/db.mjs count mental_models 2>/dev/null | grep -oE '[0-9]+' | head -1)

# 4) two BYTE-IDENTICAL feeders (distinct (session,sender) → the card-2 corroboration bar).
echo "-- feeder-1 ($F1) --"; node /root/drive.mjs "$F1" "$P" 2>&1 | tail -1
# Each corroborating sender must start from an independent simulator world. Several workloads
# create an isolated case per opening call, while market/grid state lives at server scope; a
# reconnect gives both shapes the same clean-episode contract and prevents feeder 2 from merely
# observing feeder 1's already-settled world.
connect_workload_server
echo "-- feeder-2 ($F2) --"; node /root/drive.mjs "$F2" "$P" 2>&1 | tail -1

# 5) reflect (polls the EXACT 'Reflection complete (all kinds)' marker — never the dispatch line).
# Accumulating-store catalog runs revisit more eligible sources on each workload; keep the
# completion oracle above the single-workload default so a valid late completion is not
# misreported as a timeout and then interrupted by the next workload's daemon restart.
echo "-- reflect --"; node /root/reflect-run.mjs Reflection 240 2>&1 | tail -1

# 6) GROUND TRUTH: the mm delta + the newest skill row + a grounding grep of its body.
MM1=$(node /root/db.mjs count mental_models 2>/dev/null | grep -oE '[0-9]+' | head -1)
echo "-- mental_models: ${MM0:-?} -> ${MM1:-?} (admit if +1) --"
echo "-- newest skill --"; node /root/db.mjs pick mental_models name,kind,state,trust_level,proof_count 1 2>/dev/null
echo "-- grounding: surface facts memorized as instructions? (want NONE outside topicTokens) --"
node /root/db.mjs pick mental_models body 1 2>/dev/null \
  | grep -oiE 'priya|3-01|ws-07|alvarez|MRN-[0-9]+|maya|ACC-[0-9]+' | sort -u | head \
  || echo "(no obvious memorized surface fact in the body)"
echo "== done: $WL =="
