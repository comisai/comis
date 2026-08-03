// wg.mjs — wake-gate drive helper for the cron pre-run wake-gate live test.
// Authors (replacing any same-name job) → fires (cron.run force) → polls the execution
// record → reads BOTH per-fire oracles: cron.runs (the skip lens) + the latest
// cron_wake_gate DiagnosticRow (the system fork's content-free wake flag) + the stored
// wakeGate (ground truth from the cron store, since cron.list's mapJob omits it).
//
// One call = one fire, evaluated in isolation (honors the ≤1-open-COMIS-FAIL discipline).
//
//   node wg.mjs --spec /tmp/wgspec.json      # spec drives one job
//   node wg.mjs read <jobName> [agentId]     # re-read a job's oracles without re-firing
//
// spec = { name, script | scriptFile, language?, timeoutSeconds?, payloadKind?,
//          payloadText?, deliveryTarget?, agentId?, noFire? }
// Env: COMIS_CONFIG_PATHS + COMIS_GATEWAY_TOKEN default via _rig.mjs (rig env); COMIS_SRC optional.
import { readFileSync } from "node:fs";
import { ensureRpcEnv, importCli, requireCodeRoot, rig } from "./_rig.mjs";

ensureRpcEnv();
const { withClient } = await importCli("client/rpc-client.js");
const Database = requireCodeRoot("better-sqlite3");
const DATA = rig.dataDir;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = (m, p) => withClient((c) => c.call(m, p));

function storePathFor(agentId) {
  const ws = agentId && agentId !== "default" ? `workspace-${agentId}` : "workspace";
  return `${DATA}/${ws}/.scheduler/cron-jobs.json`;
}
function storedWakeGate(agentId, name) {
  try {
    const j = JSON.parse(readFileSync(storePathFor(agentId), "utf8"));
    const jobs = Array.isArray(j) ? j : j.jobs || Object.values(j);
    const w = jobs.find((x) => x && x.name === name);
    return w ? { found: true, wakeGate: w.wakeGate ?? null, id: w.id } : { found: false };
  } catch (e) {
    return { found: false, err: String(e?.message || e) };
  }
}
function latestDiag() {
  try {
    const db = new Database(`${DATA}/memory.db`, { readonly: true, fileMustExist: true });
    const row = db
      .prepare("SELECT timestamp,agent_id,details FROM obs_diagnostics WHERE category='cron_wake_gate' ORDER BY rowid DESC LIMIT 1")
      .get();
    db.close();
    if (!row) return null;
    return { agentId: row.agent_id, ts: row.timestamp, ...JSON.parse(row.details) };
  } catch (e) {
    return { err: String(e?.message || e) };
  }
}

const argv = process.argv.slice(2);
if (argv[0] === "read") {
  const [, name, agentId] = argv;
  const runs = await call("cron.runs", { jobName: name, ...(agentId ? { agentId } : {}), limit: 3 });
  console.log(JSON.stringify({ name, stored: storedWakeGate(agentId || "default", name), runs: runs.runs, diag: latestDiag() }, null, 1));
  process.exit(0);
}

const specPath = argv[0] === "--spec" ? argv[1] : "/tmp/wgspec.json";
const spec = JSON.parse(readFileSync(specPath, "utf8"));
const name = spec.name;
const agentId = spec.agentId || "default";
const script = spec.scriptFile ? readFileSync(spec.scriptFile, "utf8") : spec.script;

const isNonDefault = agentId !== "default";

// 1. Replace any same-name job so cron.run resolves unambiguously + the store is fresh.
//    NOTE: cron.remove has no agentId param (the operator gateway strips _agentId), so it
//    only removes from the DEFAULT agent — a non-default job cannot be replaced this way
//    (F-CRON-2). For a non-default agent, re-run with a FRESH name or a WIPE_CRONS restart.
try { await call("cron.remove", { jobName: name }); } catch { /* not found — ok */ }

// 2. Author the job. The FLAT cron.add shape (schedule_kind/payload_kind/…) IGNORES
//    `agentId` — the operator gateway strips `_agentId` and the flat normalize never
//    re-maps the user `agentId`, so a flat add always lands on the DEFAULT agent
//    (F-CRON-1). Only the WEB/nested shape (nested `schedule` + `message` + `wakeGate`)
//    re-derives `_agentId` from the user `agentId` — but it forces payload_kind:agent_turn.
//    So: default agent → flat shape (supports system_event); non-default agent → nested
//    shape (agent_turn only; a system_event on a non-default agent is NOT operator-authorable).
// BOTH shapes above predated the current `cron.add` contract and are now dead. The live
// contract (`CronAddRequestSchema`, cron-handlers.ts:134) is a `strictObject` requiring nested
// `schedule` AND `payload` objects — so the flat form (`schedule_kind`/`payload_kind`/
// `wake_gate_script`) fails twice over (unknown keys + two missing required objects), and the
// former nested form fails too because it sent `message` at the top level where the contract has
// no such key. Observed live: `cron.add` rejected with
//   [{path:["schedule"],message:"expected object, received undefined"},
//    {path:["payload"], message:"expected object, received undefined"}]
// which is an exemplary error — it named both offending paths — but it meant no wake-gate row
// could be authored at all. One shape now serves both agent cases: the contract takes `agentId`
// as a first-class optional field, so the flat/nested split that existed only to work around
// agentId mapping (F-CRON-1) is obsolete.
const payload =
  (spec.payloadKind ?? "agent_turn") === "delivery"
    ? { kind: "delivery", text: spec.payloadText || "respond with exactly: ACK" }
    : (spec.payloadKind === "heartbeat_event"
        ? {
            kind: "heartbeat_event",
            text: spec.payloadText || "respond with exactly: ACK",
            wakeMode: spec.wakeMode || "now",
          }
        : {
            kind: "agent_turn",
            message: spec.payloadText || "respond with exactly: ACK",
            ...(spec.model ? { model: spec.model } : {}),
          });
const addParams = {
  name,
  agentId,
  // `everyMs` is spec-configurable because the wake gate is the SCHEDULER-initiated gate
  // ("no human/model in the loop at fire time" — schema-scheduler.ts). A `cron.run` force-fire
  // records `trigger:"manual"` and evaluates NO gate (observed: stored wakeGate present,
  // `diag: null`, run completed as a plain agent_turn), so a 24h default made the gate
  // unreachable by this harness. Pass a short `everyMs` to let the scheduler fire it itself.
  schedule: { kind: "every", everyMs: spec.everyMs || 86_400_000 },
  payload,
  // `timeoutSeconds` is REQUIRED by CronWakeGateSchema (max 300) — omitting it is a
  // validation failure, not a defaulted field.
  wakeGate: { script, language: spec.language || "js", timeoutSeconds: spec.timeoutSeconds || 30 },
  ...(spec.deliveryTarget ? { deliveryTarget: spec.deliveryTarget } : {}),
};
const added = await call("cron.add", addParams);

if (spec.noFire) {
  console.log(JSON.stringify({ name, jobId: added.jobId, stored: storedWakeGate(agentId, name), fired: false }, null, 1));
  process.exit(0);
}

// 3. Fire (force mode → nextRunAtMs=0 → tick → executeJob → the wake-gate hook).
const before = latestDiag();
const fired = await call("cron.run", { jobName: name, agentId });

// 4. Poll the execution record (the fire is async; the skip/degrade record lands fast,
//    a woke agent_turn's record lands after the model turn — poll up to ~timeout+8s).
const deadline = Date.now() + ((spec.timeoutSeconds || 30) * 1000 + 12_000);
let runs = { runs: [] };
let diag = before;
const isNewer = (d) => d && d.ts && (!before || !before.ts || d.ts > before.ts);
while (Date.now() < deadline) {
  await sleep(1500);
  runs = await call("cron.runs", { jobName: name, agentId, limit: 1 });
  diag = latestDiag();
  if (runs.runs.length > 0 || isNewer(diag)) break;
}

// Only surface a diag that belongs to THIS fire. When the gate was NOT consulted
// (toggle OFF, autonomy disabled, no-bwrap degrade) NO new cron_wake_gate row is
// written, so latestDiag() returns a STALE prior-fire row — reporting it as this
// fire's verdict is a false read (e.g. a gate-OFF fire looking like wake=true).
// Emit diag:null in that case, matching the honest no-gate/degrade signal.
const diagThisFire = isNewer(diag) ? diag : null;

console.log(
  JSON.stringify(
    {
      name,
      jobId: added.jobId,
      fired: fired.triggered === true,
      resolvedAgentId: fired.resolvedAgentId,
      stored: storedWakeGate(agentId, name),
      run: runs.runs[0] || null,
      diag: diagThisFire,
    },
    null,
    1,
  ),
);
process.exit(0);
