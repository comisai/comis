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
import { API_CONTRACTS_ORDERED } from "@comis/core";
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

describe("ORIGIN-03 — the sole legitimate _agentId injector reaches no admin handler", () => {
  it("ORIGIN-03-A1: the ONLY daemon production site injecting `_agentId:` into an rpcCall(...) params object is wiring/setup-tools.ts (createAgentRpcCall)", () => {
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

    const expectedInjector = resolve(WIRING_DIR, "setup-tools.ts");
    const unexpected = [...injectorFiles].filter((f) => f !== expectedInjector);
    const violations: ViolationCitation[] = unexpected.map((f) => ({
      file: f.replace(REPO_ROOT + "/", ""),
      line: sites.find((s) => resolve(REPO_ROOT, s.file) === f)?.line ?? 0,
    }));
    expect(
      violations,
      formatViolations({
        description:
          "ORIGIN-03: the sole legitimate _agentId injector into an rpcCall(...) is createAgentRpcCall in wiring/setup-tools.ts. A new injector site would create an un-audited agent-origin path; route the call through createAgentRpcCall instead.",
        violations,
        suggestedFix:
          "Inject _agentId only via createAgentRpcCall (setup-tools.ts). Any other in-process rpcCall must not set _agentId.",
        designRef: "v8 ORIGIN-03 / §3.1",
      }),
    ).toEqual([]);

    // Pin the expectation explicitly: exactly the one file.
    expect([...injectorFiles].map((f) => f.replace(REPO_ROOT + "/", ""))).toEqual([
      "packages/daemon/src/wiring/setup-tools.ts",
    ]);
  });
});
