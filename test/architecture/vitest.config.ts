// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vitest/config";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packagesRoot = resolve(here, "../../packages");

export default defineConfig({
  // Scoped alias: ONLY `@comis/core`. The contract-registry architecture
  // tests (api-contracts-bidirectional, api-contracts-allowlist, contract-
  // internal-fields) need the COMPILED runtime values — the actual
  // API_CONTRACTS Map, the frozen INTERNAL_FIELD_NAMES tuple — not source
  // AST. Routing only `@comis/core` to dist/ leaves every other architecture
  // test reading packages/*/src/ via source-grep + ts.createSourceFile
  // (invariant: don't mask source-only changes through alias-routed dist/
  // reads).
  resolve: {
    alias: {
      "@comis/core": resolve(packagesRoot, "core/dist/index.js"),
    },
  },
  test: {
    name: "architecture",
    include: ["**/*.test.ts"],
    pool: "threads",
    testTimeout: 30_000,
    passWithNoTests: true,
  },
});
