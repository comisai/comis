// SPDX-License-Identifier: Apache-2.0
/**
 * Matrix-gate architecture test — live-fire coverage-matrix invariant.
 *
 * Asserts every cell in test/live/coverage-matrix.ts is settled:
 * - status="covered" → referenced test file exists on disk
 *   (verified via `statSync(repoRoot/cell.reference).isFile()` —
 *    structural, not behavioral; the test's content is NOT inspected)
 * - status="skipped" → reason is non-empty and not in the blocklist
 *   (blocklist regex /^(TODO|later|tbd)/i — case-insensitive prefix match)
 *
 * All cells are initially status="skipped" with descriptive reasons,
 * so invariants 1 and 2 pass trivially at the outset (no covered cells yet,
 * all skipped cells have valid reasons). As subsequent work settles cells
 * to "covered", invariant 1 will enforce that the referenced test files exist.
 *
 * Two-gate design: even if a contributor removes the runner's matrix check,
 * this architecture test still catches unsettled cells during `pnpm test:architecture`.
 *
 * Analog: test/architecture/e2e-matrix.test.ts (exact structural mirror,
 * substituting dimension/modeValue axes for channel/flow axes).
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  coverageMatrix,
  COVERAGE_DIMENSIONS,
  type CoverageCell,
} from "../live/coverage-matrix.js";
import { formatViolations } from "../support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

/**
 * Blocklist for skipped-cell reasons. Matches the same regex used by the
 * orchestrator `--check-matrix` flag so both enforcement paths agree.
 * Case-insensitive prefix match: rejects "TODO", "TODO: ...", "later", etc.
 */
const SKIP_REASON_BLOCKLIST = /^(TODO|later|tbd)/i;

function fileExistsAtRepoRelative(repoRelativePath: string): boolean {
  try {
    return statSync(resolve(REPO_ROOT, repoRelativePath)).isFile();
  } catch {
    return false;
  }
}

const SUGGESTED_FIX_COVERED =
  "Either (a) add the missing test file at the referenced path, OR " +
  "(b) change the cell to status=\"skipped\" with a non-empty case-specific " +
  "reason explaining why a live test cannot exist for this combination. " +
  "See test/live/coverage-matrix.ts.";

const SUGGESTED_FIX_SKIPPED =
  "Replace the reason with a case-specific explanation of why this " +
  "(dimension × modeValue) combination is not yet covered. " +
  "Forbidden prefixes: TODO, later, tbd (case-insensitive). " +
  "Use format: \"covered in Phase N (NAME) — description\".";

const ALLOWLIST_REF =
  "test/live/coverage-matrix.ts (single source of truth — no separate allowlist)";

describe("live-coverage-matrix — coverage-matrix invariant enforcement", () => {
  it("every covered cell references a test file that exists on disk", () => {
    const covered = coverageMatrix.filter((c) => c.status === "covered");
    const violations = covered.filter(
      (c) => !fileExistsAtRepoRelative(c.reference),
    );
    expect(
      violations.map((c) => `${c.dimension}×${c.modeValue} -> ${c.reference}`),
      formatViolations({
        description:
          "Every covered cell in test/live/coverage-matrix.ts must reference a test file that exists on disk.",
        violations: violations.map((c) => ({
          file: c.reference,
          line: 0,
          snippet: `${c.dimension}×${c.modeValue} status="covered" but reference path does not exist`,
        })),
        suggestedFix: SUGGESTED_FIX_COVERED,
        allowlistRef: ALLOWLIST_REF,
        designRef: "test/live/coverage-matrix.ts",
      }),
    ).toEqual([]);
  });

  it("every skipped cell has a non-empty reason that does not match the TODO/later/tbd blocklist", () => {
    const skipped = coverageMatrix.filter((c) => c.status === "skipped");
    const violations = skipped.filter(
      (c) =>
        !c.reference ||
        c.reference.trim().length === 0 ||
        SKIP_REASON_BLOCKLIST.test(c.reference.trim()),
    );
    expect(
      violations.map(
        (c) => `${c.dimension}×${c.modeValue} -> "${c.reference}"`,
      ),
      formatViolations({
        description:
          "Every skipped cell in test/live/coverage-matrix.ts must have a non-empty reason that does not match the blocklist regex /^(TODO|later|tbd)/i.",
        violations: violations.map((c) => ({
          file: "test/live/coverage-matrix.ts",
          line: 0,
          snippet: `${c.dimension}×${c.modeValue} status="skipped" but reason is empty or blocklisted ("${c.reference}")`,
        })),
        suggestedFix: SUGGESTED_FIX_SKIPPED,
        allowlistRef: ALLOWLIST_REF,
        designRef: "test/live/coverage-matrix.ts",
      }),
    ).toEqual([]);
  });

  it("every cell has status exactly 'covered' or 'skipped' (no other values)", () => {
    const violations = coverageMatrix.filter(
      (c) => c.status !== "covered" && c.status !== "skipped",
    );
    expect(
      violations.map(
        (c) =>
          `${c.dimension}×${c.modeValue} -> ${(c as CoverageCell).status as string}`,
      ),
    ).toEqual([]);
  });

  it("COVERAGE_DIMENSIONS is non-empty and contains expected known dimensions", () => {
    expect(COVERAGE_DIMENSIONS.length).toBeGreaterThan(0);
    expect(COVERAGE_DIMENSIONS).toContain("contextEngine.version");
  });
});
