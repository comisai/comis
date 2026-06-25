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
// ⚠ `--file` mode (codex-30uc run 2026-06-25): for MULTI-PARAM operator RPCs (message.send,
// tokens.create, …) the inline-JSON form gets MANGLED through `ssh → su - comis -c "node revoke.mjs … {json}"`
// (the nested quotes collapse, e.g. the key becomes `"channel_type:telegram"`). Write the params to a
// world-readable file first (`printf '%s' '{"channel_type":"telegram","to":"…","text":"…"}' > /tmp/rpc.json`)
// then call with `--file` — same trick `cfg-patch.mjs` already uses for /tmp/patch.json.
//
// Needs COMIS_CONFIG_PATHS + COMIS_GATEWAY_TOKEN in env so withClient() resolves the gateway URL+token:
//   export COMIS_CONFIG_PATHS=/home/comis/.comis/config.yaml
//   export COMIS_GATEWAY_TOKEN=<the literal ≥32-char token from config.yaml>
// Adjust the import path if the daemon src tree isn't at /root/comis-src.
import { readFileSync } from "node:fs";
import { withClient } from "/root/comis-src/packages/cli/dist/client/rpc-client.js";
const [, , method, key, val] = process.argv;
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
  console.log("RESULT:" + JSON.stringify(r));
} catch (e) {
  console.log("ERROR:" + (e?.message || String(e)));
}
process.exit(0);
