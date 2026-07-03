// SPDX-License-Identifier: Apache-2.0
/**
 * Module-global AST gate for the OAuth browser-callback server.
 *
 * The loopback OAuth callback server (`oauth/browser-callback.ts`) MUST hold
 * ALL of its state — `node:http` server handle, the kernel-assigned port, the
 * CSRF `state`, the PKCE `code_verifier`, the resolve/reject, the timeout
 * timer — in function-local / closure scope. ZERO module-scope `let`/`var`.
 *
 * Why this is a dedicated gate: keeping the callback port in a MODULE-GLOBAL
 * (e.g. a shared `_oauth_port`) is a known OAuth-manager footgun. Two concurrent
 * `oauth_login` flows then share that one variable — the second flow's
 * `listen()` overwrites the port before the first flow reads it back, a
 * time-of-check/time-of-use bug that mis-routes (or hijacks) the first flow's
 * authorization code. Mutable module scope is the root cause; this gate forbids
 * it AST-structurally on exactly the one file where the loopback server lives,
 * so a future refactor that "hoists" a port/state var to module scope fails the
 * build with a line number.
 *
 * Mechanics mirror the `contract-handler-parity.test.ts` and the project-wide
 * `globals.test.ts` AST gates: the TypeScript compiler API
 * (`ts.createSourceFile` → `ts.forEachChild` over TOP-LEVEL statements only),
 * NOT ts-morph. A top-level `VariableStatement` whose `declarationList.flags`
 * lacks `NodeFlags.Const` is a `let` (flags has `NodeFlags.Let`) or a `var`
 * (flags has neither) — both are violations. `const` (flags has
 * `NodeFlags.Const`) is allowed: module-level `const CALLBACK_TIMEOUT_MS =
 * 300_000` and `const`-bound arrow helpers are immutable bindings and pose no
 * TOCTOU risk.
 *
 * The gate is SELF-VALIDATING: an inline fixture proves the
 * `NodeFlags.Const` discrimination catches a deliberate `let`/`var` and passes
 * a `const`, so a compiler-API change that silently broke the check would fail
 * the fixture before it could give the real file a false pass.
 *
 * Auto-discovered by the `test/architecture` vitest project
 * (`vitest.config.ts` `projects: [..., "test/architecture", ...]`).
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

/**
 * The ONE file this gate targets — a single named file, not a directory glob.
 * Widening this is a deliberate decision, not an accident.
 */
const TARGET = resolve(
  REPO_ROOT,
  "packages/skills/src/skills/integrations/mcp-client/oauth/browser-callback.ts",
);

/**
 * Walk TOP-LEVEL statements of `src` and return one violation message per
 * module-scope `let`/`var` `VariableStatement` (a `const` is skipped). The
 * `flags & NodeFlags.Const` discrimination is the load-bearing line: `let` sets
 * `NodeFlags.Let`, `var` sets neither — only `const` sets `NodeFlags.Const`.
 *
 * `ts.forEachChild(sf, ...)` visits ONLY the source file's direct children
 * (top-level statements) — declarations nested inside a function body or a
 * Promise executor are intentionally NOT visited, because closure-local
 * `let`/`var` is exactly what we want callback state to be.
 */
function findModuleScopeLetVar(fileName: string, src: string): string[] {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.ES2023, true);
  const violations: string[] = [];
  ts.forEachChild(sf, (node) => {
    if (!ts.isVariableStatement(node)) return;
    const isConst = (node.declarationList.flags & ts.NodeFlags.Const) !== 0;
    if (isConst) return;
    const keyword =
      (node.declarationList.flags & ts.NodeFlags.Let) !== 0 ? "let" : "var";
    const line =
      sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    violations.push(`module-scope ${keyword} at line ${line}`);
  });
  return violations;
}

describe("no module-scope let/var in oauth/browser-callback.ts", () => {
  it("self-validates: the AST walker flags a top-level let/var and passes a const", () => {
    // A top-level `let` and a top-level `var` are violations; the `const`
    // (including a const-bound arrow function) is not. This proves the
    // NodeFlags.Const discrimination before we trust the real-file assertion.
    const fixture = [
      "const CALLBACK_TIMEOUT_MS = 300_000;",
      "const helper = (x: number) => x + 1;",
      "let modulePort = 0;",
      "var legacyState = '';",
      "export const ok = 1;",
    ].join("\n");
    const violations = findModuleScopeLetVar("fixture.ts", fixture);
    expect(violations).toEqual([
      "module-scope let at line 3",
      "module-scope var at line 4",
    ]);

    // And a closure-local let/var inside a function body is NOT flagged
    // (top-level-only walk) — the whole point of the closure-scoping rule.
    const closureFixture = [
      "const run = () => {",
      "  let port = 0;",
      "  var s = '';",
      "  return port + Number(s);",
      "};",
    ].join("\n");
    expect(findModuleScopeLetVar("closure.ts", closureFixture)).toEqual([]);
  });

  it("browser-callback.ts has ZERO module-scope let/var", () => {
    const src = readFileSync(TARGET, "utf8");
    const violations = findModuleScopeLetVar(TARGET, src);
    expect(violations, violations.join("\n")).toEqual([]);
  });
});
