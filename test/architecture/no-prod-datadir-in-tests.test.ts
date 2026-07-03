// SPDX-License-Identifier: Apache-2.0
/**
 * Shrink-only arch invariant: appendSessionIndexEntry must THROW when a
 * VITEST/NODE_ENV=test process writes under the real `~/.comis`. This is the
 * static regression lock for the leak class — a test run silently
 * polluting the operator's production telemetry dir with real session-index rows.
 *
 * This is a SECURITY control. It is paired with the behavioral throw test in
 * `packages/observability/src/session-index/append.test.ts` (the live net at the
 * chokepoint); this file is the static guard-present lock that fails loud if the
 * guard is ever removed or weakened (e.g. swapped to a raw env-object PropAccess,
 * which would also fail the globals gate).
 *
 * Shrink-only: the violation set may only DECREASE (it is empty today and the
 * assertion is `toEqual([])`). The guard must use `systemGetEnv("VITEST")`
 * (NOT process.env — append.ts is scanned by the globals gate), `os.homedir()`,
 * and `throw new Error`.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

describe("no-prod-datadir-in-tests invariant", () => {
  it("append.ts has the VITEST+real-homedir throw-guard (regression lock)", () => {
    const src = readFileSync(
      resolve(REPO_ROOT, "packages/observability/src/session-index/append.ts"),
      "utf8",
    );
    const violations: string[] = [];
    const hasGuard =
      /systemGetEnv\(["']VITEST["']\)/.test(src) &&
      /throw new Error/.test(src) &&
      /os\.homedir\(\)/.test(src);
    if (!hasGuard) {
      violations.push(
        "append.ts is missing the VITEST+real-homedir throw-guard",
      );
    }
    expect(
      violations,
      "appendSessionIndexEntry must throw when a VITEST/NODE_ENV=test process writes under the real ~/.comis. " +
        "Guard must use systemGetEnv (not process.env) + os.homedir() + throw new Error.",
    ).toEqual([]);
  });
});
