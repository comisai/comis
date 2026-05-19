// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vitest/config";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packagesRoot = resolve(here, "../../packages");

export default defineConfig({
  // Scoped alias: `@comis/core` + `@comis/observability`. The contract-
  // registry architecture tests (api-contracts-bidirectional,
  // api-contracts-allowlist, contract-internal-fields) need the COMPILED
  // runtime values — the actual API_CONTRACTS Map, the frozen
  // INTERNAL_FIELD_NAMES tuple — not source AST. Plan 45-03 added the
  // trajectory-event-types-known.test.ts that needs the compiled
  // TRAJECTORY_BRIDGE_MAPPING from @comis/observability for the same
  // reason — the bridge mapping is the runtime closed set.
  //
  // Routing these two specific packages to dist/ leaves every other
  // architecture test reading packages/*/src/ via source-grep +
  // ts.createSourceFile (invariant: don't mask source-only changes
  // through alias-routed dist/ reads).
  resolve: {
    alias: {
      "@comis/core": resolve(packagesRoot, "core/dist/index.js"),
      "@comis/observability": resolve(packagesRoot, "observability/dist/index.js"),
    },
  },
  test: {
    name: "architecture",
    include: ["**/*.test.ts"],
    pool: "threads",
    // Architecture tests scan the whole packages/*/src tree, parse ASTs, and
    // invoke madge across 1200+ files. 30s was borderline on warm runners and
    // tipped over on slow ones (globals/no-cycles/log-payload-checker all
    // exceeded it in CI run 26003385575). Raise to 120s — generous but bounded.
    testTimeout: 120_000,
    passWithNoTests: true,
  },
});
