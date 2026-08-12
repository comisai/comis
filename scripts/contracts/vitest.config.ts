// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vitest/config";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const packagesRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../packages");

/**
 * Codegen-script unit tests live in this directory alongside the codegen
 * source — `scripts/contracts/generate.test.ts` is the codegen unit suite.
 *
 * These tests are wired into `pnpm test` via the root `vitest.config.ts`
 * `projects` array. They run alongside the package unit suites and
 * `test/architecture/` (which holds the CI-gate drift + bundle-size
 * tests).
 *
 * @module
 */
export default defineConfig({
  // The skill-manifest contract asserts what the registry's own parser reads
  // out of a shipped SKILL.md, so it needs the COMPILED parser + schema rather
  // than a re-implementation of the frontmatter rules. Mirrors the scoped dist
  // alias `test/architecture/vitest.config.ts` uses for the same reason.
  resolve: {
    alias: [
      { find: /^@comis\/skills$/, replacement: resolve(packagesRoot, "skills/dist/skills/index.js") },
    ],
  },
  test: {
    name: "scripts-contracts",
    include: ["**/*.test.ts"],
    pool: "threads",
    testTimeout: 60_000,
    passWithNoTests: true,
  },
});
