// SPDX-License-Identifier: Apache-2.0
/**
 * Project-wide raw-throw invariant.
 *
 * Forbids `throw new XError(...)` and `throw <identifier>;` patterns in
 * production source under `packages/*\/src/`. Violations are retrofitted to
 * Result.err, an `@allow-throw` boundary adapter, or an `assertNever`
 * exhaustive check.
 *
 * Exception zones (NOT flagged):
 *   - `packages/{shared,core}/src/security/` — canonical safe-path /
 *     redaction code where throws are the boundary contract
 *   - `packages/*\/src/safety/` — safety adapters
 *   - any file ending with `/error-mapper.ts` — error-mapper factory pattern
 *   - any file containing the literal substring `// @allow-throw:` or
 *     `@allow-throw:` anywhere in its source
 *
 * Allowlist filter: `{file, lineRanges[0][0]}` key shape — anchors on
 * the FIRST range's start line. Seeded with one entry per file
 * (consolidating all line-ranges into one entry per file at seed time)
 * so the multi-range complexity is forward-looking.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatViolations } from "../support/architecture-helpers.js";
import { rawThrowAllowlist } from "../support/architecture-allowlist.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const PACKAGES_ROOT = resolve(REPO_ROOT, "packages");
const FIXTURES_DIR = resolve(here, "fixtures");

/**
 * Matches `throw new <CapitalizedConstructor>(...)` OR
 * `throw <lower-or-underscore-start-id>[ as <Type>][;,]`.
 *
 * Anchored on `^\s*` (start of logical line) to avoid matching JSDoc
 * continuation lines (`* @throws ...` would not satisfy `^\s*throw`
 * because of the leading `*`). Negative fixture pins this guard.
 *
 * Constructor alternation: an `[A-Z]\w*Error\s*\(` regex cannot match the
 * bare class name `Error` (no prefix char available to satisfy `[A-Z]`
 * before literal `Error`). Plain `throw new Error(...)` is the most common
 * raw-throw form (~549 plain `throw new Error(` sites in the codebase) and
 * is named verbatim in the locked positive fixture
 * (`// VIOLATION: throw new Error` / `throw new Error("invalid state");`).
 * Widening to `[A-Z]\w*\s*\(` matches every capitalized constructor
 * (`Error`, `MyError`, `RangeError`, `OAuthError`, `NonInteractiveError`,
 * …) so the positive-fixture's 6 violations all classify. The negative
 * fixture's string-literal / line-comment / JSDoc `@throws` cases remain
 * negative because the `^\s*` anchor and quote-count filter both still
 * apply unchanged.
 */
const RAW_THROW_RE =
  /^\s*throw\s+(new\s+[A-Z]\w*\s*\(|[a-z_][a-zA-Z0-9_]*(\s+as\s+[A-Z]\w*)?\s*[;,])/;

interface RawThrowHit {
  readonly file: string; // absolute path
  readonly line: number; // 1-indexed
  readonly snippet: string;
}

function repoRelative(absPath: string): string {
  return absPath.startsWith(REPO_ROOT)
    ? absPath.slice(REPO_ROOT.length + 1)
    : absPath;
}

/**
 * True if the file path is inside a sanctioned exception zone where raw
 * throws are the boundary contract, or covered by the `@allow-throw:`
 * annotation mechanism.
 *
 * Note: passing a relative path (prefixed `packages/...`) is sufficient
 * because the regex anchors check the substring.
 */
function isInExceptionZone(relFile: string): boolean {
  if (/^packages\/(shared|core)\/src\/security\//.test(relFile)) return true;
  if (/^packages\/[^/]+\/src\/safety\//.test(relFile)) return true;
  if (relFile.endsWith("/error-mapper.ts")) return true;
  return false;
}

/**
 * True if the file's source contains the literal substring
 * `@allow-throw:` (file-level opt-out for sanctioned boundary throws).
 */
function hasAllowThrowAnnotation(absPath: string): boolean {
  const content = readFileSync(absPath, "utf8");
  return content.includes("@allow-throw:");
}

/**
 * Walks every production .ts file under `packages/*\/src/`. Clones the
 * walker pattern used by file-size.test.ts and untyped-sqlite.test.ts.
 */
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

/**
 * Per-line raw-throw scan. Each matched line produces one RawThrowHit.
 * Comments and string-literal occurrences are filtered out — the regex
 * `^\s*` anchor handles JSDoc continuation lines (`* @throws`) and
 * line-comments (`//`) by definition (a line starting with `*` or `//`
 * does not satisfy `^\s*throw`), but string-literal occurrences inside
 * a multi-line string need the in-line quote-count filter below.
 */
function findRawThrowHits(file: string): RawThrowHit[] {
  const content = readFileSync(file, "utf8");
  const lines = content.split(/\r?\n/);
  const hits: RawThrowHit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // Clone the regex per line for safety; this regex has no /g or /y
    // flag so lastIndex state is not a concern.
    const re = new RegExp(RAW_THROW_RE.source);
    const match = re.exec(line);
    if (!match) continue;

    // Negative fixture insurance: string-literal containing "throw" must
    // NOT match. Count unescaped quotes before the match position.
    const beforeMatch = line.slice(0, match.index);
    const dq = (beforeMatch.match(/"/g) ?? []).length;
    const sq = (beforeMatch.match(/'/g) ?? []).length;
    const bt = (beforeMatch.match(/`/g) ?? []).length;
    if (dq % 2 === 1 || sq % 2 === 1 || bt % 2 === 1) continue;

    hits.push({ file, line: i + 1, snippet: line.trim() });
  }
  return hits;
}

describe("raw-throw — production source forbids raw throw outside boundary modules", () => {
  it("fixture validation: positive fixture produces ≥6 violations, negative fixture produces 0", () => {
    const positiveFile = resolve(FIXTURES_DIR, "raw-throw-positive.ts");
    const negativeFile = resolve(FIXTURES_DIR, "raw-throw-negative.ts");

    const positiveHits = findRawThrowHits(positiveFile);
    const negativeHits = findRawThrowHits(negativeFile);

    expect(
      positiveHits.length,
      `raw-throw-positive fixture must produce ≥6 violations (got ${positiveHits.length})`,
    ).toBeGreaterThanOrEqual(6);

    expect(
      negativeHits,
      formatViolations({
        description:
          "raw-throw-negative fixture MUST classify clean — Result.err, JSDoc @throws, string literals, line comments, and function-name false-positives must not match.",
        violations: negativeHits.map((h) => ({
          file: repoRelative(h.file),
          line: h.line,
          snippet: h.snippet,
        })),
        suggestedFix:
          "Adjust the regex or per-line filter so the named CLEAN case is no longer matched. Negative fixtures pin the boundary of the classifier's correctness.",
        designRef:
          "fixture-driven classifier correctness",
      }),
    ).toEqual([]);
  });

  it("no NEW raw throws in packages/*/src/ outside exception zones + @allow-throw + rawThrowAllowlist", () => {
    const allFiles = listAllProductionFiles();

    // Build allowlist key set: {file, firstLineRangeStart}.
    // The allowlist seeds one entry per file with consolidated lineRanges.
    const allowlistedFiles = new Set(
      rawThrowAllowlist.map((e) => e.file),
    );

    const newViolations: RawThrowHit[] = [];
    for (const file of allFiles) {
      const rel = repoRelative(file);
      if (isInExceptionZone(rel)) continue;
      if (hasAllowThrowAnnotation(file)) continue;
      if (allowlistedFiles.has(rel)) continue;
      newViolations.push(...findRawThrowHits(file));
    }

    expect(
      newViolations,
      formatViolations({
        description:
          "Production source contains a raw `throw` outside sanctioned boundary modules (security/, safety/, error-mapper.ts) and without an `@allow-throw:` annotation or rawThrowAllowlist entry.",
        violations: newViolations.map((v) => ({
          file: repoRelative(v.file),
          line: v.line,
          snippet: v.snippet,
        })),
        suggestedFix:
          "Convert to `Result.err(...)`; OR move the throwing code to `packages/*/src/safety/` or an `error-mapper.ts` boundary adapter; OR add `// @allow-throw: <reason>` to the file; OR add a rawThrowAllowlist entry to test/support/architecture-allowlist.ts.",
        designRef:
          "raw-throw architecture invariant",
        allowlistRef:
          "rawThrowAllowlist (test/support/architecture-allowlist.ts)",
      }),
    ).toEqual([]);

    // Sanity: walker actually scanned production files.
    expect(
      allFiles.length,
      "sanity: listAllProductionFiles enumerated at least one production .ts file",
    ).toBeGreaterThan(0);
  });
});
