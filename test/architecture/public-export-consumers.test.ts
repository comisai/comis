// SPDX-License-Identifier: Apache-2.0
/**
 * Public-export consumer presence test.
 *
 * For each workspace package, AST-scan every named export from
 * packages/<pkg>/src/index.ts. Assert each exported symbol has at least
 * one in-repo consumer (file outside the package importing it from
 * @comis/<pkg>) OR a documented entry in test/support/public-api-policy.ts.
 *
 * Anything else is a dead export.
 *
 * Pattern: scan all `import` statements project-wide; bucket by imported
 * symbol; cross-reference against each package's index.ts AST. The
 * reverse-direction scan (start from index.ts, resolve `export * from`)
 * is more expensive — repo's index.ts files use explicit named exports
 * verified empirically.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import * as ts from "typescript";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLIC_API_POLICY } from "../support/public-api-policy.js";
import { formatViolations } from "../support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const PACKAGES = [
  "agent",
  "channels",
  "cli",
  "core",
  "daemon",
  "gateway",
  "infra",
  "memory",
  "scheduler",
  "shared",
  "skills",
] as const;

interface ExportInfo {
  readonly name: string;
  readonly file: string;
  readonly kind: "value" | "type" | "default";
}

/**
 * Collect direct + transitive (`export * from`) named exports starting from
 * `entryPath`. The function recurses through `export *` chains to flatten
 * the public surface; `core/src/index.ts` uses this re-export pattern.
 *
 * Cycle-safe via a `visited` set keyed on absolute path.
 */
function collectExportsFrom(
  entryPath: string,
  visited: Set<string> = new Set(),
): ExportInfo[] {
  if (visited.has(entryPath)) return [];
  visited.add(entryPath);
  let sourceText: string;
  try {
    sourceText = readFileSync(entryPath, "utf8");
  } catch {
    return [];
  }
  const sf = ts.createSourceFile(
    entryPath,
    sourceText,
    ts.ScriptTarget.ES2023,
    true,
  );
  const exports: ExportInfo[] = [];
  const dir = dirname(entryPath);
  ts.forEachChild(sf, function visit(node) {
    if (ts.isExportDeclaration(node)) {
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) {
          // For `export { X as Y } from "...";`, the EXTERNAL name is `Y`.
          exports.push({
            name: el.name.text,
            file: entryPath,
            kind: node.isTypeOnly ? "type" : "value",
          });
        }
      } else if (
        !node.exportClause &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        // `export * from "./x.js";` — recurse into the referenced file.
        const spec = node.moduleSpecifier.text;
        if (spec.startsWith(".")) {
          // Resolve `.js` suffix back to `.ts` for source-mode reading.
          const tsPath = resolve(dir, spec.replace(/\.js$/, ".ts"));
          for (const sub of collectExportsFrom(tsPath, visited)) {
            exports.push(sub);
          }
        }
      }
    } else if (
      ts.isVariableStatement(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node)
    ) {
      const isExported = node.modifiers?.some(
        (m) => m.kind === ts.SyntaxKind.ExportKeyword,
      );
      if (isExported) {
        if (ts.isVariableStatement(node)) {
          for (const decl of node.declarationList.declarations) {
            if (ts.isIdentifier(decl.name)) {
              exports.push({
                name: decl.name.text,
                file: entryPath,
                kind: "value",
              });
            }
          }
        } else if ("name" in node && node.name && ts.isIdentifier(node.name)) {
          const kind =
            ts.isFunctionDeclaration(node) ||
            ts.isClassDeclaration(node) ||
            ts.isEnumDeclaration(node)
              ? "value"
              : "type";
          exports.push({ name: node.name.text, file: entryPath, kind });
        }
      }
    }
  });
  return exports;
}

function listPublicExports(packageName: string): ExportInfo[] {
  const indexPath = resolve(REPO_ROOT, `packages/${packageName}/src/index.ts`);
  return collectExportsFrom(indexPath);
}

function walkAllTsFiles(rootDir: string): string[] {
  const results: string[] = [];
  function walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = resolve(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (
          [
            "__tests__",
            "__snapshots__",
            "dist",
            "node_modules",
            "__test-helpers",
          ].includes(entry.name)
        )
          continue;
        walk(full);
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts") &&
        !entry.name.endsWith(".d.ts")
      ) {
        results.push(full);
      }
    }
  }
  walk(rootDir);
  return results;
}

function listConsumers(packageName: string): Map<string, string[]> {
  const consumers = new Map<string, string[]>();
  const allTsFiles = walkAllTsFiles(resolve(REPO_ROOT, "packages"));
  for (const filePath of allTsFiles) {
    if (filePath.includes(`/packages/${packageName}/`)) continue; // Skip self-imports.
    const sourceText = readFileSync(filePath, "utf8");
    const sf = ts.createSourceFile(
      filePath,
      sourceText,
      ts.ScriptTarget.ES2023,
      true,
    );
    ts.forEachChild(sf, function visit(node) {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === `@comis/${packageName}`
      ) {
        if (
          node.importClause?.namedBindings &&
          ts.isNamedImports(node.importClause.namedBindings)
        ) {
          for (const el of node.importClause.namedBindings.elements) {
            // For `import { X as Y }`, propertyName is X (the original
            // exported name); name is Y (local alias). We track the
            // original name X because that's what the index.ts exports.
            const symbol = el.propertyName?.text ?? el.name.text;
            const list = consumers.get(symbol) ?? [];
            list.push(filePath);
            consumers.set(symbol, list);
          }
        }
        // Default imports — skip; we only track named imports for orphan detection.
      } else if (
        // `export { X } from "@comis/<packageName>"` — re-export chain.
        // Without this, a symbol that is alive only via re-export chains
        // looks like an orphan and inflates PUBLIC_API_POLICY noise.
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === `@comis/${packageName}` &&
        node.exportClause &&
        ts.isNamedExports(node.exportClause)
      ) {
        for (const el of node.exportClause.elements) {
          const symbol = el.propertyName?.text ?? el.name.text;
          const list = consumers.get(symbol) ?? [];
          list.push(filePath);
          consumers.set(symbol, list);
        }
      }
    });
  }
  return consumers;
}

describe("public-export-consumers", () => {
  for (const pkg of PACKAGES) {
    it(`every named export from @comis/${pkg}/src/index.ts has an in-repo consumer or policy entry`, () => {
      const exports = listPublicExports(pkg);
      const consumers = listConsumers(pkg);
      const policy =
        PUBLIC_API_POLICY.get(`@comis/${pkg}`) ?? new Set<string>();
      const orphans = exports.filter(
        (e) => !consumers.has(e.name) && !policy.has(e.name),
      );
      expect(
        orphans,
        formatViolations({
          description: `@comis/${pkg}/src/index.ts has dead exports.`,
          violations: orphans.map((o) => ({
            file: `${o.file} (export: ${o.name}, kind: ${o.kind})`,
            line: 0,
          })),
          suggestedFix: `Either remove the export from packages/${pkg}/src/index.ts (preferred), or add it to test/support/public-api-policy.ts under "@comis/${pkg}" with a rationale comment if it is part of the documented external API surface.`,
          allowlistRef: "L9, L10, L11 (per package)",
        }),
      ).toEqual([]);
      expect(
        exports.length,
        `sanity: @comis/${pkg}/src/index.ts must have at least one named export`,
      ).toBeGreaterThan(0);
    });
  }
});
