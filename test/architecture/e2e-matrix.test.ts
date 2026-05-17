// SPDX-License-Identifier: Apache-2.0
/**
 * Matrix-gate architecture test — E2E flow-matrix invariant.
 *
 * Asserts every cell in test/e2e/flow-matrix.ts is settled:
 * - status="covered" → referenced test file exists on disk
 *   (verified via `statSync(repoRoot/cell.reference).isFile()` —
 *    structural, not behavioral; the test's content is NOT inspected)
 * - status="skipped" → reason is non-empty and not in the blocklist
 *   (blocklist regex /^(TODO|later|tbd)/i — case-insensitive prefix match)
 *
 * Independent of the orchestrator `--check-matrix` flag, which is the
 * second enforcement path. Two redundant gates by design: even if a
 * contributor removes the orchestrator flag, this architecture test still
 * fails on unsettled cells when `pnpm test` runs the architecture project.
 *
 * Walker analog (filter+assert idiom over imported typed data) is
 * `test/architecture/composition-root.test.ts`. Failure-message rendering
 * uses `formatViolations` (test/support/architecture-helpers.ts) — the
 * canonical architecture-gate pattern.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  flowMatrix,
  CHANNELS,
  FLOWS,
  type FlowCell,
} from "../e2e/flow-matrix.js";
import { formatViolations } from "../support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

/**
 * Blocklist for skipped-cell reasons. Matches the same regex used by the
 * orchestrator `--check-matrix` flag (test/orchestrate.ts) so both
 * enforcement paths agree on what constitutes an unsettled skip reason.
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
  "reason explaining why an E2E test cannot exist for this combination. " +
  "The orchestrator --check-matrix flag enforces the same invariant " +
  "at CI time as the second enforcement path.";

const SUGGESTED_FIX_SKIPPED =
  "Replace the reason with a case-specific explanation of why this " +
  "(channel × flow) combination is unrepresentable end-to-end today. " +
  "Forbidden prefixes: TODO, later, tbd (case-insensitive). " +
  "If the cell SHOULD be covered, change status to \"covered\" and reference " +
  "an existing test file at the integration tier.";

const ALLOWLIST_REF = "test/e2e/flow-matrix.ts (single source of truth — no separate allowlist)";

describe("e2e-matrix — flow-matrix invariant enforcement", () => {
  it("contains exactly 63 cells (9 channels × 7 flows) with no duplicate (channel, flow) pairs", () => {
    expect(flowMatrix.length).toBe(63);

    const keys = new Set(flowMatrix.map((c) => `${c.channel}|${c.flow}`));
    expect(keys.size).toBe(63);

    // Verify every (channel × flow) combination is present exactly once.
    const missingPairs: string[] = [];
    for (const channel of CHANNELS) {
      for (const flow of FLOWS) {
        if (!keys.has(`${channel}|${flow}`)) {
          missingPairs.push(`${channel}|${flow}`);
        }
      }
    }
    expect(missingPairs).toEqual([]);
  });

  it("every covered cell references a test file that exists on disk", () => {
    const covered = flowMatrix.filter((c) => c.status === "covered");
    const violations = covered.filter(
      (c) => !fileExistsAtRepoRelative(c.reference),
    );
    expect(
      violations.map((c) => `${c.channel}×${c.flow} -> ${c.reference}`),
      formatViolations({
        description:
          "Every covered cell in test/e2e/flow-matrix.ts must reference a test file that exists on disk.",
        violations: violations.map((c) => ({
          file: c.reference,
          line: 0,
          snippet: `${c.channel}×${c.flow} status="covered" but reference path does not exist`,
        })),
        suggestedFix: SUGGESTED_FIX_COVERED,
        allowlistRef: ALLOWLIST_REF,
      }),
    ).toEqual([]);
  });

  it("every skipped cell has a non-empty reason that does not match the TODO/later/tbd blocklist", () => {
    const skipped = flowMatrix.filter((c) => c.status === "skipped");
    const violations = skipped.filter(
      (c) =>
        !c.reference ||
        c.reference.trim().length === 0 ||
        SKIP_REASON_BLOCKLIST.test(c.reference.trim()),
    );
    expect(
      violations.map((c) => `${c.channel}×${c.flow} -> "${c.reference}"`),
      formatViolations({
        description:
          "Every skipped cell in test/e2e/flow-matrix.ts must have a non-empty reason that does not match the blocklist regex /^(TODO|later|tbd)/i.",
        violations: violations.map((c) => ({
          file: "test/e2e/flow-matrix.ts",
          line: 0,
          snippet: `${c.channel}×${c.flow} status="skipped" but reason is empty or blocklisted ("${c.reference}")`,
        })),
        suggestedFix: SUGGESTED_FIX_SKIPPED,
        allowlistRef: ALLOWLIST_REF,
      }),
    ).toEqual([]);
  });

  it("every cell has status exactly equal to 'covered' or 'skipped' (no other values)", () => {
    const violations = flowMatrix.filter(
      (c) => c.status !== "covered" && c.status !== "skipped",
    );
    expect(
      violations.map((c) => `${c.channel}×${c.flow} -> ${(c as FlowCell).status as string}`),
    ).toEqual([]);
  });
});
