// SPDX-License-Identifier: Apache-2.0
/**
 * Every capability-gated orchestration
 * handler ACTUALLY calls `requireCapability`, and the registry-derived
 * orchestration-mutating surface is fully classified in HANDLER_CAPABILITY_MAP.
 *
 * The in-process bypass: the agent loop reaches RPC handlers WITHOUT
 * passing `checkScope`, so the capability gate lives IN the handler, reading the
 * injected `_capabilities`. A handler that is classified to an `AgentCapability`
 * in `HANDLER_CAPABILITY_MAP` but forgets the `requireCapability(...)` call is a
 * silent privilege-widening hole — this test fails the build on that.
 *
 * TWO assertions (the two halves of the "added later without a gate" gap):
 *
 *   (a) MAPPED-AND-GATED. AST-walk every `packages/daemon/src/api/*-handlers.ts`
 *       file (and the `*-handlers/` subdir leaves — `graph-handlers/`,
 *       `session-handlers/`), resolve each computed-key `[<Contract>.method]:`
 *       handler to its registry method name, and for every method whose
 *       HANDLER_CAPABILITY_MAP value is an `AgentCapability`, assert the arrow
 *       body contains a `requireCapability(..., "<cap>")` CallExpression whose
 *       SECOND argument is the exact mapped cap string literal. A mapped handler
 *       with no matching call (or a wrong-cap call) is a violation.
 *
 *   (b) COMPLETENESS. Derive the orchestration-MUTATING method set from
 *       `API_CONTRACTS_ORDERED` — methods in the {session, graph, cron, message,
 *       skills} namespaces whose verb is in an explicit mutating-verb set (NOT
 *       every method in those namespaces, so read-only views are excluded) — and
 *       assert EACH is present as a KEY in HANDLER_CAPABILITY_MAP. This closes
 *       the "a new mutating orchestration method is never added to the map" gap:
 *       a new such method forces a map entry (the gated-vs-ungated decision),
 *       which assertion (a) then forces a `requireCapability` gate on if it is
 *       classified as a cap.
 *
 * RESIDUAL BOUNDARY (documented, not auto-caught): assertion (b) catches a new
 * mutating method in an EXISTING gated namespace ({session,graph,cron,message,
 * skills}). A BRAND-NEW orchestration NAMESPACE (e.g. a future `workflow.*`)
 * still needs a human to extend `ORCHESTRATION_NAMESPACES` below — there is no
 * way to derive "is this namespace orchestration?" from the registry alone, and
 * over-broadening the filter would wrongly demand caps on non-orchestration
 * namespaces. That extension is a deliberate review gate, not silent drift.
 *
 * Walker design mirrors `api-contracts-bidirectional.test.ts`
 * (`ts.createSourceFile(..., ES2023, true)` + `listHandlerFiles` +
 * `resolveContractMethodName`) and `admin-handlers-deny-by-origin.test.ts`.
 * It imports the COMPILED HANDLER_CAPABILITY_MAP / API_CONTRACTS_ORDERED /
 * AGENT_CAPABILITIES from `@comis/core` (dist) — the runtime closed sets, not
 * their AST — so a map/registry change flips this test, while the handler bodies
 * are read from `packages/daemon/src/api/` source.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { HANDLER_CAPABILITY_MAP, API_CONTRACTS_ORDERED, AGENT_CAPABILITIES } from "@comis/core";
import { formatViolations, type ViolationCitation } from "../support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const HANDLER_DIR = resolve(REPO_ROOT, "packages/daemon/src/api");
const CONTRACT_DIR = resolve(REPO_ROOT, "packages/core/src/api-contracts");

const DESIGN_REF = "every capability-gated orchestration handler calls requireCapability (the in-process bypass skips checkScope)";

/** The closed `orch:*` capability set, as a runtime Set (no typo'd-cap lookups). */
const CAP_SET: ReadonlySet<string> = new Set<string>(AGENT_CAPABILITIES);

/** True iff a HANDLER_CAPABILITY_MAP value is an `AgentCapability` (vs "ungated"/"deny-by-origin"). */
function isAgentCapability(value: string): boolean {
  return CAP_SET.has(value);
}

// ── (b) the orchestration-mutating namespace + verb filter ───────────────────
//
// HUMAN-MAINTAINED (see RESIDUAL BOUNDARY in the module doc): a brand-new
// orchestration namespace must be ADDED here. This is the one place the
// derivation is not registry-driven — by design, so adding `workflow` (say) is
// a reviewable one-line change, not a silent omission.
const ORCHESTRATION_NAMESPACES: ReadonlySet<string> = new Set([
  "session",
  "graph",
  "cron",
  "message",
  "skills",
]);

// The mutating/exec verbs within those namespaces (the trailing
// dot-delimited segment of `<namespace>.<verb>`). Read-only verbs
// (list/status/runs/outputs/fetch/history/search/run_status/...) are
// intentionally EXCLUDED so the completeness assertion targets only the
// mutating surface a cap must classify.
const MUTATING_VERBS: ReadonlySet<string> = new Set([
  "spawn",
  "define",
  "execute",
  "save",
  "load",
  "delete",
  "cancel",
  "add",
  "update",
  "remove",
  "run",
  "react",
  "edit",
  "attach",
  "send",
  "reply",
  "create",
  "import",
  "upload",
]);

/** Split `<namespace>.<verb...>` → its leading namespace + trailing verb segment. */
function namespaceVerb(method: string): { namespace: string; verb: string } {
  const dot = method.indexOf(".");
  if (dot < 0) return { namespace: method, verb: "" };
  return { namespace: method.slice(0, dot), verb: method.slice(dot + 1) };
}

/**
 * Recursive `*-handlers.ts` walker — copied shape from
 * `api-contracts-bidirectional.test.ts` / `admin-handlers-deny-by-origin.test.ts`.
 * Returns paths relative to `HANDLER_DIR`. Descends only into `*-handlers/`
 * subdirs; skips `shared/` and `__snapshots__/`.
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

/** Recursively enumerate every non-test contract `.ts` under `CONTRACT_DIR`. */
function listContractFiles(dir: string): string[] {
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
      if (ent.name === "__snapshots__") continue;
      out.push(...listContractFiles(full));
    } else if (ent.isFile() && ent.name.endsWith(".ts") && !ent.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Resolve `export const <ContractName> = defineContract({ method: "..." })`
 * across `packages/core/src/api-contracts/` (recursive). Returns the matched
 * method literal or `undefined`. Memoized across calls (the contract tree is
 * stable for the test run).
 */
const CONTRACT_METHOD_CACHE = new Map<string, string | undefined>();
function resolveContractMethodName(contractName: string): string | undefined {
  if (CONTRACT_METHOD_CACHE.has(contractName)) return CONTRACT_METHOD_CACHE.get(contractName);
  let resolved: string | undefined;
  for (const file of listContractFiles(CONTRACT_DIR)) {
    const src = readFileSync(file, "utf8");
    const pattern = new RegExp(
      `export const ${contractName}\\s*=\\s*defineContract\\s*\\(\\s*\\{[\\s\\S]*?method:\\s*["']([^"']+)["']`,
    );
    const m = src.match(pattern);
    if (m) {
      resolved = m[1];
      break;
    }
  }
  CONTRACT_METHOD_CACHE.set(contractName, resolved);
  return resolved;
}

/** 1-based line number of a node's start within `sf`. */
function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/**
 * True iff `body`'s subtree contains a CallExpression to
 * `requireCapability(<held>, "<expectedCap>")` whose SECOND argument is the
 * exact `expectedCap` string literal. We pin the second-argument literal so a
 * copy-pasted wrong-cap gate (e.g. `orch:cron` on a graph handler) does NOT
 * satisfy the assertion.
 */
function bodyGatesWithCap(body: ts.Node, expectedCap: string): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "requireCapability"
    ) {
      const secondArg = n.arguments[1];
      if (secondArg !== undefined && ts.isStringLiteral(secondArg) && secondArg.text === expectedCap) {
        found = true;
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  return found;
}

/**
 * A handler property-assignment located in a handler file: its resolved
 * registry method name + the arrow/function body to inspect for the gate.
 */
interface LocatedHandler {
  readonly method: string;
  readonly file: string; // repo-relative
  readonly line: number;
  readonly body: ts.Node;
}

/**
 * Collect every computed-key `[<Contract>.method]:` handler in one handler file,
 * resolving the contract symbol to its registry method name. Only computed-key
 * (migrated) handlers are returned — the gated orchestration handlers all use
 * computed keys, and resolving them through the registry is exactly how the
 * bidirectional test maps handlers to methods.
 */
function collectHandlers(relFile: string): LocatedHandler[] {
  const abs = resolve(HANDLER_DIR, relFile);
  const src = readFileSync(abs, "utf8");
  const sf = ts.createSourceFile(relFile, src, ts.ScriptTarget.ES2023, true);
  const out: LocatedHandler[] = [];
  const importedContractNames = new Set<string>();

  const visitTop = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings)
    ) {
      for (const spec of node.importClause.namedBindings.elements) {
        importedContractNames.add(spec.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };

  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAssignment(n) && ts.isComputedPropertyName(n.name)) {
      const expr = n.name.expression;
      if (
        ts.isPropertyAccessExpression(expr) &&
        expr.name.text === "method" &&
        ts.isIdentifier(expr.expression) &&
        importedContractNames.has(expr.expression.text)
      ) {
        const method = resolveContractMethodName(expr.expression.text);
        if (
          method !== undefined &&
          (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
        ) {
          out.push({
            method,
            file: `packages/daemon/src/api/${relFile}`,
            line: lineOf(sf, n),
            body: n.initializer.body,
          });
        }
      }
    }
    ts.forEachChild(n, visit);
  };

  ts.forEachChild(sf, visitTop);
  return out;
}

describe("every mapped orchestration handler calls requireCapability", () => {
  const handlerFiles = listHandlerFiles(HANDLER_DIR);
  const located: LocatedHandler[] = handlerFiles.flatMap(collectHandlers);
  const locatedByMethod = new Map<string, LocatedHandler>(located.map((h) => [h.method, h]));

  it("sanity: the AST walk located handler bodies for the gated orchestration methods", () => {
    // Guard against a vacuous pass: if the walker located zero handlers (file
    // shape changed out from under it), the per-cap assertion below would pass
    // empty. Require it found the cap-valued map entries.
    const gatedMethods = Object.entries(HANDLER_CAPABILITY_MAP)
      .filter(([, cap]) => isAgentCapability(cap))
      .map(([m]) => m);
    expect(gatedMethods.length, "HANDLER_CAPABILITY_MAP must classify at least one method as a cap").toBeGreaterThan(0);
    const missingLocate = gatedMethods.filter((m) => !locatedByMethod.has(m));
    expect(
      missingLocate,
      `the handler-file AST walk could not locate a handler body for these mapped (cap-valued) methods — the walker or file shape regressed:\n  ${missingLocate.join("\n  ")}`,
    ).toEqual([]);
  });

  it("(a) every AgentCapability-valued HANDLER_CAPABILITY_MAP method gates with requireCapability(..., '<that cap>')", () => {
    const violations: ViolationCitation[] = [];
    for (const [method, cap] of Object.entries(HANDLER_CAPABILITY_MAP)) {
      if (!isAgentCapability(cap)) continue; // ungated / deny-by-origin → no in-handler cap gate
      const handler = locatedByMethod.get(method);
      if (handler === undefined) {
        // Covered with a clearer message by the sanity test; record here too so
        // a single failing run names every gap.
        violations.push({
          file: "packages/daemon/src/api/",
          line: 0,
          snippet: `mapped method "${method}" (${cap}) has no locatable handler body to inspect`,
        });
        continue;
      }
      if (!bodyGatesWithCap(handler.body, cap)) {
        violations.push({
          file: handler.file,
          line: handler.line,
          snippet: `handler for "${method}" is classified "${cap}" in HANDLER_CAPABILITY_MAP but its body does not call requireCapability(..., "${cap}")`,
        });
      }
    }
    expect(
      violations,
      formatViolations({
        description:
          "Every orchestration method classified to an AgentCapability in HANDLER_CAPABILITY_MAP must call requireCapability(rawParams._capabilities, '<cap>') near the top of its handler (the in-process gate — the agent loop skips checkScope). A mapped-but-ungated handler is a silent privilege-widening hole.",
        violations,
        suggestedFix:
          "Add `requireCapability(rawParams._capabilities as string[] | undefined, \"<cap>\");` at the top of the handler (before stripInternalFields), using the cap HANDLER_CAPABILITY_MAP assigns to that method. Import requireCapability from @comis/core.",
        designRef: DESIGN_REF,
      }),
    ).toEqual([]);
  });

  it("(b) every orchestration-MUTATING method (derived from API_CONTRACTS_ORDERED) is a KEY in HANDLER_CAPABILITY_MAP (completeness)", () => {
    const derived = API_CONTRACTS_ORDERED.map((c) => c.method).filter((method) => {
      const { namespace, verb } = namespaceVerb(method);
      return ORCHESTRATION_NAMESPACES.has(namespace) && MUTATING_VERBS.has(verb);
    });

    // Non-vacuity: the registry must actually contain orchestration-mutating
    // methods — otherwise the completeness assertion is silently empty.
    expect(
      derived.length,
      "sanity: API_CONTRACTS_ORDERED must declare orchestration-mutating methods in the gated namespaces",
    ).toBeGreaterThan(0);

    const violations: ViolationCitation[] = derived
      .filter((method) => !Object.prototype.hasOwnProperty.call(HANDLER_CAPABILITY_MAP, method))
      .map((method) => ({
        file: "packages/core/src/security/handler-capability-map.ts",
        line: 0,
        snippet: `mutating orchestration method "${method}" (registry-derived) is NOT a key in HANDLER_CAPABILITY_MAP — classify it (gated cap or "ungated")`,
      }));

    expect(
      violations,
      formatViolations({
        description:
          "Every orchestration-mutating method (a {session,graph,cron,message,skills}-namespace method with a mutating verb, derived from API_CONTRACTS_ORDERED) MUST be a key in HANDLER_CAPABILITY_MAP. This forces a new mutating method in an existing gated namespace to be classified (gated-or-ungated) — assertion (a) then forces a requireCapability gate if it is a cap. RESIDUAL: a brand-new orchestration NAMESPACE still needs a human to add it to ORCHESTRATION_NAMESPACES in this test.",
        violations,
        suggestedFix:
          "Add the method as a key to HANDLER_CAPABILITY_MAP with its classification: a gated cap (\"orch:<family>\") for a mutating/outward method, or \"ungated\" for a read-only/lifecycle method. Gated entries then require the requireCapability gate (assertion a).",
        designRef: `${DESIGN_REF} (completeness)`,
      }),
    ).toEqual([]);
  });
});
