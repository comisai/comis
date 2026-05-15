// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

const packages = resolve(__dirname, "../../packages");

/**
 * Vitest project for end-to-end channel × flow tests.
 *
 * Phase 40 / Phase C §6.5 / COV-15 (Plan 40-09).
 *
 * Scope: tests under `test/e2e/<channel>-<flow>.test.ts` that spawn a real
 * daemon via the Phase 39 port-injected test harness (`test/support/
 * daemon-harness.ts`), drive a message through a 127.0.0.1 mock chat-
 * platform server (`test/e2e/mocks/<channel>/`), and assert the agent's
 * outbound response on the mock's captured-events stream.
 *
 * Why a SEPARATE project rather than appending to `test/vitest.config.ts`:
 *   1. E2E tests boot a real daemon (slow setup), so they need their own
 *      timeout budget and isolation policy.
 *   2. Per Plan 40-09 sub-decision: "clean separation from test/integration/"
 *      — the e2e tier has its own coverage threshold lifecycle independent
 *      of the integration tier's monotonic ramp.
 *   3. The integration project's include glob explicitly does NOT cover
 *      test/e2e/**, so the project boundary is structural.
 *
 * No coverage thresholds at the project level — e2e tests stress the
 * daemon's BOOT path and channel adapters, not unit-level invariants;
 * the unit (packages/*) and integration (test/integration/) projects
 * own the coverage gates per their own coverage scope contracts. See
 * AGENTS.md §2.5 / COV-03 / COV-04.
 *
 * @module
 */
export default defineConfig({
  resolve: {
    alias: {
      // Verbatim copy from test/vitest.config.ts — e2e tests use the
      // same `dist/`-resolved bare imports so the daemon harness can
      // spawn the production daemon. ORDER MATTERS for @comis/skills
      // subpaths (see comment in test/vitest.config.ts).
      "@comis/daemon": resolve(packages, "daemon/dist/index.js"),
      "@comis/core": resolve(packages, "core/dist/index.js"),
      "@comis/shared": resolve(packages, "shared/dist/index.js"),
      "@comis/infra": resolve(packages, "infra/dist/index.js"),
      "@comis/agent": resolve(packages, "agent/dist/index.js"),
      "@comis/channels": resolve(packages, "channels/dist/index.js"),
      "@comis/gateway": resolve(packages, "gateway/dist/index.js"),
      "@comis/memory": resolve(packages, "memory/dist/index.js"),
      "@comis/scheduler": resolve(packages, "scheduler/dist/index.js"),
      "@comis/skills/platform-tools": resolve(packages, "skills/dist/platform-tools/index.js"),
      "@comis/skills/tools": resolve(packages, "skills/dist/tools/index.js"),
      "@comis/skills": resolve(packages, "skills/dist/skills/index.js"),
      "@comis/orchestrator": resolve(packages, "orchestrator/dist/index.js"),
      "@comis/cli": resolve(packages, "cli/dist/index.js"),
    },
  },
  test: {
    name: "e2e",
    globalSetup: ["../support/global-setup.ts"],
    // Include only top-level test/e2e/*.test.ts files. The mock-server
    // helper files under test/e2e/mocks/<channel>/ are NOT test files;
    // they're fixtures imported by the e2e tests.
    include: ["test/e2e/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    teardownTimeout: 30_000,
    // Sequential execution — each test spawns a daemon that binds a real
    // gateway port. Parallel runs would collide on port allocation.
    pool: "forks",
    maxConcurrency: 1,
    retry: 1,
    // Allow CI to pass while Wave D is mid-flight; once Wave D lands the
    // 18-30 channel × flow tests this can be left as-is — vitest only
    // applies the `pass when zero tests` rule when zero tests match.
    passWithNoTests: true,
    env: {
      COMIS_REPO_ROOT: resolve(__dirname, "../.."),
    },
  },
});
