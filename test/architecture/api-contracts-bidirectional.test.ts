// SPDX-License-Identifier: Apache-2.0
/**
 * Bidirectional 1:1 mapping between daemon handlers and the
 * `@comis/core/api-contracts` registry.
 *
 * The handler-method set is split into two cohorts:
 *   - `migratedHandlerMethods` (computed-key `[Contract.method]:`)
 *   - `unmigratedHandlerMethods` (string-literal `"method.name":`)
 * The test asserts:
 *   - Every contract entry has a MIGRATED handler.
 *   - Every MIGRATED handler method has a contract entry.
 * The unmigrated set is tracked diagnostically; once every handler uses
 * computed-key form, enforcement is universal by construction.
 *
 * Walker design: for each `packages/daemon/src/api/*-handlers.ts` file,
 * parse via `ts.createSourceFile(..., ts.ScriptTarget.ES2023, true)` and
 * tag every `PropertyAssignment.name`:
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
 * Recursively enumerate every `.ts` file under `dir`, skipping
 * `*.test.ts` files and `__snapshots__/` directories. Used by
 * `resolveContractMethodName` to support the subdirectory split where
 * large contract files (workspace.ts, orchestrator.ts) were
 * decomposed (e.g. `workspace/workspace-handlers.ts`).
 */
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
 * Recursive walker for handler files under `HANDLER_DIR` (and any
 * `*-handlers/` subdirectories created by domain splits — e.g.
 * `graph-handlers/`, `obs-handlers/`, `session-handlers/`,
 * `config-handlers/`).
 *
 * Returns paths relative to `HANDLER_DIR`. Accepts top-level
 * `*-handlers.ts` files AND any `.ts` file inside a `*-handlers/`
 * subdirectory (excluding test files, snapshots, parity tests).
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
      // Descend only into `*-handlers/` subdirectories.
      if (ent.name.endsWith("-handlers")) {
        out.push(...listHandlerFiles(full, relPath));
      }
    } else if (
      ent.isFile() &&
      ent.name.endsWith(".ts") &&
      !ent.name.endsWith(".test.ts") &&
      !ent.name.endsWith(".parity.test.ts")
    ) {
      // At top level: accept only `*-handlers.ts` files (preserve original semantics).
      // Inside `*-handlers/` subdir: accept any non-test `.ts` (leaf modules + index).
      if (prefix) {
        out.push(relPath);
      } else if (ent.name.endsWith("-handlers.ts")) {
        out.push(relPath);
      }
    }
  }
  return out;
}

/**
 * Find `export const <ContractName> = defineContract({ method: "..." ... })`
 * across every `.ts` file under `packages/core/src/api-contracts/` (recursive
 * — supports the subdirectory splits). Returns the matched method literal
 * or `undefined` if the contract symbol is not present.
 */
function resolveContractMethodName(contractName: string): string | undefined {
  const files = listContractFiles(CONTRACT_DIR);
  for (const file of files) {
    const src = readFileSync(file, "utf8");
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
 * the unmigrated set is tracked for diagnostics.
 */
interface TaggedMethod {
  readonly method: string;
  readonly migrated: boolean;
}

/**
 * Collect every method name declared as a handler in `file` (one
 * `*-handlers.ts` under `HANDLER_DIR`). Returns tagged entries:
 * string-literal keys are tagged `migrated: false`; computed-name keys
 * resolved through the contract registry are tagged `migrated: true`.
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

describe("Contract registry — bidirectional 1:1", () => {
  const handlerFiles = listHandlerFiles(HANDLER_DIR);

  it("sanity: api/ contains at least 20 *-handlers.ts files", () => {
    expect(
      handlerFiles.length,
      `expected >= 20 daemon handler factories; found ${handlerFiles.length}`,
    ).toBeGreaterThan(20);
  });

  it("every MIGRATED daemon handler method has a contract entry", () => {
    // Migrated = handler factory uses `[Contract.method]:` computed-property
    // key. By construction, that key cannot resolve unless the contract
    // exists in the registry — so the orphan check is in effect a 1:1
    // consistency check for the migrated cohort. The unmigrated
    // string-literal handlers are tracked by the diagnostic it() block
    // below for visibility, NOT gated against the registry.
    const migratedHandlerMethods = new Set<string>();
    for (const file of handlerFiles) {
      for (const m of collectMethodsFromFile(file)) {
        if (m.migrated) migratedHandlerMethods.add(m.method);
      }
    }
    const contractMethods = new Set(API_CONTRACTS.keys());
    // When both sets are empty the test trivially passes; otherwise every
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
        designRef: "api-contracts bidirectional 1:1",
      }),
    ).toEqual([]);
  });

  it("every contract entry has a MIGRATED daemon handler", () => {
    // Migrated = `[Contract.method]:` computed key. A contract without a
    // matching migrated handler is either (a) a contract author forgot to
    // refactor the handler to computed keys, or (b) the contract was
    // added without a corresponding handler at all. Both are bugs.
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
        designRef: "api-contracts bidirectional 1:1",
      }),
    ).toEqual([]);
  });

  it("migration progress is visible (diagnostic — non-blocking)", () => {
    // Diagnostic-only it() block. Counts how many handler methods are
    // unmigrated (string-literal keys) — gives reviewers a live count of
    // remaining migration work. Always passes (asserts >= 0); the actual
    // gate is the "every contract entry has a MIGRATED handler"
    // assertion above. When every handler uses computed keys the
    // unmigrated count is zero by construction.
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
      `migration progress: migrated=${migrated} unmigrated=${unmigrated} (registry size=${API_CONTRACTS.size})`,
    ).toBeGreaterThanOrEqual(0);
  });
});
