// cfg-patch.mjs — robust deep-merge patcher for ~/.comis/config.yaml (preserves secrets, backs up).
// The Track-M workhorse: every config-flip run (autonomy.profile, tokenBudget, sandboxNoDowngrade,
// steerInject, intentAction, adding a test agent…) needs to mutate ONE nested key without rewriting
// the whole file (which would drop the real secrets you redacted when reading it). Hand-editing YAML
// over ssh→su is error-prone; this deep-merges a JSON patch in-process via the daemon's `yaml` lib.
//
// Run AS comis so it can write the comis-owned config + read the daemon's node_modules:
//   ssh root@$VPS 'printf "%s" "{\"security\":{\"agentToAgent\":{\"tokenBudget\":1500}}}" > /tmp/patch.json; \
//                  su - comis -c "node /tmp/cfg-patch.mjs"'
//
// Patch source: argv[2] inline JSON, ELSE /tmp/patch.json.
//   ⚠ GOTCHA: `su - comis -c "..."` does NOT cross env vars or inline single-quotes cleanly — write the
//   patch to /tmp/patch.json first (world-readable) and let cfg-patch read it. Do NOT rely on a TAG= env
//   to name the backup across `su -` (it won't propagate; the backup stays `config.yaml.bak-patch`).
//
// Set a value:   {"agents":{"default":{"autonomy":{"profile":"assistant"}}}}
// Delete a key:  pass the special string "__DELETE__" as the value:
//                {"agents":{"downgrader":"__DELETE__"},"security":{"agentToAgent":"__DELETE__"}}
//
// Inbound-trust flips (the trust-tiered deny-by-origin axis — 01-SETUP.md §3; test BOTH sides):
//   admin (agent inherits admin): {"agents":{"default":{"elevatedReply":{"enabled":true,"senderTrustMap":{"678314278":"admin"}}}}}
//   non-admin (deny floor):       {"agents":{"default":{"elevatedReply":{"senderTrustMap":{"678314278":"user"}}}}}
//                            or:   {"agents":{"default":{"elevatedReply":"__DELETE__"}}}
//   not-allowed (no turn):        {"channels":{"telegram":{"allowFrom":["999999999"]}}}
//
// Adjust the require path if the daemon src tree isn't at /root/comis-src.
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('/root/comis-src/packages/daemon/package.json');
const YAML = require('yaml');
const path = (process.env.HOME || '/home/comis') + '/.comis/config.yaml';
// argv[2] is inline JSON, OR a path to a JSON file, ELSE fall back to /tmp/patch.json. The
// path-detection avoids the footgun where passing
// `cfg-patch.mjs /tmp/patch.json` JSON.parsed the PATH STRING and threw "Unexpected token '/'"
// — a file arg now Just Works instead of silently needing the no-arg form.
const arg = process.argv[2];
const patchRaw = arg
  ? (existsSync(arg) ? readFileSync(arg, 'utf8') : arg)
  : readFileSync('/tmp/patch.json', 'utf8');
const patch = JSON.parse(patchRaw);
const cfg = YAML.parse(readFileSync(path, 'utf8')) || {};
function merge(t, s) {
  for (const k of Object.keys(s)) {
    if (s[k] === '__DELETE__') { delete t[k]; continue; }
    if (s[k] && typeof s[k] === 'object' && !Array.isArray(s[k])) {
      t[k] = (t[k] && typeof t[k] === 'object' && !Array.isArray(t[k])) ? t[k] : {};
      merge(t[k], s[k]);
    } else { t[k] = s[k]; }
  }
}
copyFileSync(path, path + '.bak-patch');
merge(cfg, patch);
writeFileSync(path, YAML.stringify(cfg));
console.log('patched config.yaml (backup: config.yaml.bak-patch)');
// Echo the load-bearing sections so you can eyeball the result without re-reading the file:
console.log('agentToAgent=' + JSON.stringify(cfg.security?.agentToAgent ?? null));
console.log('orchestration=' + JSON.stringify(cfg.orchestration ?? null));
console.log('agents=' + JSON.stringify(Object.keys(cfg.agents ?? {})));
console.log('autonomy.default=' + JSON.stringify(cfg.agents?.default?.autonomy ?? null));
// Inbound-trust knobs (verify a trust-flip landed — 01-SETUP.md §3):
console.log('elevatedReply.default=' + JSON.stringify(cfg.agents?.default?.elevatedReply ?? null));
console.log('telegram.allowFrom=' + JSON.stringify(cfg.channels?.telegram?.allowFrom ?? null));
