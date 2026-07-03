// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      // Self-alias: tests under `src/` may import `test/support/factories.ts`
      // (and similar workspace-level helpers) which use bare-package
      // `@comis/core` imports for portability across packages. Without this
      // alias, Node's resolver can't find the core package by name from
      // within itself. Resolves to `dist/index.js` — `pnpm build` must run
      // before tests (existing convention; see CLAUDE.md).
      "@comis/core": resolve(__dirname, "./dist/index.js"),
      // Parity test: secret-detection.test.ts imports getDefaultRedactPatterns
      // from @comis/observability at test time only (test-file cross-import;
      // NOT a production core → observability edge). The architecture-graph.test.ts
      // checks package.json `dependencies` only, not devDependencies.
      "@comis/observability": resolve(__dirname, "../observability/dist/index.js"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
