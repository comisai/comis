// SPDX-License-Identifier: Apache-2.0
/**
 * Memory-package-scoped untyped-sqlite invariant.
 *
 * Forbids the pattern `db.prepare(...).all(...) as Type[]` /
 * `.get(...) as Type` inside `packages/memory/src/` outside the mapper
 * module. The typed `RowMapper<TRow>` factory is the sanctioned path;
 * every cast site closes by retargeting to `mapper.parseRows(...)` /
 * `mapper.parseOptionalRow(...)`.
 *
 * The rule scope is ONLY `packages/memory/src/` — other packages may
 * have legitimate SQLite use via external libraries with their own typing.
 *
 * The classifier walks TypeScript `as` expressions, so formatting and the
 * spelling of the asserted type cannot hide a raw row cast. The test validates
 * it against positive/negative fixtures before scanning production source.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { formatViolations } from "../support/architecture-helpers.js";
import { untypedSqliteAllowlist } from "../support/architecture-allowlist.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const PACKAGES_ROOT = resolve(REPO_ROOT, "packages");
const MEMORY_SRC = resolve(PACKAGES_ROOT, "memory", "src");
const FIXTURES_DIR = resolve(here, "fixtures");

interface UntypedSqliteHit {
  readonly file: string; // absolute path
  readonly line: number; // 1-indexed
  readonly column: number; // 1-indexed
  readonly symbol: string; // captured type name
  readonly snippet: string; // the offending expression, whitespace-normalized
}

function repoRelative(absPath: string): string {
  return absPath.startsWith(REPO_ROOT)
    ? absPath.slice(REPO_ROOT.length + 1)
    : absPath;
}

function castTargetSymbol(type: ts.TypeNode, sourceFile: ts.SourceFile): string {
  if (ts.isArrayTypeNode(type)) return castTargetSymbol(type.elementType, sourceFile);
  if (ts.isTypeLiteralNode(type)) return "<inline-object>";
  if (ts.isUnionTypeNode(type)) {
    const concrete = type.types.find((member) => member.kind !== ts.SyntaxKind.UndefinedKeyword);
    return concrete ? castTargetSymbol(concrete, sourceFile) : "<union>";
  }
  if (ts.isTypeReferenceNode(type)) return type.typeName.getText(sourceFile);
  return type.getText(sourceFile).replace(/\s+/g, " ");
}

function rawRowMethod(expression: ts.Expression): "all" | "get" | undefined {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  if (!ts.isCallExpression(current) || !ts.isPropertyAccessExpression(current.expression)) {
    return undefined;
  }
  const method = current.expression.name.text;
  return method === "all" || method === "get" ? method : undefined;
}

/** Extract raw SQLite row casts from a single TypeScript source file. */
function findHitsInFile(file: string): UntypedSqliteHit[] {
  const content = readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(file, content, ts.ScriptTarget.ES2023, true);
  const hits: UntypedSqliteHit[] = [];
  function visit(node: ts.Node): void {
    if (ts.isAsExpression(node) && rawRowMethod(node.expression) !== undefined) {
      const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      hits.push({
        file,
        line: location.line + 1,
        column: location.character + 1,
        symbol: castTargetSymbol(node.type, sourceFile),
        snippet: node.getText(sourceFile).replace(/\s+/g, " "),
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return hits;
}

function listProductionFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (!["__tests__", "__snapshots__", "fixtures"].includes(entry.name)) {
        listProductionFiles(full, out);
      }
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".generated.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

describe("untyped-sqlite — packages/memory/src/ forbids db.prepare(...).all/get(...) as Type", () => {
  it("fixture validation detects multiline and inline-object casts without false positives", () => {
    // Validate classifier correctness BEFORE scanning production source.
    // This is the analog of `globals-positive.ts` / `globals-negative.ts`
    // assertions for the simpler regex-based classifier.
    const positiveFile = resolve(
      FIXTURES_DIR,
      "untyped-sqlite-positive.ts",
    );
    const negativeFile = resolve(
      FIXTURES_DIR,
      "untyped-sqlite-negative.ts",
    );

    const positiveHits = findHitsInFile(positiveFile);
    const negativeHits = findHitsInFile(negativeFile);

    expect(
      positiveHits.length,
      `untyped-sqlite-positive fixture must produce exactly 9 violations, including multiline and inline-object casts (got ${positiveHits.length})`,
    ).toBe(9);
    expect(positiveHits.filter((hit) => hit.symbol === "<inline-object>")).toHaveLength(2);

    expect(
      negativeHits,
      formatViolations({
        description:
          "untyped-sqlite-negative fixture MUST classify clean — string literals, comments, .run(), and mapper calls must not match.",
        violations: negativeHits.map((h) => ({
          file: repoRelative(h.file),
          line: h.line,
          column: h.column,
          snippet: h.snippet,
        })),
        suggestedFix:
          "Adjust the regex or per-line filter so the named CLEAN case is no longer matched. Negative fixtures pin the boundary of the classifier's correctness.",
        designRef:
          "fixture-driven classifier correctness",
      }),
    ).toEqual([]);
  });

  it("no NEW untyped-sqlite cast in packages/memory/src/ beyond untypedSqliteAllowlist", () => {
    const productionFiles = listProductionFiles(MEMORY_SRC);
    const violations = productionFiles.flatMap(findHitsInFile);

    // Allowlist key shape: {file, symbol}. A single file may have
    // multiple cast sites for different types, so per-symbol
    // granularity is required.
    const allowlistKey = new Set(
      untypedSqliteAllowlist.map((e) => `${e.file}::${e.symbol}`),
    );
    const newViolations = violations.filter((v) => {
      const key = `${repoRelative(v.file)}::${v.symbol}`;
      return !allowlistKey.has(key);
    });

    expect(
      newViolations,
      formatViolations({
        description:
          "Memory production source must use the RowMapper<TRow> factory instead of `db.prepare(...).all/get(...) as Type` casts.",
        violations: newViolations.map((v) => ({
          file: repoRelative(v.file),
          line: v.line,
          column: v.column,
          snippet: `${v.snippet}  (cast target: ${v.symbol})`,
        })),
        suggestedFix:
          "Convert to `mapper.parseRows(stmt.all(...))` / `mapper.parseOptionalRow(stmt.get(...))` with Result unwrap.",
        designRef:
          "typed row mapper invariant",
        allowlistRef:
          "untypedSqliteAllowlist (test/support/architecture-allowlist.ts)",
      }),
    ).toEqual([]);

    // Sanity: scan walked at least one production file in memory/src/.
    expect(
      productionFiles.length,
      "sanity: the AST classifier walked at least one production file in packages/memory/src/",
    ).toBeGreaterThan(0);
  });
});
