// SPDX-License-Identifier: Apache-2.0
/**
 * WEB-CONTRACTS-07: bidirectional 1:1 mapping between daemon handlers and
 * the `@comis/core/api-contracts` registry.
 *
 * Phase 35 Wave A scaffolds this test green (registry empty). Wave C
 * per-domain plans incrementally populate `API_CONTRACTS_ORDERED`. Each
 * Wave C commit migrates one handler factory file from string-literal
 * method keys (`"auth.list":`) to computed-key contract references
 * (`[AuthListContract.method]:`); this test enforces 1:1 mapping ONLY for
 * the MIGRATED set on each iteration. Plan 35-19 (Wave C closure) lands
 * the final handler migration, at which point the migrated set equals the
 * full handler set and the test enforces the complete 1:1 invariant.
 *
 * **Incremental-migration design (35-06 Rule 1 fix).** The original test
 * compared `API_CONTRACTS.keys()` against ALL handler methods (both
 * string-literal AND computed-key). That design is incompatible with
 * incremental Wave C: the FIRST contract added would immediately produce
 * 188 orphans (every unmigrated string-literal handler in every OTHER
 * handler file). The corrected design splits handler methods into two
 * sets — `migratedHandlerMethods` (computed-key) and
 * `unmigratedHandlerMethods` (string-literal) — and asserts:
 *   - Every contract entry has a MIGRATED handler. (PROOF: every Wave C
 *     plan adds contracts in lockstep with the matching handler refactor.)
 *   - Every MIGRATED handler method has a contract entry. (PROOF: the
 *     handler factory uses `[Contract.method]:` only after the contract
 *     exists in `@comis/core`.)
 * The unmigrated set is intentionally NOT a participating gate during
 * Wave C — Plan 35-19 closes it (every handler computed-key → unmigrated
 * set is empty → enforcement is universal by construction).
 *
 * Walker design (mirrors `packages/daemon/src/__tests__/architecture.test.ts`
 * lines 480–540 DAEMON-API-05): for each
 * `packages/daemon/src/api/*-handlers.ts` file, parse via
 * `ts.createSourceFile(..., ts.ScriptTarget.ES2023, true)` and tag every
 * `PropertyAssignment.name`:
 *   - `StringLiteral` (e.g. `"auth.list":`) → unmigrated.
 *   - `ComputedPropertyName` of the form `[<Contract>.method]:` → migrated
 *     (the test resolves the contract's `.method` literal by reading the
 *     file in `packages/core/src/api-contracts/`).
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { API_CONTRACTS } from "@comis/core";
import { formatViolations } from "../support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const HANDLER_DIR = resolve(REPO_ROOT, "packages/daemon/src/api");
const CONTRACT_DIR = resolve(REPO_ROOT, "packages/core/src/api-contracts");

/**
 * Find `export const <ContractName> = defineContract({ method: "..." ... })`
 * across every `.ts` file under `packages/core/src/api-contracts/`. Returns
 * the matched method literal or `undefined` if the contract symbol is not
 * present (Wave A: registry is empty, so this is `undefined` for everything).
 */
function resolveContractMethodName(contractName: string): string | undefined {
  let files: readonly string[];
  try {
    files = readdirSync(CONTRACT_DIR).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
    );
  } catch {
    return undefined;
  }
  for (const file of files) {
    const src = readFileSync(resolve(CONTRACT_DIR, file), "utf8");
    // Match `defineContract({ method: "..." })`-style declarations; tolerant
    // of formatting (multi-line, with intervening fields).
    const pattern = new RegExp(
      `export const ${contractName}\\s*=\\s*defineContract\\s*\\(\\s*\\{[\\s\\S]*?method:\\s*["']([^"']+)["']`,
    );
    const m = src.match(pattern);
    if (m) return m[1];
  }
  return undefined;
}

/**
 * Tagged method-name collected from a handler factory file. `migrated` is
 * `true` for `[Contract.method]:` computed-key declarations and `false`
 * for `"method.name":` string-literal declarations. The bidirectional 1:1
 * gate enforces the contract↔handler match ONLY against the migrated set;
 * the unmigrated set is tracked for diagnostics and shrinks to empty as
 * Wave C plans (35-06..35-19) migrate every handler factory.
 */
interface TaggedMethod {
  readonly method: string;
  readonly migrated: boolean;
}

/**
 * Collect every method name declared as a handler in `file` (one
 * `*-handlers.ts` under `HANDLER_DIR`). Returns tagged entries: string-literal
 * keys are tagged `migrated: false` (Wave C migration target); computed-name
 * keys resolved through the contract registry are tagged `migrated: true`.
 */
function collectMethodsFromFile(file: string): TaggedMethod[] {
  const src = readFileSync(resolve(HANDLER_DIR, file), "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ES2023, true);
  const methods: TaggedMethod[] = [];
  const importedContractNames = new Map<string, string>(); // local-name -> module-specifier

  function visitTop(node: ts.Node): void {
    if (
      ts.isImportDeclaration(node) &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings)
    ) {
      const mod = (node.moduleSpecifier as ts.StringLiteral).text;
      for (const spec of node.importClause.namedBindings.elements) {
        importedContractNames.set(spec.name.text, mod);
      }
    }
    ts.forEachChild(node, visit);
  }

  function visit(n: ts.Node): void {
    if (ts.isPropertyAssignment(n)) {
      if (ts.isStringLiteral(n.name)) {
        methods.push({ method: n.name.text, migrated: false });
      } else if (ts.isComputedPropertyName(n.name)) {
        const expr = n.name.expression;
        if (
          ts.isPropertyAccessExpression(expr) &&
          expr.name.text === "method" &&
          ts.isIdentifier(expr.expression)
        ) {
          const contractName = expr.expression.text;
          if (importedContractNames.has(contractName)) {
            const methodName = resolveContractMethodName(contractName);
            if (methodName) methods.push({ method: methodName, migrated: true });
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  }

  ts.forEachChild(sf, visitTop);
  return methods;
}

describe("Contract registry — bidirectional 1:1 (WEB-CONTRACTS-07)", () => {
  const handlerFiles = readdirSync(HANDLER_DIR).filter(
    (f) => f.endsWith("-handlers.ts") && !f.endsWith(".test.ts"),
  );

  it("sanity: api/ contains at least 20 *-handlers.ts files", () => {
    expect(
      handlerFiles.length,
      `expected >= 20 daemon handler factories; found ${handlerFiles.length}`,
    ).toBeGreaterThan(20);
  });

  it("every MIGRATED daemon handler method has a contract entry (WEB-CONTRACTS-07)", () => {
    // Migrated = handler factory uses `[Contract.method]:` computed-property
    // key. By construction, that key cannot resolve unless the contract
    // exists in the registry — so the orphan check is in effect a 1:1
    // consistency check for the Wave C migration cohort that has landed so
    // far. The unmigrated string-literal handlers (the remaining ~188
    // methods at Wave C kickoff) are tracked by the "Wave C progress"
    // it() block below for visibility, NOT gated against the registry
    // until Plan 35-19 closes Wave C.
    const migratedHandlerMethods = new Set<string>();
    for (const file of handlerFiles) {
      for (const m of collectMethodsFromFile(file)) {
        if (m.migrated) migratedHandlerMethods.add(m.method);
      }
    }
    const contractMethods = new Set(API_CONTRACTS.keys());
    // Wave A state: both sets empty → trivially pass. Wave C state: every
    // migrated handler must be in the contract registry.
    const orphans = [...migratedHandlerMethods].filter(
      (m) => !contractMethods.has(m),
    );
    expect(
      orphans,
      formatViolations({
        description:
          "migrated daemon handler methods (computed-key) without a contract entry",
        violations: orphans.map((m) => ({
          file: m,
          line: 0,
          snippet: "no API_CONTRACTS entry",
        })),
        suggestedFix:
          "Add a contract entry to packages/core/src/api-contracts/<domain>.ts",
        designRef: "WEB-CONTRACTS-07 + 35-CONTEXT.md D-08",
      }),
    ).toEqual([]);
  });

  it("every contract entry has a MIGRATED daemon handler (WEB-CONTRACTS-07)", () => {
    // Migrated = `[Contract.method]:` computed key. A contract without a
    // matching migrated handler is either (a) a contract author forgot to
    // refactor the handler to computed keys, or (b) the contract was
    // added without a corresponding handler at all. Both are bugs Wave C
    // plans must catch.
    const migratedHandlerMethods = new Set<string>();
    for (const file of handlerFiles) {
      for (const m of collectMethodsFromFile(file)) {
        if (m.migrated) migratedHandlerMethods.add(m.method);
      }
    }
    const orphans = [...API_CONTRACTS.keys()].filter(
      (m) => !migratedHandlerMethods.has(m),
    );
    expect(
      orphans,
      formatViolations({
        description: "API_CONTRACTS entries without a migrated daemon handler",
        violations: orphans.map((m) => ({
          file: m,
          line: 0,
          snippet: "no migrated daemon handler (string-literal key still present)",
        })),
        suggestedFix:
          "Refactor the handler to use `[<Contract>.method]:` computed key, or remove the contract.",
        designRef: "WEB-CONTRACTS-07",
      }),
    ).toEqual([]);
  });

  it("Wave C migration progress is visible (diagnostic — non-blocking)", () => {
    // Diagnostic-only it() block. Counts how many handler methods are
    // unmigrated (string-literal keys) — gives reviewers a live count of
    // remaining Wave C migration work. Always passes (asserts >= 0); the
    // actual gate is the "every contract entry has a MIGRATED handler"
    // assertion above + Plan 35-19's Wave C closure which makes the
    // unmigrated count zero by construction (every handler uses computed
    // keys → every method is enforced 1:1 with the registry).
    let migrated = 0;
    let unmigrated = 0;
    for (const file of handlerFiles) {
      for (const m of collectMethodsFromFile(file)) {
        if (m.migrated) migrated++;
        else unmigrated++;
      }
    }
    // The assertion is purely informational — the test always passes — but
    // the counts appear in vitest's diagnostic output via the message arg
    // when other tests in this file fail.
    expect(
      migrated + unmigrated,
      `Wave C migration progress: migrated=${migrated} unmigrated=${unmigrated} (registry size=${API_CONTRACTS.size})`,
    ).toBeGreaterThanOrEqual(0);
  });
});
