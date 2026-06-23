// SPDX-License-Identifier: Apache-2.0
/**
 * ORIGIN-01 + ORIGIN-03 deny-by-origin chokepoint architecture invariants
 * (v8 §3.1 / §22.3 floor item 1).
 *
 * ORIGIN-01 (one chokepoint, full admin set, no scatter):
 *   1. The deny-by-origin chokepoint EXISTS in `rpc-dispatch.ts` — it derives
 *      its admin-method set from `API_CONTRACTS_ORDERED` filtered on
 *      `scopes.includes("admin")` AND calls `assertNotAgentOrigin`. The check
 *      is keyed on the admin-scope Set, NOT a hardcoded handful of methods.
 *   2. Completeness — the chokepoint's derivation matches the FULL
 *      registry-derived admin set (so every admin method is covered by the one
 *      check, not a subset).
 *   3. No scatter — NO `packages/daemon/src/api/*-handlers.ts` file contains
 *      `assertNotAgentOrigin` (single-chokepoint invariant: guards against a
 *      future half-migration that adds BOTH a chokepoint AND per-handler calls).
 *
 * ORIGIN-03 (sole `_agentId` injector):
 *   The ONLY daemon production site that injects `_agentId:` into an
 *   `rpcCall(...)` params object is `createAgentRpcCall` in
 *   `wiring/setup-tools.ts` (a one-entry allowlist pinned by file path).
 *
 * Soundness chain (documented for the next reader): Plan 03 strips external
 * `_agentId` at the gateway boundary, so at the dispatch seam `_agentId`
 * PRESENCE == agent-origin; this chokepoint then denies it for EVERY admin
 * method → no agent-origin call reaches an admin handler. Residual: a NEW
 * control-plane method that forgets to declare `scopes:["admin"]` would not be
 * caught — that is a contract-authoring concern guarded by the existing
 * scope-declaration review, NOT this test.
 *
 * Walker design mirrors `api-contracts-bidirectional.test.ts`
 * (`ts.createSourceFile(..., ES2023, true)` + `listHandlerFiles`).
 * @module
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { API_CONTRACTS_ORDERED, HANDLER_CAPABILITY_MAP, AGENT_CAPABILITIES } from "@comis/core";
import { formatViolations, type ViolationCitation } from "../support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const HANDLER_DIR = resolve(REPO_ROOT, "packages/daemon/src/api");
const RPC_DISPATCH = resolve(HANDLER_DIR, "rpc-dispatch.ts");
const WIRING_DIR = resolve(REPO_ROOT, "packages/daemon/src/wiring");

/** The full admin-scoped method set, derived the SAME way the chokepoint must. */
const EXPECTED_ADMIN: ReadonlySet<string> = new Set(
  API_CONTRACTS_ORDERED.filter((c) => c.scopes.includes("admin")).map((c) => c.method),
);

/**
 * Recursive `*-handlers.ts` walker (copied shape from
 * `api-contracts-bidirectional.test.ts`). Returns paths relative to
 * `HANDLER_DIR`. Descends only into `*-handlers/` subdirs; SKIPS `shared/`
 * (the chokepoint's `assertNotAgentOrigin` helper lives there — it is the
 * single source, not a per-handler scatter).
 */
function listHandlerFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const relPath = prefix ? `${prefix}/${ent.name}` : ent.name;
    const full = resolve(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "__snapshots__" || ent.name === "shared") continue;
      if (ent.name.endsWith("-handlers")) {
        out.push(...listHandlerFiles(full, relPath));
      }
    } else if (
      ent.isFile() &&
      ent.name.endsWith(".ts") &&
      !ent.name.endsWith(".test.ts") &&
      !ent.name.endsWith(".parity.test.ts")
    ) {
      if (prefix) {
        out.push(relPath);
      } else if (ent.name.endsWith("-handlers.ts")) {
        out.push(relPath);
      }
    }
  }
  return out;
}

/** Recursively list every non-test `.ts` under `dir` (absolute paths). */
function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const full = resolve(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "__snapshots__" || ent.name === "__tests__") continue;
      out.push(...listTsFiles(full));
    } else if (ent.isFile() && ent.name.endsWith(".ts") && !ent.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** 1-based line number of a node's start within `sf`. */
function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

describe("ORIGIN-01 — single deny-by-origin chokepoint in createRpcDispatch", () => {
  it("ORIGIN-01-A1: rpc-dispatch.ts derives the admin set from API_CONTRACTS_ORDERED (scopes.includes('admin')) AND calls assertNotAgentOrigin", () => {
    const src = readFileSync(RPC_DISPATCH, "utf8");
    const violations: ViolationCitation[] = [];

    const derivesAdminSet =
      /API_CONTRACTS_ORDERED/.test(src) && /scopes\.includes\(\s*["']admin["']\s*\)/.test(src);
    if (!derivesAdminSet) {
      violations.push({
        file: "packages/daemon/src/api/rpc-dispatch.ts",
        line: 0,
        snippet: "missing: ADMIN_METHODS derived from API_CONTRACTS_ORDERED.filter(c => c.scopes.includes('admin'))",
      });
    }
    // The chokepoint must actually CALL the guard (not merely import it).
    const callsGuard = /assertNotAgentOrigin\s*\(/.test(src);
    if (!callsGuard) {
      violations.push({
        file: "packages/daemon/src/api/rpc-dispatch.ts",
        line: 0,
        snippet: "missing: assertNotAgentOrigin(params, deps, method) call in the dispatch closure",
      });
    }

    expect(
      violations,
      formatViolations({
        description:
          "ORIGIN-01: the deny-by-origin chokepoint must exist in the createRpcDispatch dispatch closure, keyed on the registry-derived admin-scope Set.",
        violations,
        suggestedFix:
          "In rpc-dispatch.ts build `const ADMIN_METHODS = new Set(API_CONTRACTS_ORDERED.filter(c => c.scopes.includes('admin')).map(c => c.method))` and, in the dispatch closure, `if (ADMIN_METHODS.has(method)) assertNotAgentOrigin(params, deps, method)`.",
        designRef: "v8 ORIGIN-01 / §3.1 / §22.3 floor item 1",
      }),
    ).toEqual([]);
  });

  it("ORIGIN-01-A2: the chokepoint is gated on admin-Set membership (not a hardcoded handful of method names)", () => {
    const src = readFileSync(RPC_DISPATCH, "utf8");
    // Membership-keyed: an `ADMIN_METHODS.has(method)` (or equivalent Set
    // `.has(...)`) guards the assertNotAgentOrigin call — proving the deny set
    // is the WHOLE registry-derived admin set, not an inline method allowlist.
    const membershipKeyed = /\b[A-Z_]*ADMIN[A-Z_]*\s*\.\s*has\s*\(/.test(src);
    const violations: ViolationCitation[] = membershipKeyed
      ? []
      : [
          {
            file: "packages/daemon/src/api/rpc-dispatch.ts",
            line: 0,
            snippet: "the assertNotAgentOrigin call is not gated on an admin-method Set `.has(method)` membership test",
          },
        ];
    expect(
      violations,
      formatViolations({
        description:
          "ORIGIN-01: the chokepoint must fire for the FULL admin set via a Set membership test, never a hardcoded subset of method names.",
        violations,
        suggestedFix:
          "Gate the guard on `if (ADMIN_METHODS.has(method)) assertNotAgentOrigin(...)` where ADMIN_METHODS is the registry-derived admin set.",
        designRef: "v8 ORIGIN-01 / §3.1",
      }),
    ).toEqual([]);
  });

  it("ORIGIN-01-A3: the admin set is non-trivial (sanity: the registry actually declares admin-scoped methods)", () => {
    // A guard against a vacuous test: if the registry had zero admin methods,
    // the chokepoint would be a no-op and ORIGIN-01 would be silently empty.
    expect(EXPECTED_ADMIN.size).toBeGreaterThan(50);
  });

  it("ORIGIN-01-A4 (no scatter): NO *-handlers.ts file contains assertNotAgentOrigin (single chokepoint, not per-handler)", () => {
    const files = listHandlerFiles(HANDLER_DIR);
    const violations: ViolationCitation[] = [];
    for (const rel of files) {
      const src = readFileSync(resolve(HANDLER_DIR, rel), "utf8");
      if (src.includes("assertNotAgentOrigin")) {
        const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.ES2023, true);
        let line = 0;
        const visit = (n: ts.Node): void => {
          if (line) return;
          if (ts.isIdentifier(n) && n.text === "assertNotAgentOrigin") {
            line = lineOf(sf, n);
            return;
          }
          ts.forEachChild(n, visit);
        };
        ts.forEachChild(sf, visit);
        violations.push({ file: `packages/daemon/src/api/${rel}`, line });
      }
    }
    expect(
      violations,
      formatViolations({
        description:
          "ORIGIN-01: deny-by-origin must be ONE chokepoint in rpc-dispatch.ts — no per-handler assertNotAgentOrigin scatter (a half-migration adding both is a coverage-drift hazard).",
        violations,
        suggestedFix:
          "Remove the per-handler assertNotAgentOrigin call. The single chokepoint in rpc-dispatch.ts covers every admin-scoped method via ADMIN_METHODS.",
        designRef: "v8 ORIGIN-01 / T-210-24",
      }),
    ).toEqual([]);
  });
});

describe("210-GAP — the deny-by-origin set is the TRUE control plane (orch/agent-reachable methods are NOT denied)", () => {
  /** The runtime admin-method set the chokepoint derives (scopes.includes("admin")). */
  const ADMIN: ReadonlySet<string> = EXPECTED_ADMIN;
  const CAP_SET: ReadonlySet<string> = new Set<string>(AGENT_CAPABILITIES);

  it("210-GAP CR-01/MD-01: NO method classified gated (orch:*) or ungated in HANDLER_CAPABILITY_MAP is in the deny-by-origin (admin) set", () => {
    // The keystone reconciliation: a method the capability model OWNS (a held cap
    // gates it) or an agent-self read (ungated) MUST be agent-reachable — i.e.
    // NOT in the admin deny set, else deny-by-origin throws before the cap gate /
    // before the read runs. This is exactly the CR-01 regression (message.send /
    // skills.* / session.list were scopes:["admin"] while the gate/read expected
    // them reachable). Drift-proof: re-scoping any of them back to admin fails here.
    const violations: ViolationCitation[] = Object.entries(HANDLER_CAPABILITY_MAP)
      .filter(([, cls]) => CAP_SET.has(cls) || cls === "ungated")
      .filter(([method]) => ADMIN.has(method))
      .map(([method, cls]) => ({
        file: "packages/core/src/api-contracts/ (contract scope) + handler-capability-map.ts",
        line: 0,
        snippet: `"${method}" is classified "${cls}" (agent-reachable) but is scopes:["admin"] → in the deny-by-origin set → an agent origin is denied BEFORE the gate/read. Re-scope its contract to ["rpc"].`,
      }));
    expect(
      violations,
      formatViolations({
        description:
          "A capability-gated or agent-read orchestration method is in the deny-by-origin (admin) set, so an agent origin is denied before its own cap gate / self-read can run (the CR-01/MD-01 regression).",
        violations,
        suggestedFix:
          "Re-scope the method's contract scopes admin→rpc. The deny-by-origin set must be the TRUE control plane (secrets/tokens/config/agents/mcp/auth + the message §3.5 admin subset + arbitrary-session lifecycle), never the orchestration surface the capability model governs.",
        designRef: "210-GAP CR-01/MD-01 / v8 §3.1 (in-process bypass) / §3.5",
      }),
    ).toEqual([]);
  });

  it("210-GAP: every method classified deny-by-origin in HANDLER_CAPABILITY_MAP IS in the admin deny set (kept control plane)", () => {
    // The inverse drift guard: a method the map declares control-plane-only
    // (message.edit/delete/fetch/attach per §3.5; session.delete/export/
    // reset_conversation per the in-handler admin check) MUST keep scopes:["admin"]
    // so the chokepoint actually denies an agent origin. Dropping its admin scope
    // would silently open it to agents.
    const violations: ViolationCitation[] = Object.entries(HANDLER_CAPABILITY_MAP)
      .filter(([, cls]) => cls === "deny-by-origin")
      .filter(([method]) => !ADMIN.has(method))
      .map(([method]) => ({
        file: "packages/core/src/api-contracts/ (contract scope) + handler-capability-map.ts",
        line: 0,
        snippet: `"${method}" is classified "deny-by-origin" but is NOT scopes:["admin"] → the chokepoint does NOT cover it → an agent origin could reach it.`,
      }));
    expect(
      violations,
      formatViolations({
        description:
          "A deny-by-origin-classified method lost its admin scope, so the chokepoint no longer denies an agent origin (a silent privilege widening).",
        violations,
        suggestedFix:
          "Keep the method's contract scopes as [\"admin\"] so it stays in the deny-by-origin set covered by the chokepoint.",
        designRef: "210-GAP / v8 §3.1 / §3.5",
      }),
    ).toEqual([]);
  });

  it("210-GAP (non-vacuity): the deny-by-origin class is populated AND the agent-reachable class is populated", () => {
    // Guard against a vacuous pass if the map were emptied/restructured.
    const denyByOrigin = Object.values(HANDLER_CAPABILITY_MAP).filter((c) => c === "deny-by-origin");
    const reachable = Object.values(HANDLER_CAPABILITY_MAP).filter(
      (c) => CAP_SET.has(c) || c === "ungated",
    );
    expect(denyByOrigin.length, "deny-by-origin class must be non-empty (210-GAP populated it)").toBeGreaterThan(0);
    expect(reachable.length, "agent-reachable class must be non-empty").toBeGreaterThan(0);
  });
});

describe("ORIGIN-03 — the sole legitimate _agentId injector reaches no admin handler", () => {
  it("ORIGIN-03-A1: the ONLY daemon production site injecting `_agentId:` into an rpcCall(...) params object is wiring/setup-tools-capabilities.ts (createAgentRpcCall)", () => {
    // Walk daemon/wiring/*.ts (the in-process dispatch wiring) and find every
    // `_agentId:` PropertyAssignment whose enclosing CallExpression is
    // `rpcCall(...)` — i.e. a fresh agent-origin injection into a dispatched
    // params object. (Parameter-type decls like `_agentId: string,` and
    // within-handler forwards of an already-present `params._agentId` are NOT
    // injections and must not match. The web client injects `_agentId` into
    // its OWN external requests, which the ORIGIN-02 gateway strip removes
    // before dispatch — that is a different package + an external origin.)
    const injectorFiles = new Set<string>();
    const sites: ViolationCitation[] = [];

    for (const file of listTsFiles(WIRING_DIR)) {
      const src = readFileSync(file, "utf8");
      if (!src.includes("_agentId")) continue;
      const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ES2023, true);

      const visit = (n: ts.Node, inRpcCallArg: boolean): void => {
        let nowInRpcCallArg = inRpcCallArg;
        if (
          ts.isCallExpression(n) &&
          ts.isIdentifier(n.expression) &&
          n.expression.text === "rpcCall"
        ) {
          // Descend into the arguments with the rpcCall-arg flag set.
          for (const arg of n.arguments) visit(arg, true);
          // The callee identifier itself is not an arg; stop here for this node.
          return;
        }
        if (
          ts.isPropertyAssignment(n) &&
          ts.isIdentifier(n.name) &&
          n.name.text === "_agentId" &&
          inRpcCallArg
        ) {
          injectorFiles.add(file);
          sites.push({ file: file.replace(REPO_ROOT + "/", ""), line: lineOf(sf, n) });
        }
        ts.forEachChild(n, (c) => visit(c, nowInRpcCallArg));
      };
      ts.forEachChild(sf, (c) => visit(c, false));
    }

    // Soundness: there must be AT LEAST one injector (otherwise the agent loop
    // has no origin signal at all — a vacuous pass), and it must be EXACTLY the
    // pinned createAgentRpcCall file.
    expect(injectorFiles.size, `injector sites found:\n${sites.map((s) => `  ${s.file}:${s.line}`).join("\n")}`).toBeGreaterThan(0);

    // The legitimate _agentId injectors (both audited, both routing through the
    // SAME createRpcDispatch deny-by-origin chokepoint):
    //   1. createAgentRpcCall (wiring/setup-tools-capabilities.ts) — the in-process
    //      agent path; extracted from setup-tools.ts for the file-size cap.
    //   2. createCapabilityEndpoint (wiring/setup-capability-endpoint.ts, Phase 211
    //      ENDPOINT-01/02) — the loopback capability endpoint. It injects
    //      `_agentId: lease.agentId` (after a successful lease validate) PRECISELY
    //      so the shipped assertNotAgentOrigin chokepoint denies admin methods by
    //      origin (RESEARCH Pitfall 2). internals.ts:27-30 names "the 211 lease
    //      endpoint" as a legitimate injector. Both inject ONLY after their own
    //      origin authentication (resolveAutonomy / lease validate), so neither
    //      creates an un-audited agent-origin path.
    const expectedInjectors = new Set([
      resolve(WIRING_DIR, "setup-tools-capabilities.ts"),
      resolve(WIRING_DIR, "setup-capability-endpoint.ts"),
    ]);
    const unexpected = [...injectorFiles].filter((f) => !expectedInjectors.has(f));
    const violations: ViolationCitation[] = unexpected.map((f) => ({
      file: f.replace(REPO_ROOT + "/", ""),
      line: sites.find((s) => resolve(REPO_ROOT, s.file) === f)?.line ?? 0,
    }));
    expect(
      violations,
      formatViolations({
        description:
          "ORIGIN-03: the ONLY legitimate _agentId injectors into an rpcCall(...) are createAgentRpcCall (setup-tools-capabilities.ts) and createCapabilityEndpoint (setup-capability-endpoint.ts, Phase 211). A new injector site would create an un-audited agent-origin path; route the call through one of those instead.",
        violations,
        suggestedFix:
          "Inject _agentId only via createAgentRpcCall or createCapabilityEndpoint. Any other in-process rpcCall must not set _agentId.",
        designRef: "v8 ORIGIN-03 / §3.1 / Phase 211 ENDPOINT-02",
      }),
    ).toEqual([]);

    // Pin the expectation explicitly: exactly the two audited injector files.
    expect([...injectorFiles].map((f) => f.replace(REPO_ROOT + "/", "")).sort()).toEqual([
      "packages/daemon/src/wiring/setup-capability-endpoint.ts",
      "packages/daemon/src/wiring/setup-tools-capabilities.ts",
    ]);
  });
});
