// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vitest/config";

/**
 * Unit project for the shared test-support kit.
 *
 * These helpers are load-bearing for the gates rather than for the product:
 * `import-checker.ts` and `source-grep.ts` decide whether ~20 per-package
 * architecture tests have seen a boundary violation, and
 * `architecture-allowlist.ts` is the exemption list those same tests read. A
 * silent break in one of them does not turn a gate red — it makes every gate
 * agree with a broken oracle and stay green.
 *
 * The kit was already collected by the INTEGRATION tier, whose project
 * includes `test/support/**\/*.test.ts` alongside `test/integration/**`. What
 * it was missing is the unit tier: `test/support` matched nothing in the root
 * `projects` list, so `pnpm test`, `pnpm test:coverage`, and therefore
 * `pnpm validate` — the pre-push gate — all skipped it. The oracle that
 * `pnpm validate`'s own architecture project depends on could break without
 * `pnpm validate` noticing, and the failure would surface only later, in a
 * tier that needs Linux and a build.
 *
 * CONTRACT for anything added here: no `@comis/*` import beyond `@comis/core`.
 * This project registers no dist aliases on purpose, so it runs in the unit
 * tier without a `pnpm build` and a stale `dist/` cannot mask a `src/` change.
 * The repo root declares only `@comis/core` as a workspace dependency, so a
 * bare `@comis/channels` or `@comis/shared` resolves nowhere on a clean
 * install and the FILE fails to load — reddening the whole unit gate. A local
 * `node_modules/@comis/` populated by earlier installs hides this, which is
 * exactly how both exclusions below reached CI green-on-macOS.
 *
 * `exclude` is that contract enforced rather than merely stated. Both excluded
 * files keep running in the integration tier, which aliases every `@comis/*`
 * to `packages/<pkg>/dist`.
 *
 * @module
 */
export default defineConfig({
  test: {
    name: "support",
    include: ["**/*.test.ts"],
    // Needs the built runtime: chaos-echo-adapter wraps EchoChannelAdapter
    // from @comis/channels and returns @comis/shared Results;
    // metric-aggregator calls extractMcpServerName from @comis/shared.
    // Neither package is resolvable from the repo root.
    exclude: ["chaos-echo-adapter.test.ts", "metric-aggregator.test.ts"],
    pool: "threads",
    // These tests parse fixture trees through ts.createSourceFile; the
    // 5s default is tight under coverage instrumentation on a shared runner.
    testTimeout: 60_000,
  },
});
