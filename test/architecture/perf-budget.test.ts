// SPDX-License-Identifier: Apache-2.0
/**
 * Perf-budget schema check.
 *
 * This test validates the SHAPE of test/architecture/perf-baseline.json,
 * NOT the runtime of `pnpm test` itself. Measuring `pnpm test` from inside
 * `pnpm test` would require a sub-shell (`spawnSync("pnpm", ["test"])`)
 * which would re-run the entire suite recursively — circular.
 *
 * Out-of-band measurement is the procedure:
 *   - PRs record pre/post `time pnpm test` numbers in the PR description;
 *     reviewers compare them against perf-baseline.json by hand.
 *   - Changes that intentionally affect runtime refresh `perf-baseline.json`
 *     with their own measurement.
 *   - The 15-second-per-change budget (`actual_ms - baseline_ms <= 15000`)
 *     is enforced **out of band** during PR review, NOT inside this test.
 *     This file only validates the SHAPE of perf-baseline.json so a
 *     malformed baseline cannot ship.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { formatViolations } from "../support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = resolve(here, "perf-baseline.json");

interface PerfBaseline {
  readonly "pnpm-test": {
    readonly ms: number;
    readonly "recorded-at": string;
    readonly machine: string;
    readonly phase: string;
    readonly methodology?: string;
    readonly "node-version"?: string;
    readonly "vitest-version"?: string;
  };
}

describe("perf-budget", () => {
  it("perf-baseline.json has the expected schema", () => {
    const raw = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as PerfBaseline;
    const errors: string[] = [];
    if (!raw["pnpm-test"]) errors.push("missing root key 'pnpm-test'");
    if (raw["pnpm-test"] && typeof raw["pnpm-test"].ms !== "number") {
      errors.push("'pnpm-test.ms' must be a number");
    }
    if (raw["pnpm-test"] && raw["pnpm-test"].ms <= 0) {
      errors.push("'pnpm-test.ms' must be positive");
    }
    if (
      raw["pnpm-test"] &&
      raw["pnpm-test"].machine !== "single-cycle-autonomous-executor"
    ) {
      errors.push(
        `'pnpm-test.machine' must be 'single-cycle-autonomous-executor' (was: ${raw["pnpm-test"].machine})`,
      );
    }
    if (raw["pnpm-test"] && typeof raw["pnpm-test"].phase !== "string") {
      errors.push("'pnpm-test.phase' must be a string");
    }
    if (raw["pnpm-test"] && typeof raw["pnpm-test"]["recorded-at"] !== "string") {
      errors.push("'pnpm-test.recorded-at' must be a string");
    }
    expect(
      errors,
      formatViolations({
        description: "test/architecture/perf-baseline.json schema mismatch.",
        violations: errors.map((m) => ({ file: BASELINE_PATH, line: 0, snippet: m })),
        suggestedFix:
          "Re-record the baseline by running `time pnpm test` 3 times on the reference machine and updating perf-baseline.json with the median warm number.",
        designRef: "perf-baseline schema",
      }),
    ).toEqual([]);
  });

  it("perf-baseline.json is reasonable (between 1s and 10 minutes)", () => {
    const raw = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as PerfBaseline;
    // Sanity range: 1000 ms (suspiciously fast) to 600000 ms (10 min — way over budget).
    expect(raw["pnpm-test"].ms).toBeGreaterThan(1000);
    expect(raw["pnpm-test"].ms).toBeLessThan(600_000);
  });
});
