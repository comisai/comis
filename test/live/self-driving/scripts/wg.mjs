// wg.mjs — wake-gate drive helper for the cron pre-run wake-gate live test.
// Authors (replacing any same-name job) → fires (cron.run force) → polls the execution
// record → reads BOTH per-fire oracles: cron.runs (the skip lens) + the latest
// cron_wake_gate DiagnosticRow (the fleet fork's content-free wake flag) + the stored
// wakeGate (ground truth from the cron store, since cron.list's mapJob omits it).
//
// One call = one fire, evaluated in isolation (honors the ≤1-open-COMIS-FAIL discipline).
//
//   node wg.mjs --spec /tmp/wgspec.json      # spec drives one job
//   node wg.mjs read <jobName> [agentId]     # re-read a job's oracles without re-firing
//
// spec = { name, script | scriptFile, language?, timeoutSeconds?, payloadKind?,
//          payloadText?, deliveryTarget?, agentId?, noFire? }
// Env: COMIS_CONFIG_PATHS + COMIS_GATEWAY_TOKEN (same as revoke.mjs); COMIS_SRC optional.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const SRC = process.env.COMIS_SRC || "/root/comis-src";
const { withClient } = await import(SRC + "/packages/cli/dist/client/rpc-client.js");
const require = createRequire(SRC + "/packages/daemon/package.json");
const Database = require("better-sqlite3");
const DATA = process.env.COMIS_DATA_DIR || "/home/comis/.comis";

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

// 1. Replace any same-name job so cron.run resolves unambiguously + the store is fresh.
try { await call("cron.remove", { jobName: name }); } catch { /* not found — ok */ }

// 2. Author with the flat chat-tool fields.
const addParams = {
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
while (Date.now() < deadline) {
  await sleep(1500);
  runs = await call("cron.runs", { jobName: name, agentId, limit: 1 });
  diag = latestDiag();
  const diagIsNew = diag && diag.ts && (!before || !before.ts || diag.ts > before.ts);
  if (runs.runs.length > 0 || diagIsNew) break;
}

console.log(
  JSON.stringify(
    {
      name,
      jobId: added.jobId,
      fired: fired.triggered === true,
      resolvedAgentId: fired.resolvedAgentId,
      stored: storedWakeGate(agentId, name),
      run: runs.runs[0] || null,
      diag,
    },
    null,
    1,
  ),
);
process.exit(0);
