// SPDX-License-Identifier: Apache-2.0
/**
 * Project-wide optional-field-bloat invariant.
 *
 * Every `interface` or type-literal `type` declaration in production
 * source must have ≤12 optional fields unless it carries an
 * `// @optional-field-count: <reason>` audit-stamp comment immediately
 * above the declaration OR is the explicitly-excluded
 * `ChannelManagerDeps` (owned by a separate audit).
 *
 * Walker: `ts.createSourceFile` (no `ts.createProgram`, no TypeChecker)
 * — pure syntactic check. Counts members where
 * `(ts.isPropertySignature(m) || ts.isMethodSignature(m)) && m.questionToken`
 * is truthy.
 *
 * Audit-stamp scan: extracts the source-text slice from
 * `node.getFullStart()` to `node.getStart()` (leading trivia) and tests
 * for the literal substring `@optional-field-count:`. JSDoc and
 * `//`-style comments both work because `ts.forEachChild` does not
 * visit trivia — the slice contains the raw source text including
 * comments.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { optionalFieldAllowlist } from "../support/architecture-allowlist.js";
import { formatViolations } from "../support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const PACKAGES_ROOT = resolve(REPO_ROOT, "packages");
const THRESHOLD = 12;

/**
 * Hard-coded exclusion: `ChannelManagerDeps` is the largest bloated
 * interface (44 optional fields) but is owned by a separate audit —
 * it is NOT subject to the broader shrink. Matched on file+name pair
 * (NOT path alone) because `orchestrator/src/commands/types.ts` also
 * declares interfaces in the bloat list.
 */
const EXCLUDED: ReadonlyArray<{ readonly file: string; readonly name: string }> = [
  {
    file: "packages/orchestrator/src/channel-manager.ts",
    name: "ChannelManagerDeps",
  },
] as const;

interface OptionalFieldViolation {
  readonly file: string;
  readonly line: number;
  readonly typeName: string;
  readonly optionalCount: number;
}

function walkProductionFiles(dir: string, out: string[]): void {
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
          "fixtures",
        ].includes(entry.name)
      ) {
        continue;
      }
      walkProductionFiles(full, out);
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
}

function listAllProductionFiles(): string[] {
  const out: string[] = [];
  let packageDirs;
  try {
    packageDirs = readdirSync(PACKAGES_ROOT, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const pkg of packageDirs) {
    if (!pkg.isDirectory() || pkg.name.startsWith(".")) continue;
    walkProductionFiles(resolve(PACKAGES_ROOT, pkg.name, "src"), out);
  }
  return out;
}

function repoRelative(absPath: string): string {
  return absPath.startsWith(REPO_ROOT)
    ? absPath.slice(REPO_ROOT.length + 1)
    : absPath;
}

/**
 * Returns true if the node's leading-trivia source range contains the
 * literal substring `@optional-field-count:`. JSDoc and line-comment
 * forms both produce a substring match in the raw source-text slice.
 */
function hasAuditStamp(node: ts.Node, sourceText: string): boolean {
  const fullStart = node.getFullStart();
  const start = node.getStart();
  const leading = sourceText.slice(fullStart, start);
  return leading.includes("@optional-field-count:");
}

function findOptionalFieldBloat(
  files: readonly string[],
): OptionalFieldViolation[] {
  const out: OptionalFieldViolation[] = [];
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(
      file,
      content,
      ts.ScriptTarget.ES2023,
      /*setParentNodes*/ true,
    );

    const visit = (node: ts.Node): void => {
      let typeName: string | null = null;
      let optionalCount = 0;
      let nameStart = -1;

      if (ts.isInterfaceDeclaration(node)) {
        typeName = node.name.text;
        nameStart = node.name.getStart(sf);
        optionalCount = node.members.filter(
          (m) =>
            (ts.isPropertySignature(m) || ts.isMethodSignature(m)) &&
            m.questionToken !== undefined,
        ).length;
      } else if (
        ts.isTypeAliasDeclaration(node) &&
        ts.isTypeLiteralNode(node.type)
      ) {
        typeName = node.name.text;
        nameStart = node.name.getStart(sf);
        optionalCount = node.type.members.filter(
          (m) =>
            (ts.isPropertySignature(m) || ts.isMethodSignature(m)) &&
            m.questionToken !== undefined,
        ).length;
      }

      if (
        typeName !== null &&
        optionalCount > THRESHOLD &&
        !hasAuditStamp(node, content)
      ) {
        const line =
          sf.getLineAndCharacterOfPosition(nameStart).line + 1;
        out.push({ file, line, typeName, optionalCount });
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
  }
  return out;
}

describe("optional-field-bloat — interfaces/types ≤12 optional fields", () => {
  it("no production interface/type has more than 12 optional fields without an audit-stamp", () => {
    const files = listAllProductionFiles();
    const violations = findOptionalFieldBloat(files);

    const excludedKey = new Set(
      EXCLUDED.map((e) => `${e.file}::${e.name}`),
    );
    const allowlistKey = new Set(
      optionalFieldAllowlist.map((e) => `${e.file}::${e.typeName}`),
    );

    const newViolations = violations.filter((v) => {
      const key = `${repoRelative(v.file)}::${v.typeName}`;
      return !excludedKey.has(key) && !allowlistKey.has(key);
    });

    expect(
      newViolations,
      formatViolations({
        description: `Interface/type literals must have ≤${THRESHOLD} optional fields or carry an audit-stamp.`,
        violations: newViolations.map((v) => ({
          file: repoRelative(v.file),
          line: v.line,
          snippet: `${v.typeName} has ${v.optionalCount} optional fields (threshold: ${THRESHOLD})`,
        })),
        suggestedFix:
          "Either: (a) reduce optional fields; (b) split the interface; (c) add `// @optional-field-count: <reason>` immediately above the declaration; (d) add an optionalFieldAllowlist entry to test/support/architecture-allowlist.ts.",
        designRef:
          "Optional-field bloat invariant — interfaces/types ≤12 optional fields.",
        allowlistRef:
          "optionalFieldAllowlist (test/support/architecture-allowlist.ts)",
      }),
    ).toEqual([]);

    // Sanity: walker actually scanned production files.
    expect(
      files.length,
      "sanity: listAllProductionFiles enumerated at least one production .ts file",
    ).toBeGreaterThan(0);
  });
});
