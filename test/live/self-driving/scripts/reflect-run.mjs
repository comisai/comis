// reflect-run.mjs — trigger a learning cron AND wait for its REAL durable execution record, then print
// the funnel verdict. A dispatch acknowledgement is not completion: the reflection LLM work may land
// much later. Polling `cron.runs` by the returned executionId avoids fixed sleeps, rotating-log joins,
// and dependence on logger prose while preserving the content-free per-run counters.
//
// Usage (on the VPS):
//   COMIS_CONFIG_PATHS=/home/comis/.comis/config.yaml COMIS_GATEWAY_TOKEN=<tok> \
//     node /root/reflect-run.mjs [jobName="Reflection"] [maxWaitS=120] [agentId]
//   # examples:
//   node /root/reflect-run.mjs                       # Reflection, default agent
//   node /root/reflect-run.mjs "Memory lifecycle"    # the forget sweep
//   node /root/reflect-run.mjs Reflection 180 mldag  # explicit wait + non-default agent (TARGET-01)
//
// Env: COMIS_CONFIG_PATHS + COMIS_GATEWAY_TOKEN default via _rig.mjs (rig env; explicit env wins);
// Run as an operator with gateway access; no direct log or database access is required.
import { ensureRpcEnv, importCli } from "./_rig.mjs";

ensureRpcEnv();
const { withClient } = await importCli("client/rpc-client.js");

const [, , jobName = "Reflection", maxWaitArg, agentId] = process.argv;
const maxWaitS = Number.parseInt(maxWaitArg ?? "120", 10);
if (!Number.isFinite(maxWaitS) || maxWaitS <= 0) { console.log("ERROR:maxWaitS must be a positive integer (arg 2)"); process.exit(1); }

const params = agentId ? { jobName, agentId } : { jobName };
let triggered;
try {
  triggered = await withClient((c) => c.call("cron.run", params));
} catch (e) {
  console.log("ERROR:cron.run failed: " + (e?.message || String(e)));
  process.exit(1);
}
if (!triggered?.triggered) { console.log("ERROR:cron.run did not trigger: " + JSON.stringify(triggered)); process.exit(1); }
if (typeof triggered.executionId !== "string" || triggered.executionId.length === 0) {
  console.log("ERROR:cron.run triggered without an executionId: " + JSON.stringify(triggered));
  process.exit(1);
}
const executionId = triggered.executionId;
console.log(`TRIGGERED ${jobName} (resolvedAgentId=${triggered.resolvedAgentId ?? agentId ?? "default"}, executionId=${executionId}); waiting for durable terminal state (max ${maxWaitS}s)…`);

const deadline = Date.now() + maxWaitS * 1000;
const terminalStatuses = new Set(["completed", "failed", "aborted", "skipped", "unknown"]);
while (Date.now() < deadline) {
  let history;
  try {
    history = await withClient((c) => c.call("cron.runs", {
      jobName,
      limit: 100,
      ...(agentId ? { agentId } : {}),
    }));
  } catch (e) {
    console.log("ERROR:cron.runs failed: " + (e?.message || String(e)));
    process.exit(1);
  }
  const run = Array.isArray(history?.runs)
    ? history.runs.find((candidate) => candidate?.executionId === executionId)
    : undefined;
  if (run && terminalStatuses.has(run.status)) {
    const counters = Object.fromEntries(
      (Array.isArray(run.counters) ? run.counters : [])
        .filter((counter) => typeof counter?.name === "string" && typeof counter?.value === "number")
        .map((counter) => [counter.name, counter.value]),
    );
    const digest = {
      executionId,
      agentId: run.agentId,
      status: run.status,
      durationMs: run.durationMs,
      deliveryStatus: run.deliveryStatus,
      ...(run.errorKind ? { errorKind: run.errorKind } : {}),
      ...counters,
    };
    console.log(`${run.status === "completed" ? "DONE" : "TERMINAL"}:`);
    console.log(JSON.stringify(digest));
    process.exit(run.status === "completed" ? 0 : 3);
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
console.log(`TIMEOUT after ${maxWaitS}s — execution ${executionId} did not reach a durable terminal state. It may still be in flight; raise maxWaitS or inspect \`comis cron runs "${jobName}"\`.`);
process.exit(2);
