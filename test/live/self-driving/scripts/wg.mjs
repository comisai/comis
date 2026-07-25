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
let addParams;
if (isNonDefault) {
  if (spec.payloadKind && spec.payloadKind !== "agent_turn") {
    console.error(
      `wg.mjs: WARN agentId=${agentId} → nested shape forces payload_kind:agent_turn ` +
      `(only the web shape maps agentId); ignoring payloadKind=${spec.payloadKind}. ` +
      `A non-default-agent system_event cron is not operator-authorable (F-CRON-1).`,
    );
  }
  addParams = {
    name,
    agentId, // the WEB shape maps this -> _agentId in normalizeCronAddParams
    schedule: { kind: "every", everyMs: 86_400_000 },
    message: spec.payloadText || "respond with exactly: ACK",
    wakeGate: { script, language: spec.language || "js" },
    ...(spec.deliveryTarget ? { deliveryTarget: spec.deliveryTarget } : {}),
  };
} else {
  addParams = {
    name,
    agentId,
    schedule_kind: "every",
    schedule_every_ms: 86_400_000,
    payload_kind: spec.payloadKind || "agent_turn",
    payload_text: spec.payloadText || "respond with exactly: ACK",
    wake_gate_script: script,
    wake_gate_language: spec.language || "js",
    ...(spec.deliveryTarget ? { deliveryTarget: spec.deliveryTarget } : {}),
    ...(spec.sessionTarget ? { session_target: spec.sessionTarget } : {}),
  };
}
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
