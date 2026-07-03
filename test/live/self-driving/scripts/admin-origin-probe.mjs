#!/usr/bin/env node
// admin-origin-probe.mjs — DETERMINISTIC admin-tool security-gate oracle prover (run on the VPS).
//
// WHY THIS EXISTS: the 8 admin `*_manage` tools are guarded by
// FOUR mechanisms. The NON-ADMIN-DENIAL / SUB-AGENT-NEVER / CONTENT-FREE-AUDIT oracles are
// provider-independent, prove-once code-paths — and a capable frontier model (claude-sonnet-4-6)
// won't reliably "try an admin tool and get denied" on demand (it refuses the adversarial framing,
// or simply doesn't have the deferred tool on the wire as non-admin). So, exactly like gate-probe.mjs,
// the PRIMARY method is to call the DEPLOYED guards off `dist/` directly. This proves the actual
// shipped code-path, fast. (`03-OBSERVABILITY.md` §"prove deterministic gate oracles via the dist".)
//
// Proves (off the deployed dist):
//   guard   layer-1 createTrustGuard(name,"admin")  → throws permission_denied for guest/user, passes admin
//   origin  layer-2 assertNotAgentOrigin            → non-admin _agentId DENIED + content-free audit;
//                                                      admin-trust _agentId PASSES (inherits); operator PASSES
//   audit   H-AUDIT the denial audit event carries method+reason ONLY (no param value / secret leaks)
//   adminset ADMIN_METHODS = API_CONTRACTS_ORDERED.filter(scopes∋"admin") covers every manage mutator,
//                                                      and EXCLUDES memory.store (#245 intact)
//   denylist layer-3 SUB_AGENT_TOOL_DENYLIST contains all 8 (sub-agent can never be delegated them)
//
// Usage (on the VPS):  node /root/admin-origin-probe.mjs [guard|origin|audit|adminset|denylist|all]
//   SRC=/root/comis-src overridable. Exit 0 = all PASS, 1 = any FAIL.

const SRC = process.env.SRC || "/root/comis-src";
const P = {
  origin: `${SRC}/packages/daemon/dist/api/shared/assert-not-agent-origin.js`,
  helpers: `${SRC}/packages/skills/dist/platform-tools/tool-helpers.js`,
  core: `${SRC}/packages/core/dist/index.js`,
};
const load = async (p, name) => { const m = await import(p); return m[name] ?? m.default?.[name]; };

const results = [];
const record = (gate, pass, detail) => { results.push({ gate, pass }); console.log(`${pass ? "PASS" : "FAIL"}  ${gate.padEnd(9)} ${detail}`); };

// The 8 admin manage tools + their full action surface (verified at HEAD a2329c9b).
const MANAGE_METHODS = {
  agents:    ["create", "get", "update", "delete", "suspend", "resume", "list"],
  channels:  ["list", "get", "enable", "disable", "restart"],            // configure → config.* (covered separately)
  heartbeat: ["states", "get", "update", "trigger"],                     // status → heartbeat.states
  mcp:       ["list", "status", "connect", "disconnect", "reconnect"],
  memory:    ["stats", "browse", "delete", "flush", "export", "pin", "unpin"],
  models:    ["list", "test", "list_providers"],
  providers: ["list", "get", "create", "update", "delete", "enable", "disable"],
  tokens:    ["list", "create", "revoke", "rotate"],
};
const MANAGE_TOOLS = ["agents_manage", "channels_manage", "heartbeat_manage", "mcp_manage", "memory_manage", "models_manage", "providers_manage", "tokens_manage"];

// --- guard: layer-1 agent trust guard (createTrustGuard) ---
async function probeGuard() {
  const createTrustGuard = await load(P.helpers, "createTrustGuard");
  const { runWithContext } = await import(P.core);
  if (typeof createTrustGuard !== "function") return record("guard", false, "createTrustGuard export not found");
  const threw = (trust, tool) => {
    const g = createTrustGuard(tool, "admin");
    try { runWithContext({ trustLevel: trust }, () => g()); return null; }
    catch (e) { return e.message; }
  };
  // guest/user MUST be denied; admin MUST pass. Test a factory tool + the bespoke memory_manage.
  const denials = [];
  for (const tool of ["agents_manage", "memory_manage", "tokens_manage"]) {
    for (const trust of ["guest", "user"]) {
      const m = threw(trust, tool);
      if (!m || !/permission_denied/.test(m)) denials.push(`${tool}@${trust}=NOT-DENIED`);
    }
    const adminMsg = threw("admin", tool);
    if (adminMsg !== null) denials.push(`${tool}@admin=WRONGLY-DENIED(${adminMsg})`);
  }
  // also prove the "unset trust → guest → denied" fail-safe
  const g = createTrustGuard("agents_manage", "admin");
  let unsetDenied = false;
  try { runWithContext({}, () => g()); } catch (e) { unsetDenied = /permission_denied/.test(e.message); }
  if (!unsetDenied) denials.push("unset-trust=NOT-DENIED(should fail-safe to guest)");
  record("guard", denials.length === 0,
    denials.length === 0 ? "guest+user+unset DENIED (permission_denied); admin PASSES — for agents/memory/tokens_manage" : denials.join(" "));
}

// --- origin: layer-2 deny-by-origin chokepoint (assertNotAgentOrigin), trust-tiered ---
async function probeOrigin() {
  const assertNotAgentOrigin = await load(P.origin, "assertNotAgentOrigin");
  if (typeof assertNotAgentOrigin !== "function") return record("origin", false, "assertNotAgentOrigin export not found");
  const mk = () => { const ev = []; return { ev, deps: { container: { eventBus: { emit: (k, p) => ev.push({ k, p }) }, config: { tenantId: "default" } } } }; };
  const fails = [];
  // (1) non-admin agent origin → MUST throw + emit one capability_denied audit
  {
    const { ev, deps } = mk(); let threw = false;
    try { assertNotAgentOrigin({ _agentId: "atk", _trustLevel: "user" }, deps, "agents.create"); }
    catch { threw = true; }
    const aud = ev.find((e) => e.k === "audit:event")?.p;
    if (!threw) fails.push("non-admin NOT-thrown");
    if (!aud || aud.kind !== "capability_denied" || aud.metadata?.reason !== "non_admin_agent_origin") fails.push("non-admin missing capability_denied/non_admin_agent_origin audit");
  }
  // (2) admin-trust agent origin → MUST pass (inherit), no throw, no audit
  {
    const { ev, deps } = mk(); let threw = false;
    try { assertNotAgentOrigin({ _agentId: "op", _trustLevel: "admin" }, deps, "agents.create"); } catch { threw = true; }
    if (threw) fails.push("admin-trust WRONGLY-denied");
    if (ev.length) fails.push("admin-trust emitted-audit (should be silent)");
  }
  // (3) operator origin (no _agentId) → MUST pass, no audit
  {
    const { ev, deps } = mk(); let threw = false;
    try { assertNotAgentOrigin({ _trustLevel: "user" }, deps, "agents.create"); } catch { threw = true; }
    if (threw) fails.push("operator(no _agentId) WRONGLY-denied");
    if (ev.length) fails.push("operator emitted-audit (should be silent)");
  }
  record("origin", fails.length === 0,
    fails.length === 0 ? "non-admin agent DENIED+audited; admin-trust INHERITS (pass); operator PASSES" : fails.join(" "));
}

// --- audit: H-AUDIT content-free — denial event carries method+reason ONLY, never a param value/secret ---
async function probeAudit() {
  const assertNotAgentOrigin = await load(P.origin, "assertNotAgentOrigin");
  if (typeof assertNotAgentOrigin !== "function") return record("audit", false, "assertNotAgentOrigin export not found");
  const ev = [];
  const deps = { container: { eventBus: { emit: (k, p) => ev.push({ k, p }) }, config: { tenantId: "default" } } };
  // Stuff the params with poison values that MUST NOT appear in the content-free audit.
  const POISON = ["LEAKNAME-xyzzy", "sk-LEAKSECRET-9999", "tok-LEAK-abcdef", "PASSWORD-h4x"];
  try {
    assertNotAgentOrigin(
      { _agentId: "atk", _trustLevel: "user", name: POISON[0], secret: POISON[1], token: POISON[2], password: POISON[3], scopes: ["admin"] },
      deps, "tokens.create",
    );
  } catch { /* expected */ }
  const aud = ev.find((e) => e.k === "audit:event")?.p;
  const blob = JSON.stringify(aud ?? {});
  const leaked = POISON.filter((v) => blob.includes(v));
  // also assert the metadata is exactly {method, reason}
  const md = aud?.metadata ?? {};
  const mdKeys = Object.keys(md).sort().join(",");
  const ok = leaked.length === 0 && aud?.kind === "capability_denied" && mdKeys === "method,reason";
  record("audit", ok,
    ok ? `denial event content-free: metadata={method,reason} only, 0/${POISON.length} poison values leaked`
       : `leaked=[${leaked}] metadataKeys=[${mdKeys}] kind=${aud?.kind}`);
}

// --- adminset: ADMIN_METHODS covers every manage mutator + EXCLUDES memory.store ---
async function probeAdminset() {
  const { API_CONTRACTS_ORDERED } = await import(P.core);
  if (!Array.isArray(API_CONTRACTS_ORDERED)) return record("adminset", false, "API_CONTRACTS_ORDERED not an array");
  const ADMIN = new Set(API_CONTRACTS_ORDERED.filter((c) => c.scopes?.includes("admin")).map((c) => c.method));
  const missing = [];
  for (const [prefix, actions] of Object.entries(MANAGE_METHODS)) {
    for (const a of actions) { const m = `${prefix}.${a}`; if (!ADMIN.has(m)) missing.push(m); }
  }
  // The rpc-scoped agent-reachable memory surface must NOT be admin-gated by the chokepoint.
  const mustBeRpc = ["memory.store", "memory.ask", "memory.search_files", "memory.get_file", "channels.health", "channels.capabilities"];
  const wronglyAdmin = mustBeRpc.filter((m) => ADMIN.has(m));
  const ok = missing.length === 0 && wronglyAdmin.length === 0;
  record("adminset", ok,
    ok ? `all ${Object.values(MANAGE_METHODS).flat().length} manage admin-methods ∈ ADMIN_METHODS; memory.store + rpc-surface EXCLUDED; |ADMIN_METHODS|=${ADMIN.size}`
       : `missing-from-admin=[${missing}] wrongly-admin=[${wronglyAdmin}]`);
}

// --- denylist: layer-3 sub-agent denylist contains all 8 ---
async function probeDenylist() {
  const { SUB_AGENT_TOOL_DENYLIST } = await import(P.core);
  if (!SUB_AGENT_TOOL_DENYLIST) return record("denylist", false, "SUB_AGENT_TOOL_DENYLIST not found");
  const set = SUB_AGENT_TOOL_DENYLIST instanceof Set ? SUB_AGENT_TOOL_DENYLIST : new Set(SUB_AGENT_TOOL_DENYLIST);
  const missing = MANAGE_TOOLS.filter((t) => !set.has(t));
  record("denylist", missing.length === 0,
    missing.length === 0 ? `all 8 manage tools ∈ SUB_AGENT_TOOL_DENYLIST (never delegatable); |denylist|=${set.size}` : `missing=[${missing}]`);
}

const which = (process.argv[2] || "all").toLowerCase();
const run = { guard: probeGuard, origin: probeOrigin, audit: probeAudit, adminset: probeAdminset, denylist: probeDenylist };
try {
  if (which === "all") { for (const f of Object.values(run)) await f(); }
  else if (run[which]) { await run[which](); }
  else { console.error(`unknown probe '${which}' — use: guard | origin | audit | adminset | denylist | all`); process.exit(2); }
} catch (e) { console.error(`admin-origin-probe error (SRC=${SRC}): ${e.message}\n${e.stack}`); process.exit(2); }
const failed = results.filter((r) => !r.pass);
console.log(`\n${failed.length ? `❌ ${failed.length} oracle(s) FAILED` : `✅ all ${results.length} oracle(s) PASS`} (SRC=${SRC})`);
process.exit(failed.length ? 1 : 0);
