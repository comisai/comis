// SPDX-License-Identifier: Apache-2.0
/**
 * Factored-or-marked invariant — estimation-constant division sites.
 *
 * Every char->token DIVISION by an estimation constant (`CHARS_PER_TOKEN`,
 * `CHARS_PER_TOKEN_STRUCTURED`, `CHARS_PER_TOKEN_RATIO`,
 * `CHARS_PER_TOKEN_RATIO_STRUCTURED`) in `packages/agent/src/**` must be
 * either:
 *
 *   (a) FACTORED — `scriptTokenFactor(` appears on the matched line OR on
 *       either of the TWO preceding non-empty lines. Multi-line
 *       `Math.ceil(...)` expressions put the factored terms on the lines
 *       ABOVE the division line (e.g. failure-path's effective-chars
 *       one-ceil sum ends with `toolChars) / CHARS_PER_TOKEN_RATIO` while
 *       the `scriptTokenFactor(...)` calls sit on the two lines above), or
 *   (b) MARKED — `flat-by-design` appears on the matched line OR on either
 *       of the TWO preceding non-empty lines, naming WHY the site
 *       deliberately stays flat (aggregate char counts with no text in
 *       scope, relative-only heuristics, machine-Latin content).
 *
 * The lookback is SYMMETRIC for both tokens: a prettier re-wrap that moves
 * a factored term one line up must not flip the verdict, and a marker
 * comment directly above a continuation line is honored identically.
 * `scriptTokenFactor(` counts as FACTORED only on
 * NON-comment lines in the window (a `// TODO: wrap with
 * scriptTokenFactor(...)` two lines above a flat division must not pass),
 * while `flat-by-design` stays comment-eligible — markers ARE comments.
 *
 * Matched divisor shapes (strengthen, never weaken):
 *   - `/ CHARS_PER_TOKEN...` and `/ (CHARS_PER_TOKEN... * f(...))`
 *   - `/ ((cond ? CHARS_PER_TOKEN_X : CHARS_PER_TOKEN_Y) * f(...))` —
 *     any number of opening parens, optional ternary-condition prefix
 *   - `/ (ratio * f(...))` — divisor held in a variable named `ratio`
 *     (the family-2 root computeMessageTokens shape)
 *   - the split-line form `x /\n (CONST * f(...))`: each non-comment line
 *     is also tested JOINED with its next non-comment line, so a prettier
 *     re-wrap that pushes the divisor to the next line cannot exit the
 *     guard's scope. A joined match is credited to the `/` line and only
 *     when the next line does not match on its own (no double-counting).
 *
 * Why this guard exists: #190 added a third system-tokens recompute site
 * that an earlier two-site list missed — silently undoing the script
 * factor right after tool deferral. With this
 * gate, a new division site must CHOOSE a disposition at commit time
 * instead of silently under-counting dense scripts.
 *
 * Direction matters: MULTIPLICATIONS by the constants (the tokens->chars
 * direction, e.g. lcd-fresh-tail-bound's char cap) are
 * conservative-by-direction and deliberately unmatched.
 *
 * Comment lines (trimmed line starting with `//`, `*`, or `/*`) are
 * excluded from MATCHING so prose that quotes the formula (e.g.
 * lcd-leaf-summarizer's docstring) cannot trip the guard — but comment
 * lines DO count as preceding non-empty lines for the lookback, which is
 * exactly what makes `// flat-by-design: ...` marker comments work
 * (markers only — see the factored-token comment exclusion above).
 *
 * Anti-rot self-check: the scan must find at least MIN_EXPECTED_MATCHES
 * sites — a rotted regex or a broken walk fails loudly instead of passing
 * vacuously. The floor sits ABOVE the earlier matcher's count so a
 * regression to the old (root-blind) matcher also trips it.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatViolations } from "../support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const AGENT_SRC = resolve(REPO_ROOT, "packages", "agent", "src");

/**
 * Division by an estimation constant: a `/` followed (modulo whitespace and
 * any number of opening parens) by the constant name, an optional
 * ternary-condition prefix before the constant
 * (`/ ((isStructured ? CHARS_PER_TOKEN_STRUCTURED : CHARS_PER_TOKEN) * ...)`),
 * or the divisor variable `ratio` (`/ (ratio * scriptTokenFactor(...))` —
 * the family-2 root shape the earlier matcher was blind to).
 * Multiplications never match (no `/` before the divisor).
 */
const DIVISION_BY_ESTIMATION_CONSTANT =
  /\/\s*\(*\s*(?:[A-Za-z_$][\w$]*\s*\?\s*)?CHARS_PER_TOKEN(?:_RATIO)?(?:_STRUCTURED)?\b|\/\s*\(*\s*ratio\b/;

/**
 * Anti-rot floor for the matcher self-check. The strengthened scan
 * finds 38 sites; the earlier matcher found 32, so a floor
 * of 33 also trips on a regression to the old root-blind matcher — fix the
 * matcher, never lower the floor to pass.
 */
const MIN_EXPECTED_MATCHES = 33;

/** Lookback depth: the TWO preceding non-empty lines (comments included). */
const LOOKBACK_LINES = 2;

/** Standard architecture-walker directory exclusions. */
const EXCLUDED_DIR_NAMES = new Set([
  "__tests__",
  "__snapshots__",
  "dist",
  "node_modules",
  "__test-helpers",
  "fixtures",
]);

/**
 * Bench tooling + committed Latin corpora — out of estimation scope
 * (never feeds budget/fit math).
 */
const BENCHMARK_DIR = resolve(AGENT_SRC, "memory", "benchmark");

function walkAgentSourceFiles(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = resolve(dir, entry.name);
    if (entry.isSymbolicLink()) continue; // symlink loop guard
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      if (full === BENCHMARK_DIR) continue;
      walkAgentSourceFiles(full, out);
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

function repoRelative(absPath: string): string {
  return absPath.startsWith(REPO_ROOT)
    ? absPath.slice(REPO_ROOT.length + 1)
    : absPath;
}

/** Trimmed-prefix comment check: `//`, `*` (JSDoc body), or `/*`. */
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*")
  );
}

interface MatchedSite {
  readonly file: string;
  /** 1-based line number of the matched division line. */
  readonly line: number;
  readonly text: string;
  /** true = factored or marked within the symmetric lookback window. */
  readonly pass: boolean;
}

function scanFile(file: string): MatchedSite[] {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const sites: MatchedSite[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Comment lines never MATCH (docstrings quote the formula in prose).
    if (isCommentLine(line)) continue;

    // Logical-line join: prettier may wrap the divisor onto
    // the NEXT line (`x /\n (CHARS_PER_TOKEN_RATIO * ...)`). Each line is
    // also tested joined with its next non-comment line; a joined match is
    // credited to THIS line (where the `/` lives) and ONLY when the next
    // line does not match on its own — otherwise the next line's own
    // iteration records that site (no double-counting a wrapper line above
    // a self-contained division line).
    const next = i + 1 < lines.length && !isCommentLine(lines[i + 1]) ? lines[i + 1] : "";
    const matchesAlone = DIVISION_BY_ESTIMATION_CONSTANT.test(line);
    const matchesJoined =
      !matchesAlone &&
      next !== "" &&
      !DIVISION_BY_ESTIMATION_CONSTANT.test(next) &&
      DIVISION_BY_ESTIMATION_CONSTANT.test(`${line} ${next}`);
    if (!matchesAlone && !matchesJoined) continue;

    // The logical line carries the full divisor expression for joined
    // matches, so a factor call on the wrapped divisor line classifies the
    // site factored without consuming lookback depth.
    const logicalLine = matchesJoined ? `${line} ${next}` : line;

    // SYMMETRIC two-line lookback: the matched logical line itself OR
    // either of the TWO preceding non-empty lines may carry
    // `scriptTokenFactor(` (factored — NON-comment lines only: prose
    // quoting the call must not classify a flat site) or
    // `flat-by-design` (marked — comment lines stay eligible; that is what
    // makes marker comments work).
    const window: string[] = [logicalLine];
    for (let j = i - 1; j >= 0 && window.length < 1 + LOOKBACK_LINES; j--) {
      if (lines[j].trim() === "") continue;
      window.push(lines[j]);
    }
    const pass = window.some(
      (w) =>
        (!isCommentLine(w) && w.includes("scriptTokenFactor(")) ||
        w.includes("flat-by-design"),
    );
    sites.push({ file, line: i + 1, text: logicalLine.trim(), pass });
  }
  return sites;
}

function collectSites(): MatchedSite[] {
  const files: string[] = [];
  walkAgentSourceFiles(AGENT_SRC, files);
  return files.flatMap((f) => scanFile(f));
}

describe("token-factor-sites — factored-or-marked invariant", () => {
  it("finds at least 33 estimation-constant division sites (matcher anti-rot self-check)", () => {
    const sites = collectSites();
    expect(
      sites.length,
      `Matcher self-check: expected >= ${MIN_EXPECTED_MATCHES} estimation-constant division sites in packages/agent/src, got ${sites.length}. A near-zero count means DIVISION_BY_ESTIMATION_CONSTANT or the walk rotted — fix the matcher, do NOT lower the floor.`,
    ).toBeGreaterThanOrEqual(MIN_EXPECTED_MATCHES);
  });

  it("sees the family-2 root divisor shapes: ratio-variable, wrapped ternary, and split-line divisors (guard-strength pin)", () => {
    // False-negative vector: the earlier matcher required the
    // constant to follow `/` (with at most one paren) on the SAME line, so
    // the PRIMARY estimator root — computeMessageTokens, the very #190
    // recurrence class this guard documents — was invisible to the gate. A
    // future edit stripping the factor from these roots must trip the guard,
    // so their presence in the matched-site set is pinned here.
    const sites = collectSites();
    const texts = (relFile: string) =>
      sites.filter((s) => repoRelative(s.file) === relFile).map((s) => s.text);

    const estimator = texts("packages/agent/src/safety/token-estimator.ts");
    // String-content site: the divisor is a VARIABLE — `/ (ratio * scriptTokenFactor(...))`.
    expect(
      estimator.some((t) => t.includes("ratio * scriptTokenFactor(")),
      "ratio-variable divisor site in token-estimator.ts must be matched (vector 1)",
    ).toBe(true);
    // Text-block site: wrapped two-paren ternary divisor —
    // `/\n ((isStructured ? CHARS_PER_TOKEN_STRUCTURED : CHARS_PER_TOKEN) * scriptTokenFactor(text))`.
    expect(
      estimator.some((t) => t.includes("isStructured ? CHARS_PER_TOKEN_STRUCTURED")),
      "wrapped ternary divisor site in token-estimator.ts must be matched (vector 1)",
    ).toBe(true);

    // llm-compaction span walk: `/` ends one line and the
    // `(CHARS_PER_TOKEN_RATIO * scriptTokenFactor(...))` divisor starts the next.
    const compaction = texts("packages/agent/src/context-engine/llm-compaction.ts");
    expect(
      compaction.some((t) => t.includes("CHARS_PER_TOKEN_RATIO * scriptTokenFactor(")),
      "split-line divisor site in llm-compaction.ts must be matched (vector 1)",
    ).toBe(true);
  });

  it("reports zero unfactored and unmarked estimation-constant divisions in packages/agent/src", () => {
    const violations = collectSites().filter((s) => !s.pass);
    expect(
      violations,
      formatViolations({
        description:
          "Every char->token division by an estimation constant in packages/agent/src must be FACTORED (scriptTokenFactor on the division line or within its two preceding non-empty lines) or explicitly MARKED flat-by-design — a new flat site silently under-counts dense scripts (the #190 recurrence class).",
        violations: violations.map((v) => ({
          file: repoRelative(v.file),
          line: v.line,
          snippet: v.text,
        })),
        suggestedFix:
          "Factor the exact string whose length is divided — divisor form `(RATIO * scriptTokenFactor(thatString))`, or for multi-term sums the effective-chars ONE-ceil form `Math.ceil((a.length / scriptTokenFactor(a) + b.length / scriptTokenFactor(b) + flatChars) / RATIO)` — the factor call may sit on the division line or the two lines above it. If NO source text is in scope (aggregate char counts, relative-only heuristics, machine-rendered Latin), add a `// flat-by-design: <specific reason>` marker line directly above the site instead. NEVER weaken this matcher to pass.",
        designRef:
          "#190 third-site recurrence — a new estimation-constant division site silently under-counts dense scripts",
      }),
    ).toEqual([]);
  });
});
