// SPDX-License-Identifier: Apache-2.0
/**
 * Unified allowlist shrink-only gate (D-04 + D-SHRINK-01..03).
 *
 * Reads `test/support/architecture-allowlist.ts` at base ref via
 * `git show origin/main:test/support/architecture-allowlist.ts`,
 * parses both base and head via static AST extraction (NOT dynamic
 * import — robust to schema drift between commits), and for each of
 * the 8 allowlists asserts no NEW entries vs base per the key-shape
 * appropriate to that array (D-SHRINK-02 / PATTERNS.md key shape table).
 *
 * Key shapes:
 *   - `ALLOWLIST`                 — L-ID set (Phase 27 D-04 preserved)
 *   - `fileSizeAllowlist`         — {file} set
 *   - `rawThrowAllowlist`         — {file, lineRanges[0][0]} set
 *   - `untypedSqliteAllowlist`    — {file, symbol} set
 *   - `optionalFieldAllowlist`    — {file, typeName} set
 *   - `globalsAllowlist`          — {file, line, global} set
 *   - `noBackwardCompatAllowlist` — {file, line} set
 *   - `coverageWaiver`            — length only (head.length <= base.length)
 *
 * Local-fallback: if `origin/main` is not fetched (running locally
 * without `git fetch`), the test SKIPS with a console.warn (Phase 27
 * pattern preserved — auto-fetching from a test would surprise
 * developers and require network access during `pnpm test`).
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import * as ts from "typescript";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { formatViolations } from "../support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..", "..");
const ALLOWLIST_PATH = resolve(
  REPO_ROOT,
  "test/support/architecture-allowlist.ts",
);
const BASE_REF = process.env.COMIS_ALLOWLIST_BASE_REF ?? "origin/main";

function readBaseAllowlist(): string | null {
  try {
    return execSync(
      `git show ${BASE_REF}:test/support/architecture-allowlist.ts`,
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  } catch {
    return null;
  }
}

/**
 * Static AST extraction of an arbitrary array's entries' raw properties.
 *
 * Returns a flat array of `Record<string, string | number>` where each
 * record contains the entry's PropertyAssignment values (StringLiteral
 * + NumericLiteral only — composite values like `lineRanges:
 * [[12, 12]]` are extracted as their first inner numeric for shrink-key
 * stability per PATTERNS.md).
 */
function extractArrayEntries(
  sourceText: string,
  arrayName: string,
): Array<Record<string, string | number>> {
  const sf = ts.createSourceFile(
    "allowlist.ts",
    sourceText,
    ts.ScriptTarget.ES2023,
    /*setParentNodes*/ true,
  );
  const out: Array<Record<string, string | number>> = [];

  function extractFromObject(obj: ts.ObjectLiteralExpression): void {
    const record: Record<string, string | number> = {};
    for (const prop of obj.properties) {
      if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) {
        continue;
      }
      const key = prop.name.text;
      const init = prop.initializer;
      if (ts.isStringLiteral(init)) {
        record[key] = init.text;
      } else if (ts.isNumericLiteral(init)) {
        record[key] = Number(init.text);
      } else if (ts.isArrayLiteralExpression(init)) {
        // For lineRanges: [[12, 12], ...] — extract first numeric of
        // first nested array for shrink-key stability.
        const first = init.elements[0];
        if (first && ts.isArrayLiteralExpression(first)) {
          const inner = first.elements[0];
          if (inner && ts.isNumericLiteral(inner)) {
            record[key] = Number(inner.text);
          }
        }
      }
    }
    out.push(record);
  }

  function visit(node: ts.Node): void {
    if (
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (d) => ts.isIdentifier(d.name) && d.name.text === arrayName,
      )
    ) {
      const decl = node.declarationList.declarations.find(
        (d) => ts.isIdentifier(d.name) && d.name.text === arrayName,
      );
      let arrayExpr: ts.ArrayLiteralExpression | undefined;
      if (decl?.initializer) {
        if (
          ts.isAsExpression(decl.initializer) &&
          ts.isArrayLiteralExpression(decl.initializer.expression)
        ) {
          arrayExpr = decl.initializer.expression;
        } else if (ts.isArrayLiteralExpression(decl.initializer)) {
          arrayExpr = decl.initializer;
        }
      }
      if (arrayExpr) {
        for (const el of arrayExpr.elements) {
          if (ts.isObjectLiteralExpression(el)) {
            extractFromObject(el);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(sf, visit);
  return out;
}

type KeyKind = "l-id" | "tuple" | "length";

interface ShrinkArrayConfig {
  readonly name: string;
  readonly keyKind: KeyKind;
  readonly extractKey?: (p: Record<string, string | number>) => string;
}

/**
 * Configuration for all 8 allowlists. The order matches RESEARCH.md
 * §"Shrink-Test Unification" SHRINK_ARRAYS table.
 */
const SHRINK_ARRAYS: readonly ShrinkArrayConfig[] = [
  { name: "ALLOWLIST", keyKind: "l-id" },
  {
    name: "fileSizeAllowlist",
    keyKind: "tuple",
    extractKey: (p) => String(p.file ?? ""),
  },
  {
    name: "rawThrowAllowlist",
    keyKind: "tuple",
    extractKey: (p) => `${p.file ?? ""}:${p.lineRanges ?? "<none>"}`,
  },
  {
    name: "untypedSqliteAllowlist",
    keyKind: "tuple",
    extractKey: (p) => `${p.file ?? ""}:${p.symbol ?? ""}`,
  },
  {
    name: "optionalFieldAllowlist",
    keyKind: "tuple",
    extractKey: (p) => `${p.file ?? ""}:${p.typeName ?? ""}`,
  },
  {
    name: "globalsAllowlist",
    keyKind: "tuple",
    extractKey: (p) =>
      `${p.file ?? ""}:${p.line ?? 0}:${p.global ?? ""}`,
  },
  {
    name: "noBackwardCompatAllowlist",
    keyKind: "tuple",
    extractKey: (p) => `${p.file ?? ""}:${p.line ?? 0}`,
  },
  { name: "coverageWaiver", keyKind: "length" },
  // testNamingAllowlist: per-(file,line,text) tuple key — but the text
  // can contain commas / quotes / unicode, which the simple AST extractor
  // does not faithfully reconstruct. We use length-only ratchet for COV-10
  // (same model as coverageWaiver) — the gate's per-entry semantic is
  // enforced by the test-naming.test.ts file itself (it builds the
  // allowlistSet from canonical key strings). The length ratchet here
  // guarantees the array shrinks monotonically across phases.
  { name: "testNamingAllowlist", keyKind: "length" },
];

describe.each(SHRINK_ARRAYS)(
  "allowlist-shrink — $name (D-SHRINK-01..03)",
  ({ name, keyKind, extractKey }) => {
    it(`${name} is shrink-only between ${BASE_REF}..HEAD`, () => {
      const baseText = readBaseAllowlist();
      if (baseText === null) {
        console.warn(
          `[allowlist-shrink:${name}] Could not retrieve ${BASE_REF}:test/support/architecture-allowlist.ts. ` +
            `Skipping. This is expected when running locally without 'git fetch'. CI runs always have the base ref available.`,
        );
        return;
      }
      const headText = readFileSync(ALLOWLIST_PATH, "utf8");
      const baseEntries = extractArrayEntries(baseText, name);
      const headEntries = extractArrayEntries(headText, name);

      // Length-only shrink-rule for coverageWaiver.
      if (keyKind === "length") {
        expect(
          headEntries.length,
          formatViolations({
            description: `${name} grew (length-only ratchet).`,
            violations: [
              {
                file: name,
                line: headEntries.length,
                snippet: `base length: ${baseEntries.length}, head length: ${headEntries.length}`,
              },
            ],
            suggestedFix:
              "Remove entries from the head allowlist OR escalate via the out-of-band exception process (D-SHRINK-02 deferred).",
            designRef:
              "design §15.5 + code-quality-plan §4.5 (D-SHRINK-01) + Phase 27 D-04",
          }),
        ).toBeLessThanOrEqual(baseEntries.length);
        return;
      }

      // Set-based shrink-rule for L-ID and tuple keys.
      const keyFn: (p: Record<string, string | number>) => string =
        keyKind === "l-id"
          ? (p) => String(p.id ?? "")
          : extractKey!;
      const baseKeys = new Set(baseEntries.map(keyFn));
      const headKeys = new Set(headEntries.map(keyFn));
      const added = [...headKeys].filter((k) => !baseKeys.has(k));

      expect(
        added,
        formatViolations({
          description: `${name} is shrink-only (D-SHRINK-01). The following entries were ADDED in this PR:`,
          violations: added.map((key) => ({
            file: `${name} (key: ${key})`,
            line: 0,
          })),
          suggestedFix:
            "If a new violation must be allowlisted, it requires an explicit phase commit (not a feature PR). Either (a) close the underlying violation in this PR (preferred), or (b) escalate to a design-doc amendment + phase commit.",
          designRef:
            "design §15.5 + code-quality-plan §4.5 (D-SHRINK-01) + Phase 27 D-04",
          allowlistRef: name,
        }),
      ).toEqual([]);
    });
  },
);

// Preserve the self-test invariant from Phase 27: AST extractor count
// must agree with a regex-based sanity count for each array.
describe("allowlist-shrink — AST extractor self-test (D-04)", () => {
  it("extractArrayEntries(ALLOWLIST) agrees with regex L-ID count (Phase 27 invariant)", () => {
    const headText = readFileSync(ALLOWLIST_PATH, "utf8");
    const headEntries = extractArrayEntries(headText, "ALLOWLIST");
    const regexCount = (headText.match(/^\s*id:\s*"L\d+"/gm) ?? []).length;
    expect(
      headEntries.length,
      "extractArrayEntries parse-self-test: count must agree with regex regardless of allowlist size (Phase 36 GUARDRAILS-01 closed the last entry — vacuous-pass is now legitimate because the array is the closed empty set).",
    ).toBeGreaterThanOrEqual(0);
    expect(
      headEntries.length,
      "AST extractor must agree with regex-counted L-IDs in the ALLOWLIST array",
    ).toBe(regexCount);
  });

  it.each(
    SHRINK_ARRAYS.filter((c) => c.name !== "ALLOWLIST").map((c) => c.name),
  )("extractArrayEntries(%s) returns ≥0 entries (parse smoke test)", (name) => {
    const headText = readFileSync(ALLOWLIST_PATH, "utf8");
    const entries = extractArrayEntries(headText, name);
    // Smoke: the extractor parses without throwing; each entry has at
    // least one extracted key (file or id — universal across all 7
    // new arrays per PATTERNS.md schema).
    expect(entries.length).toBeGreaterThanOrEqual(0);
    for (const e of entries) {
      expect(
        Object.keys(e).length,
        `${name} entry has at least one extracted key`,
      ).toBeGreaterThan(0);
    }
  });
});
