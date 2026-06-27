// reflect-run.mjs — trigger a fire-and-forget learning cron AND wait for its REAL completion, then
// print the funnel verdict. Born from the reflect-obs-20260627 run: `cron.run jobName "Reflection"` is
// fire-and-forget — the scheduler logs "Job dispatched (fire-and-forget)" in ~1s while the reflection
// LLM call lands ~20s later, so a naive grep/fixed-sleep reads a FALSE count:0. This polls the EXACT
// completion marker (never the dispatch line) and parses the content-free funnel in one call.
//
// Usage (on the VPS):
//   COMIS_CONFIG_PATHS=/home/comis/.comis/config.yaml COMIS_GATEWAY_TOKEN=<tok> \
//     node /root/reflect-run.mjs [jobName="Reflection"] [maxWaitS=120] [agentId]
//   # examples:
//   node /root/reflect-run.mjs                       # Reflection, default agent
//   node /root/reflect-run.mjs "Memory lifecycle"    # the forget sweep
//   node /root/reflect-run.mjs Reflection 180 mldag  # explicit wait + non-default agent (TARGET-01)
//
// Env: COMIS_CONFIG_PATHS + COMIS_GATEWAY_TOKEN (the RPC, like revoke.mjs); DATA (the data dir whose
// logs/ it polls; default /home/comis/.comis). Run as root (reads the comis-owned log fine) or comis.
// Adjust the import path if the daemon src tree isn't at /root/comis-src.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { withClient } from "/root/comis-src/packages/cli/dist/client/rpc-client.js";

const [, , jobName = "Reflection", maxWaitArg, agentId] = process.argv;
const maxWaitS = Number.parseInt(maxWaitArg ?? "120", 10);
if (!Number.isFinite(maxWaitS) || maxWaitS <= 0) { console.log("ERROR:maxWaitS must be a positive integer (arg 2)"); process.exit(1); }
const DATA = process.env.DATA || "/home/comis/.comis";
const logDir = join(DATA, "logs");

// The EXACT completion marker per cron — NEVER the fire-and-forget "Job dispatched" dispatch line.
const MARKERS = {
  "Reflection": "Reflection complete (all kinds)",
  "Memory lifecycle": "Memory lifecycle sweep complete",
  "Memory review": "Memory review complete",
};
const marker = MARKERS[jobName] ?? `${jobName} complete`;

/** Count log lines carrying the completion marker (across all daemon.*.log files; soft-fail to 0). */
function markerCount() {
  let n = 0;
  let files = [];
  try { files = readdirSync(logDir).filter((f) => /^daemon\..*\.log$/.test(f)); } catch { return 0; }
  for (const f of files) {
    try {
      const txt = readFileSync(join(logDir, f), "utf8");
      for (const line of txt.split("\n")) if (line.includes(marker)) n += 1;
    } catch { /* unreadable file — skip */ }
  }
  return n;
}

/** The latest completion line's parsed JSON (the funnel), or undefined. */
function latestFunnel() {
  let best;
  let bestSeq = -1;
  let files = [];
  try { files = readdirSync(logDir).filter((f) => /^daemon\..*\.log$/.test(f)); } catch { return undefined; }
  for (const f of files) {
    let txt = "";
    try { txt = readFileSync(join(logDir, f), "utf8"); } catch { continue; }
    for (const line of txt.split("\n")) {
      if (!line.includes(marker)) continue;
      try {
        const j = JSON.parse(line);
        const seq = typeof j.time === "string" ? Date.parse(j.time) : (j.time ?? 0);
        if (seq >= bestSeq) { bestSeq = seq; best = j; }
      } catch { /* non-JSON line — skip */ }
    }
  }
  return best;
}

const before = markerCount();
const params = agentId ? { jobName, agentId } : { jobName };
let triggered;
try {
  triggered = await withClient((c) => c.call("cron.run", params));
} catch (e) {
  console.log("ERROR:cron.run failed: " + (e?.message || String(e)));
  process.exit(1);
}
if (!triggered?.triggered) { console.log("ERROR:cron.run did not trigger: " + JSON.stringify(triggered)); process.exit(1); }
console.log(`TRIGGERED ${jobName} (resolvedAgentId=${triggered.resolvedAgentId ?? agentId ?? "default"}); waiting for "${marker}" (max ${maxWaitS}s)…`);

const deadline = Date.now() + maxWaitS * 1000;
let elapsed = 0;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2000));
  elapsed += 2;
  if (markerCount() > before) {
    // Print the completion line's CONTENT fields, stripping the Pino envelope — works for ANY cron
    // (Reflection → the funnel; Memory lifecycle → scanned/evicted/demoted; review → its counts),
    // rather than hardcoding the reflection shape (which printed "?" for non-reflection crons).
    const f = latestFunnel() || {};
    const ENVELOPE = new Set(["pid", "hostname", "name", "instanceId", "time", "level", "msg", "module", "submodule", "reflectKind", "entryId", "seq", "traceId", "sessionId", "sessionKey", "workspaceDir", "provider", "modelId", "v"]);
    const digest = Object.fromEntries(Object.entries(f).filter(([k]) => !ENVELOPE.has(k)));
    // Content-free by construction (the completion line carries counts + closed enums only — INV-6).
    console.log(`DONE after ~${elapsed}s:`);
    console.log(JSON.stringify(digest));
    process.exit(0);
  }
}
console.log(`TIMEOUT after ${maxWaitS}s — no new "${marker}" line. The run may still be in flight (LLM ~20s); raise maxWaitS or check the log.`);
process.exit(2);
