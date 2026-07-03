// Minimal WS JSON-RPC caller — reuses the CLI's authenticated client to call ANY gateway RPC.
// (The CLI's RPC transport is WebSocket; there's no generic `comis rpc` verb, so we drive it directly.)
//
// Usage:  node revoke.mjs <method> [paramKey paramVal | '<json-params>' | --file [path]]
//   node revoke.mjs capabilities.introspect
//   node revoke.mjs run.kill   rootRunId root-session-default:678314278:678314278:peer:678314278
//   node revoke.mjs lease.revoke leaseId <uuid>
//   node revoke.mjs cron.list  agentId "*"
//   node revoke.mjs obs.fleet.health sinceHours 1            # val JSON-parsed → number 1
//   node revoke.mjs graph.execute '{"nodes":[{"nodeId":"n1","task":"hi"}]}'  # full JSON params object
//   node revoke.mjs message.send --file                      # MULTI-PARAM: params from /tmp/rpc.json
//   node revoke.mjs tokens.create --file /tmp/tok.json       # ...or an explicit path
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
// Needs COMIS_CONFIG_PATHS + COMIS_GATEWAY_TOKEN in env so withClient() resolves the gateway URL+token:
//   export COMIS_CONFIG_PATHS=/home/comis/.comis/config.yaml
//   export COMIS_GATEWAY_TOKEN=<the literal ≥32-char token from config.yaml>
// Adjust the import path if the daemon src tree isn't at /root/comis-src.
// --pick <dotpath>: print ONLY that field of the result instead of the whole
// RESULT:{…} blob, so the caller stops hand-writing `node -e 'JSON.parse(...)'` extractors. A dotpath
// indexes objects + arrays: `report.findings.0.code`, `runs.0.summary`, `triggered`. Prints `PICK:<json>`
// (or `PICK:undefined` for a missing path). Errors still print `ERROR:…` unchanged.
import { readFileSync } from "node:fs";
// COMIS_SRC overrides the daemon src root (VPS default /root/comis-src; set to a local checkout for a
// LOCAL daemon run). Dynamic import so the path is env-resolvable.
const { withClient } = await import((process.env.COMIS_SRC || "/root/comis-src") + "/packages/cli/dist/client/rpc-client.js");
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
