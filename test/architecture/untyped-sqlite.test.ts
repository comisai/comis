// SPDX-License-Identifier: Apache-2.0
/**
 * Memory-package-scoped untyped-sqlite invariant (HYG-05).
 *
 * Forbids the pattern `db.prepare(...).all(...) as Type[]` /
 * `.get(...) as Type` inside `packages/memory/src/` outside the Phase D
 * mapper module. The forward-looking Phase D introduces a typed
 * `RowMapper<TRow>` factory (TS-HYG-01..04); every cast site closes by
 * retargeting to `mapper.parseRows(...)` / `mapper.parseOptionalRow(...)`.
 *
 * The rule scope is ONLY `packages/memory/src/` (per RESEARCH.md
 * §"Rule 3" — the live inventory has 35 unique {file, symbol} cast
 * pairs across 14 files all within memory/src/; other packages may have
 * legitimate SQLite use via external libraries with their own typing).
 *
 * The classifier is a regex (no AST/TypeChecker needed). The test
 * validates the regex against positive/negative fixtures BEFORE
 * scanning production source.
 *
 * Line-extraction note: `findInSourceFiles` returns matched FILES but
 * not match LINES. To produce per-line violations, the test reads each
 * matched file with `readFileSync`, splits on newlines, and tests each
 * line against the regex. The test's allowlist key is `{file, symbol}`
 * (the type name cast TO) per PATTERNS.md key shape table.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findInSourceFiles } from "../support/source-grep.js";
import { formatViolations } from "../support/architecture-helpers.js";
import { untypedSqliteAllowlist } from "../support/architecture-allowlist.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const PACKAGES_ROOT = resolve(REPO_ROOT, "packages");
const MEMORY_SRC = resolve(PACKAGES_ROOT, "memory", "src");
const FIXTURES_DIR = resolve(here, "fixtures");

/**
 * Matches `<expr>.all(...) as <Type>[]?` or `<expr>.get(...) as <Type>[]?`.
 *
 * Regex anatomy:
 *   \.(all|get)        — method call on prepared statement
 *   \(                 — open paren
 *   [^)]*              — any non-paren args (single-line; multi-line
 *                        args would need `[\s\S]` — RESEARCH.md notes
 *                        the current cast sites are all single-line)
 *   \)                 — close paren
 *   \s+as\s+           — TS `as` cast keyword
 *   \w+                — type name (one or more word chars)
 *   (\[\])?            — optional [] array suffix
 */
const UNTYPED_SQLITE_RE = /\.(all|get)\([^)]*\)\s+as\s+(\w+)(\[\])?/;

interface UntypedSqliteHit {
  readonly file: string; // absolute path
  readonly line: number; // 1-indexed
  readonly symbol: string; // captured type name
  readonly snippet: string; // the offending line text (trimmed)
}

function repoRelative(absPath: string): string {
  return absPath.startsWith(REPO_ROOT)
    ? absPath.slice(REPO_ROOT.length + 1)
    : absPath;
}

/**
 * Extract per-line hits from a single file. Returns one UntypedSqliteHit
 * per matched line.
 */
function findHitsInFile(file: string): UntypedSqliteHit[] {
  const content = readFileSync(file, "utf8");
  const lines = content.split(/\r?\n/);
  const hits: UntypedSqliteHit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // Clone the regex per line to avoid lastIndex state (mirrors
    // source-grep.ts RES-PIT-8 guard).
    const re = new RegExp(UNTYPED_SQLITE_RE.source);
    const match = re.exec(line);
    if (match) {
      // Skip string-literal occurrences: if the match starts INSIDE a
      // string delimited by `"` or `'` or backtick, skip. (Trivial
      // heuristic — comments and string literals containing the pattern
      // are caught by counting unescaped quote chars before the match
      // start.) Per RESEARCH.md edge case 5: chained .get() as A | B
      // matches the first word-char identifier (which is correct —
      // the symbol field records "A" only; the `|` truncation is
      // intentional for the allowlist symbol field).
      const beforeMatch = line.slice(0, match.index);
      const isComment =
        /^\s*\/\//.test(line) || /^\s*\*\s/.test(line);
      if (isComment) continue;

      const dq = (beforeMatch.match(/"/g) ?? []).length;
      const sq = (beforeMatch.match(/'/g) ?? []).length;
      const bt = (beforeMatch.match(/`/g) ?? []).length;
      // Inside a string if odd-count of any unescaped quote precedes.
      if (dq % 2 === 1 || sq % 2 === 1 || bt % 2 === 1) continue;

      hits.push({
        file,
        line: i + 1,
        symbol: match[2] ?? "<unknown>",
        snippet: line.trim(),
      });
    }
  }
  return hits;
}

describe("untyped-sqlite — packages/memory/src/ forbids db.prepare(...).all/get(...) as Type (HYG-05)", () => {
  it("fixture validation: positive fixture produces ≥5 violations, negative fixture produces 0", () => {
    // Validate classifier correctness BEFORE scanning production source.
    // This is the analog of `globals-positive.ts` / `globals-negative.ts`
    // assertions (Plan 06) for the simpler regex-based classifier.
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
      `untyped-sqlite-positive fixture must produce ≥5 violations (got ${positiveHits.length})`,
    ).toBeGreaterThanOrEqual(5);

    expect(
      negativeHits,
      formatViolations({
        description:
          "untyped-sqlite-negative fixture MUST classify clean — string literals, comments, .run(), and mapper calls must not match.",
        violations: negativeHits.map((h) => ({
          file: repoRelative(h.file),
          line: h.line,
          snippet: h.snippet,
        })),
        suggestedFix:
          "Adjust the regex or per-line filter so the named CLEAN case is no longer matched. Negative fixtures pin the boundary of the classifier's correctness.",
        designRef:
          "code-quality-plan §4.5 (5) / Phase A / D-FIX-01 — fixture-driven classifier correctness",
      }),
    ).toEqual([]);
  });

  it("no NEW untyped-sqlite cast in packages/memory/src/ beyond untypedSqliteAllowlist", () => {
    const result = findInSourceFiles({
      rootDir: MEMORY_SRC,
      needle: UNTYPED_SQLITE_RE,
      excludeFileSuffixes: [".test.ts"],
    });

    const violations: UntypedSqliteHit[] = [];
    for (const matchedFile of result.matches) {
      violations.push(...findHitsInFile(matchedFile));
    }

    // Allowlist key shape: {file, symbol} per PATTERNS.md key shape table.
    // A single file may have multiple cast sites for different types,
    // so per-symbol granularity is required.
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
          "Memory production source must use the Phase D RowMapper<TRow> factory instead of `db.prepare(...).all/get(...) as Type` casts.",
        violations: newViolations.map((v) => ({
          file: repoRelative(v.file),
          line: v.line,
          snippet: `${v.snippet}  (cast target: ${v.symbol})`,
        })),
        suggestedFix:
          "Convert to `mapper.parseRows(stmt.all(...))` / `mapper.parseOptionalRow(stmt.get(...))` with Result unwrap. See design §7.2.1 + TS-HYG-01..04.",
        designRef:
          "code-quality-plan §4.2 (3) / Phase A / HYG-05 / Phase D TS-HYG-01..04",
        allowlistRef:
          "untypedSqliteAllowlist (test/support/architecture-allowlist.ts)",
      }),
    ).toEqual([]);

    // Sanity: scan walked at least one production file in memory/src/.
    expect(
      result.checkedFiles,
      "sanity: findInSourceFiles walked at least one production file in packages/memory/src/",
    ).toBeGreaterThan(0);
  });
});
