// Minimal WS JSON-RPC caller — reuses the CLI's authenticated client to call ANY gateway RPC.
// (The CLI's RPC transport is WebSocket; there's no generic `comis rpc` verb, so we drive it directly.)
//
// Usage:  node revoke.mjs <method> [paramKey paramVal | '<json-params>' | --file [path]]
//   node revoke.mjs capabilities.introspect
//   node revoke.mjs run.kill   rootRunId root-session-11111111-1111-4111-8111-111111111111-ZGVmYXVsdDphZ2VudDpkZWZhdWx0OnVzZXI6dGVsZWdyYW06MTcxNzAwMDAwMA
//   node revoke.mjs lease.revoke leaseId <uuid>
//   node revoke.mjs cron.list  agentId "*"
//   node revoke.mjs obs.system.health sinceHours 1            # val JSON-parsed → number 1
//   node revoke.mjs graph.execute '{"nodes":[{"nodeId":"n1","task":"hi"}]}'  # full JSON params object
//   node revoke.mjs message.send --file                      # MULTI-PARAM: params from /tmp/rpc.json
//   node revoke.mjs tokens.create --file /tmp/tok.json       # ...or an explicit path
//
// ⚠ Provider-backed methods are risk-gated. Anything that drives a model turn (`graph.execute`
// node tasks, `cron.run`, `message.send`, cron authoring, …) goes through
// live-provider-risk-gate.mjs on the RESOLVED params and exits 4 before the socket opens when the
// text is cyber-abuse-shaped and the operator has not authorized it (see CYBER-ABUSE-SUSPENSIONS.md).
// Operational/diagnostic RPCs are exempt so triage keeps working — the exempt set is
// `UNGATED_RPC_METHODS` in live-provider-risk-gate.mjs (read it there; do not re-list it here).
// Any OTHER method is gated by default — a benign payload classifies clean and passes, so the
// gate only bites on suspended content.
//
// Param typing: a single arg that parses as a JSON object is the WHOLE params object;
// otherwise key+val, with val JSON-parsed when possible ("1"→1, "true"→true, '["a"]'→array)
// and left as a string on parse failure (so bare ids/sessionKeys still work).
//
// ⚠ `--file` mode: for MULTI-PARAM operator RPCs (message.send,
// tokens.create, …) the inline-JSON form gets MANGLED through `ssh → su - comis -c "node revoke.mjs … {json}"`
// (the nested quotes collapse, e.g. the key becomes `"channel_type:telegram"`). Write the params to a
// world-readable file first (`printf '%s' '{"channel_type":"telegram","to":"…","text":"…"}' > /tmp/rpc.json`)
// then call with `--file` — same trick `cfg-patch.mjs` already uses for /tmp/patch.json.
//
// withClient() needs COMIS_CONFIG_PATHS + COMIS_GATEWAY_TOKEN; _rig.mjs defaults BOTH from the box
// rig config (/root/comis-rig.env → DATA + GWTOKEN), so a bare `node revoke.mjs <method>` works on a
// deployed box. Explicit env still wins (e.g. to probe with a WRONG token on purpose).
// --pick <dotpath>: print ONLY that field of the result instead of the whole
// RESULT:{…} blob, so the caller stops hand-writing `node -e 'JSON.parse(...)'` extractors. A dotpath
// indexes objects + arrays: `report.findings.0.code`, `runs.0.summary`, `triggered`. Prints `PICK:<json>`
// (or `PICK:undefined` for a missing path). Errors still print `ERROR:…` unchanged.
import { readFileSync } from "node:fs";
// Code-root resolution (installed comisai package OR source checkout; COMIS_SRC overrides) + RPC env
// defaults live in _rig.mjs — shared by every helper, deployed alongside by deploy-scripts.sh.
import { ensureRpcEnv, importCli } from "./_rig.mjs";
import {
  collectRpcRiskTexts,
  isGatedRpcMethod,
  liveProviderRiskError,
} from "./live-provider-risk-gate.mjs";
ensureRpcEnv();
const { withClient } = await importCli("client/rpc-client.js");
const rawArgv = process.argv.slice(2);
let pickPath;
const pIdx = rawArgv.indexOf("--pick");
if (pIdx !== -1) { pickPath = rawArgv[pIdx + 1]; rawArgv.splice(pIdx, 2); }
const [method, key, val] = rawArgv;
const tryJson = (s) => { try { return JSON.parse(s); } catch { return s; } };
let params = {};
if (key === "--file") {
  // multi-param RPCs: read the WHOLE params object from a file (dodges the su -c JSON-in-argv mangling)
  params = JSON.parse(readFileSync(val || "/tmp/rpc.json", "utf8"));
} else if (key !== undefined && val === undefined) {
  // single arg: a JSON object is the full params; anything else is ignored (no value)
  const parsed = tryJson(key);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) params = parsed;
} else if (key !== undefined) {
  params = { [key]: tryJson(val) };
}
// Methods that drive a model turn (graph.execute node tasks, cron.run, message.send, …)
// reach the provider with caller-supplied text, so they carry the same suspension as the
// dedicated injectors. Gate on the RESOLVED params — inline JSON, key+val, and --file all
// land here — and before withClient() opens the socket. Operational/diagnostic RPCs stay
// ungated so live triage keeps working.
if (isGatedRpcMethod(method)) {
  const providerRiskError = liveProviderRiskError({
    source: `revoke.mjs ${method}`,
    texts: collectRpcRiskTexts(params),
  });
  if (providerRiskError) {
    console.error(providerRiskError);
    process.exit(4);
  }
}
try {
  const r = await withClient((c) => c.call(method, params));
  if (pickPath !== undefined) {
    const picked = pickPath.split(".").reduce((acc, k) => (acc == null ? undefined : acc[k]), r);
    console.log("PICK:" + JSON.stringify(picked));
  } else {
    console.log("RESULT:" + JSON.stringify(r));
  }
} catch (e) {
  console.log("ERROR:" + (e?.message || String(e)));
}
process.exit(0);
