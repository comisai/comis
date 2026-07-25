// SPDX-License-Identifier: Apache-2.0
/**
 * The external WS/REST boundary strips INTERNAL_FIELD_NAMES.
 *
 * `packages/daemon/src/wiring/setup-gateway-api.ts` is the single registration
 * loop that wires every API contract method onto the gateway's dynamic router.
 * It is THE external untrusted boundary: any `_X` control field a WS/REST caller
 * sends is forged and must be projected away (via `stripInternalFields()`) before
 * dispatch — and on the admin branch BEFORE re-injecting the trusted
 * `_trustLevel`. After that strip, the PRESENCE of `_agentId`/`_capabilities` in
 * params is an unforgeable agent-origin signal, which is the security
 * prerequisite that makes deny-by-origin sound.
 *
 * This is an ARCHITECTURE-tier guard (a cross-cutting trust-boundary invariant)
 * placed in test/architecture/ so the full-workspace gate catches it — per-package
 * runs hide cross-cutting gates.
 *
 * LOAD-BEARING (proven RED-first against pre-patch code, which spread
 * `{ ...(params ?? {}), _trustLevel: "admin" }` and passed `params ?? {}`
 * unstripped): if EITHER registration branch stops wrapping caller params in
 * `stripInternalFields`, both the AST assertion and the negative source-text
 * assertion FAIL — proving this is not a tautology and a future refactor cannot
 * silently reintroduce the unstripped spread.
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

const DESIGN_REF = "the external boundary strips internal fields before dispatch";
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
 * whole file so the call inside the registration loop is found.
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

  // Defensive: the file must register through this loop. If the walker found
  // none, the file shape changed out from under the
  // guard — fail loudly rather than pass vacuously.
  if (registerCallCount < 1) {
    violations.push({
      file: REL,
      line: 0,
      snippet: `expected at least one registerMethod call site; found ${registerCallCount}`,
    });
  }

  return violations;
}

describe("setup-gateway-api strips internal fields at the external boundary", () => {
  it("imports stripInternalFields from @comis/core", () => {
    const code = stripComments(readFileSync(SETUP_GATEWAY_API_TS, "utf8"));
    expect(code).toMatch(
      /import\s*\{[^}]*stripInternalFields[^}]*\}\s*from\s*["']@comis\/core["']/,
    );
  });

  it("every registerMethod handler forwards caller params through stripInternalFields() (AST)", () => {
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

  it("the unified route strips before conditionally injecting server-owned authority", () => {
    const code = stripComments(readFileSync(SETUP_GATEWAY_API_TS, "utf8"));
    // Strip-then-inject ordering: the unified registration handles both scope
    // classes and conditionally adds trusted admin authority after stripping.
    expect(code).toMatch(
      /\.\.\.stripInternalFields\(params \?\? \{\}\),\s*\.\.\.\(adminOnly \|\| authenticatedAsAdmin \? \{ _trustLevel: ["']admin["'] \} : \{\}\),\s*\.\.\.capInject/,
    );
    expect(code).toMatch(/const adminOnly = c\.scopes\.length === 1 && c\.scopes\[0\] === ["']admin["']/);
    expect(code).toMatch(/checkScope\(context\.scopes, ["']admin["']\)/);
    // The pre-patch unstripped admin spread must NOT survive anywhere.
    expect(code).not.toMatch(/\{\s*\.\.\.\(params \?\? \{\}\),\s*_trustLevel/);
  });
});
