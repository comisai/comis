// SPDX-License-Identifier: Apache-2.0
/**
 * ORIGIN-02 — the external WS/REST boundary strips INTERNAL_FIELD_NAMES.
 *
 * `packages/daemon/src/wiring/setup-gateway-api.ts` is the single registration
 * loop that wires every API contract method onto the gateway's dynamic router.
 * It is THE external untrusted boundary: any `_X` control field a WS/REST caller
 * sends is forged and must be projected away (via `stripInternalFields()`) before
 * dispatch — and on the admin branch BEFORE re-injecting the trusted
 * `_trustLevel`. After that strip, the PRESENCE of `_agentId`/`_capabilities` in
 * params is an unforgeable agent-origin signal, which is the security
 * prerequisite that makes deny-by-origin sound (v8 ORIGIN-02 / section 3.1).
 *
 * This is an ARCHITECTURE-tier guard (a cross-cutting trust-boundary invariant)
 * placed in test/architecture/ so the full-workspace gate catches it — per-package
 * runs hide cross-cutting gates (the feedback_full_workspace_gates_per_phase note).
 *
 * LOAD-BEARING (proven RED-first against pre-patch code, which spread
 * `{ ...(params ?? {}), _trustLevel: "admin" }` and passed `params ?? {}`
 * unstripped): if EITHER registration branch stops wrapping caller params in
 * `stripInternalFields`, both the AST assertion and the negative source-text
 * assertion FAIL — proving this is not a tautology and a future refactor cannot
 * silently reintroduce the unstripped spread (threat T-210-11).
 *
 * Mechanism: AST walk via `ts.createSourceFile` (the established arch-test
 * idiom — `api-contracts-bidirectional.test.ts`). The file has exactly two
 * `registerMethod` call sites (admin + rpc); for each we assert the registered
 * async-arrow body forwards caller params through a `CallExpression` to
 * `stripInternalFields` (not a bare spread / bare pass-through). A complementary
 * comment-stripped source-text assertion pins the strip-then-inject ordering on
 * the admin branch and the absence of the old unstripped spread.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { formatViolations, type ViolationCitation } from "../support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const SETUP_GATEWAY_API_TS = resolve(
  REPO_ROOT,
  "packages/daemon/src/wiring/setup-gateway-api.ts",
);
const REL = "packages/daemon/src/wiring/setup-gateway-api.ts";

const DESIGN_REF = "v8 ORIGIN-02 / section 3.1";
const SUGGESTED_FIX =
  "Wrap external caller params in stripInternalFields() at BOTH registerMethod " +
  "branches, with any server-trusted field (_trustLevel, the CAP-03 _capabilities " +
  "injection `...capInject`) spread AFTER the strip: admin → " +
  "`{ ...stripInternalFields(params ?? {}), _trustLevel: \"admin\", ...capInject }`, " +
  "rpc → `{ ...stripInternalFields(params ?? {}), ...capInject }` (strip-THEN-inject).";

/**
 * Strip line + block comments so a token inside a comment cannot satisfy an
 * assertion (a comment naming stripInternalFields is NOT the wiring).
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .split(/\r?\n/)
    .map((l) => {
      const t = l.trim();
      return t.startsWith("//") || t.startsWith("*") ? "" : l;
    })
    .join("\n");
}

/** True iff `node`'s subtree contains a CallExpression to `stripInternalFields(...)`. */
function subtreeCallsStripInternalFields(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "stripInternalFields"
    ) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/**
 * Walk the source AST and return the line numbers of every
 * `dynamicRouter.registerMethod(<method>, <scope>, <async-arrow>)` call site
 * whose registered handler arrow does NOT forward params through
 * `stripInternalFields`. The handler arrow is the 3rd argument; we recurse the
 * whole file so the call inside the nested for/for loop is found.
 */
function findUnstrippedRegistrations(
  sf: ts.SourceFile,
): ViolationCitation[] {
  const violations: ViolationCitation[] = [];
  let registerCallCount = 0;

  const visit = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "registerMethod"
    ) {
      registerCallCount += 1;
      const handlerArg = n.arguments[2];
      const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
      if (
        handlerArg === undefined ||
        !(ts.isArrowFunction(handlerArg) || ts.isFunctionExpression(handlerArg))
      ) {
        violations.push({
          file: REL,
          line: line + 1,
          snippet: "registerMethod handler is not an inline arrow/function — cannot verify the strip",
        });
      } else if (!subtreeCallsStripInternalFields(handlerArg.body)) {
        violations.push({
          file: REL,
          line: line + 1,
          snippet: "registerMethod handler forwards caller params WITHOUT stripInternalFields()",
        });
      }
    }
    ts.forEachChild(n, visit);
  };

  visit(sf);

  // Defensive: the file must register through this loop (>=2 sites today: admin
  // + rpc). If the walker found none, the file shape changed out from under the
  // guard — fail loudly rather than pass vacuously.
  if (registerCallCount < 2) {
    violations.push({
      file: REL,
      line: 0,
      snippet: `expected >= 2 registerMethod call sites (admin + rpc); found ${registerCallCount}`,
    });
  }

  return violations;
}

describe("ORIGIN-02 — setup-gateway-api strips internal fields at the external boundary", () => {
  it("imports stripInternalFields from @comis/core", () => {
    const code = stripComments(readFileSync(SETUP_GATEWAY_API_TS, "utf8"));
    expect(code).toMatch(
      /import\s*\{[^}]*stripInternalFields[^}]*\}\s*from\s*["']@comis\/core["']/,
    );
  });

  it("BOTH registerMethod branches forward caller params through stripInternalFields() (AST)", () => {
    const src = readFileSync(SETUP_GATEWAY_API_TS, "utf8");
    const sf = ts.createSourceFile(
      SETUP_GATEWAY_API_TS,
      src,
      ts.ScriptTarget.ES2023,
      true,
    );
    const violations = findUnstrippedRegistrations(sf);
    expect(
      violations,
      formatViolations({
        description:
          "Every registerMethod handler in setup-gateway-api.ts must forward external " +
          "caller params through stripInternalFields() before dispatch (so a forged " +
          "_agentId/_capabilities cannot reach the handler).",
        violations,
        suggestedFix: SUGGESTED_FIX,
        designRef: DESIGN_REF,
      }),
    ).toEqual([]);
  });

  it("admin branch strips THEN injects the trusted _trustLevel (ordering), and the old unstripped spread is gone", () => {
    const code = stripComments(readFileSync(SETUP_GATEWAY_API_TS, "utf8"));
    // Strip-then-inject ordering: stripInternalFields(params) immediately
    // precedes the _trustLevel:"admin" re-injection.
    expect(code).toMatch(
      /stripInternalFields\(params \?\? \{\}\),\s*_trustLevel:\s*["']admin["']/,
    );
    // The rpc branch strips FIRST, then spreads the CAP-03 server-side cap
    // injection (...capInject) AFTER (#240) — so a forged client `_capabilities`
    // is stripped before the trusted one is added (strip-THEN-inject).
    expect(code).toMatch(
      /rpcCall\(\s*c\.method,\s*\{\s*\.\.\.stripInternalFields\(params \?\? \{\}\),\s*\.\.\.capInject\s*\}\s*\)/,
    );
    // The pre-patch unstripped admin spread must NOT survive anywhere.
    expect(code).not.toMatch(/\{\s*\.\.\.\(params \?\? \{\}\),\s*_trustLevel/);
  });
});
