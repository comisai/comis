// cfg-patch.mjs — robust deep-merge patcher for ~/.comis/config.yaml (preserves secrets, backs up).
// The Track-M workhorse: every config-flip run (autonomy.profile, tokenBudget, sandboxNoDowngrade,
// steerInject, intentAction, adding a test agent…) needs to mutate ONE nested key without rewriting
// the whole file (which would drop the real secrets you redacted when reading it). Hand-editing YAML
// over ssh→su is error-prone; this deep-merges a JSON patch in-process via the daemon's `yaml` lib.
//
// Run as root (deployed at /root/cfg-patch.mjs; ownership is restored after the write) or as comis:
//   ssh root@$VPS 'printf "%s" "{\"security\":{\"agentToAgent\":{\"tokenBudget\":1500}}}" > /tmp/patch.json; \
//                  node /root/cfg-patch.mjs'
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
// Code root (the yaml lib) + data dir resolve via _rig.mjs — installed package or source checkout.
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { rig, requireCodeRoot, comisDist } from './_rig.mjs';
const YAML = requireCodeRoot('yaml');
const path = rig.dataDir + '/config.yaml';
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
// Fail-fast schema guard: validate the MERGED config against the SAME AppConfigSchema
// (z.strictObject) the daemon parses at boot, BEFORE writing. A mis-scoped patch (e.g. a
// top-level `autonomy:` key — autonomy is agent-scoped under agents.<id>.autonomy) otherwise
// writes silently and only surfaces as `FATAL: Bootstrap failed: Unrecognized key` in a systemd
// crash-loop on the next restart. We block ONLY when the patch broke a previously-VALID config
// (pre-passed → post-fails), so a config with pre-existing issues (or env/include expansion the
// raw parse can't see) never blocks; if the schema can't be loaded, we degrade to a warning.
// @comis/core is ESM, so it must be dynamic-import()ed (CJS require() throws ERR_REQUIRE_ESM) — mirror
// _rig's importCli() pattern. If it can't load (source/layout drift), validation degrades to a warning.
let AppConfigSchema;
try { ({ AppConfigSchema } = await import(comisDist('core', 'dist/index.js'))); } catch { /* validation unavailable — proceed */ }
const validate = (obj) => {
  if (typeof AppConfigSchema?.safeParse !== 'function') return { unavailable: true, issues: [] };
  const r = AppConfigSchema.safeParse(obj);
  return r.success ? { ok: true, issues: [] } : { ok: false, issues: r.error.issues ?? [] };
};
const keyOf = (i) => `${i.path.join('.')}|${i.message}`;
const pre = validate(structuredClone(cfg));
merge(cfg, patch);
const post = validate(cfg);
if (post.ok === false) {
  // Isolate the PATCH's effect: block ONLY on issues the patch INTRODUCED (present in post,
  // absent in pre), diffing by (path, message). A pre-existing failure the raw parse can't
  // resolve — e.g. a gateway-token placeholder the daemon fills from COMIS_GATEWAY_TOKEN at
  // runtime — is present in BOTH, so it never blocks an otherwise-valid patch.
  const preKeys = new Set(pre.issues.map(keyOf));
  const introduced = post.issues.filter((i) => !preKeys.has(keyOf(i)));
  if (introduced.length > 0) {
    console.error('cfg-patch REFUSED — the patch introduces config-validation errors (config.yaml NOT modified):');
    for (const i of introduced) console.error(`  • ${i.path.join('.') || '<root>'}: ${i.message}`);
    console.error('  hint: autonomy.* is AGENT-scoped — nest under agents.<id>.autonomy, NOT top-level.');
    process.exit(1);
  }
}
copyFileSync(path, path + '.bak-patch');
writeFileSync(path, YAML.stringify(cfg));
try {
  // A root-run patch must not leave root-owned files in the service user's data dir.
  if (typeof process.getuid === 'function' && process.getuid() === 0)
    execSync(`chown ${rig.comisUser}:${rig.comisUser} '${path}' '${path}.bak-patch'`);
} catch { /* ownership already right on non-root runs */ }
console.log('patched config.yaml (backup: config.yaml.bak-patch)');
// Echo the load-bearing sections so you can eyeball the result without re-reading the file:
console.log('agentToAgent=' + JSON.stringify(cfg.security?.agentToAgent ?? null));
console.log('orchestration=' + JSON.stringify(cfg.orchestration ?? null));
console.log('agents=' + JSON.stringify(Object.keys(cfg.agents ?? {})));
console.log('autonomy.default=' + JSON.stringify(cfg.agents?.default?.autonomy ?? null));
// Inbound-trust knobs (verify a trust-flip landed — 01-SETUP.md §3):
console.log('elevatedReply.default=' + JSON.stringify(cfg.agents?.default?.elevatedReply ?? null));
console.log('telegram.allowFrom=' + JSON.stringify(cfg.channels?.telegram?.allowFrom ?? null));
// Microsoft Teams inbound gate (allowMode:open processes any sender; allowlist keys on
// aadObjectId/conversation.id). The loopback bridges live in the daemon ENV
// (COMIS_MSTEAMS_TEST_JWKS / COMIS_MSTEAMS_TEST_CONNECTOR), not config — so they are NOT echoed here.
console.log('msteams.enabled=' + JSON.stringify(cfg.channels?.msteams?.enabled ?? null));
console.log('msteams.allowMode=' + JSON.stringify(cfg.channels?.msteams?.allowMode ?? null));
console.log('msteams.allowFrom=' + JSON.stringify(cfg.channels?.msteams?.allowFrom ?? null));
