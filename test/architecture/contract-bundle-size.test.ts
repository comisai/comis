// SPDX-License-Identifier: Apache-2.0
/**
 * Bundle-size gate: the generated validator bundle must remain within the
 * configured minified and gzipped budgets.
 *
 * Test strategy: read the committed `contracts.generated.size.json` (produced
 * by `pnpm contracts:generate`) and assert the totals are within budget. The
 * size report's `overBudget` flag is the codegen-time canary; this test is
 * the post-commit CI gate.
 *
 * The companion drift test (`contract-codegen-drift.test.ts`) guarantees the
 * size.json is up-to-date with the committed TS/JSON artifacts — together,
 * the two tests form a closed loop: drift gate ensures size.json reflects
 * the current code; budget gate ensures the size is acceptable.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUDGET_MINIFIED_BYTES,
  BUDGET_GZIPPED_BYTES,
} from "../../scripts/contracts/size-budget.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const SIZE_REPORT = resolve(
  REPO_ROOT,
  "packages",
  "web",
  "src",
  "api",
  "contracts.generated.size.json",
);

interface SizeReportShape {
  readonly totalMinified: number;
  readonly totalGzipped: number;
  readonly budget: { readonly minified: number; readonly gzipped: number };
  readonly overBudget: boolean;
}

describe("contracts bundle-size budget", () => {
  it("contracts.generated.size.json reports within the configured size budgets", () => {
    const raw = readFileSync(SIZE_REPORT, "utf8");
    const report = JSON.parse(raw) as SizeReportShape;

    expect(
      report.totalMinified,
      `totalMinified ${report.totalMinified}B exceeds budget ${BUDGET_MINIFIED_BYTES}B`,
    ).toBeLessThanOrEqual(BUDGET_MINIFIED_BYTES);

    expect(
      report.totalGzipped,
      `totalGzipped ${report.totalGzipped}B exceeds budget ${BUDGET_GZIPPED_BYTES}B`,
    ).toBeLessThanOrEqual(BUDGET_GZIPPED_BYTES);

    expect(report.overBudget, "size report flags overBudget=true").toBe(false);

    // Sanity: the report's own budget MUST match the constants. Drift here
    // would mean the size script's budget got out of sync with the gate.
    expect(report.budget.minified).toBe(BUDGET_MINIFIED_BYTES);
    expect(report.budget.gzipped).toBe(BUDGET_GZIPPED_BYTES);
  });
});
