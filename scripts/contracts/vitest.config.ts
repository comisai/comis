// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vitest/config";

/**
 * Codegen-script unit tests live in this directory alongside the codegen
 * source (RESEARCH §"Determinism rules" + Plan 35-20 acceptance criteria
 * cite `scripts/contracts/generate.test.ts` as the codegen unit suite).
 *
 * These tests are wired into `pnpm test` via the root `vitest.config.ts`
 * `projects` array. They run alongside the package unit suites and
 * `test/architecture/` (which holds the CI-gate drift + bundle-size
 * tests).
 *
 * @module
 */
export default defineConfig({
  test: {
    name: "scripts-contracts",
    include: ["**/*.test.ts"],
    pool: "threads",
    testTimeout: 60_000,
    passWithNoTests: true,
  },
});
