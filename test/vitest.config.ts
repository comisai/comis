// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

const packages = resolve(__dirname, "../packages");

export default defineConfig({
  resolve: {
    alias: {
      "@comis/daemon": resolve(packages, "daemon/dist/index.js"),
      "@comis/core": resolve(packages, "core/dist/index.js"),
      "@comis/shared": resolve(packages, "shared/dist/index.js"),
      "@comis/infra": resolve(packages, "infra/dist/index.js"),
      "@comis/agent": resolve(packages, "agent/dist/index.js"),
      "@comis/channels": resolve(packages, "channels/dist/index.js"),
      "@comis/gateway": resolve(packages, "gateway/dist/index.js"),
      "@comis/memory": resolve(packages, "memory/dist/index.js"),
      "@comis/scheduler": resolve(packages, "scheduler/dist/index.js"),
      // Three skills subpath entries.
      // ORDER MATTERS: Vite alias matching is prefix-based with `/` separator
      // semantics, so the most-specific subpaths MUST come BEFORE the bare
      // `@comis/skills` alias -- otherwise `@comis/skills/tools` would be
      // matched as bare-prefix + `/tools` and routed to the `.` subpath
      // target. Required for daemon's setup-tools.ts (which imports from
      // `@comis/skills/tools`).
      "@comis/skills/platform-tools": resolve(packages, "skills/dist/platform-tools/index.js"),
      "@comis/skills/tools": resolve(packages, "skills/dist/tools/index.js"),
      "@comis/skills": resolve(packages, "skills/dist/skills/index.js"),
      "@comis/orchestrator": resolve(packages, "orchestrator/dist/index.js"),
      "@comis/observability": resolve(packages, "observability/dist/index.js"),
      "@comis/cli": resolve(packages, "cli/dist/index.js"),
    },
  },
  test: {
    globalSetup: ["./test/support/global-setup.ts"],
    include: ["test/support/**/*.test.ts", "test/integration/**/*.test.ts", "test/live/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    teardownTimeout: 30_000,
    pool: "forks",
    maxConcurrency: 1,
    // Daemon-backed files need parallelism to finish within the E2E budget,
    // but deriving the worker count from every host CPU can starve teardown
    // and make retries collide with a daemon that still holds its data lock.
    maxWorkers: 4,
    retry: 1,
    env: {
      // Repo root, exposed to test daemon configs as ${COMIS_REPO_ROOT}.
      // Replaces hardcoded ${HOME}/Projects/comisai/comis in test-only YAMLs
      // so the integration suite is portable across CI runners, worktrees,
      // and contributor checkouts.
      COMIS_REPO_ROOT: resolve(__dirname, ".."),
    },
    // Integration-tier coverage threshold.
    //
    // Measures in-process imports the integration suite actually loads —
    // `packages/*/dist/**/*.js` (the alias targets above). Subprocess daemon
    // code is NOT measured here; that is the E2E tier's territory.
    //
    // Floor: Math.floor(measured) — same Math.floor protocol as the unit
    // tier. The aspirational target is ≥80% line coverage.
    //
    // Branches/functions/statements deliberately omitted: the unit tier
    // owns those at the unit level; integration focuses on line coverage
    // of in-process seams only.
    coverage: {
      provider: "v8",
      reporter: ["text", "json"],
      // Keep this collector isolated from the unit tier so independently
      // invoked validation commands cannot delete each other's temp files.
      reportsDirectory: "coverage/integration",
      include: ["packages/*/dist/**/*.js"],
      exclude: [
        "**/*.test.js",
        "**/__tests__/**",
        "**/__snapshots__/**",
        "**/*.d.ts",
        "**/*.d.js",
        "**/*.generated.js",
        "packages/web/dist/**",
      ],
      thresholds: {
        // Math.floor(35.81) = 35. Locks in forward gain.
        lines: 35,
      },
    },
  },
});
