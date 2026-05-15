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
      // Three skills subpath entries (per SKILLS-SPLIT-03; Phase 33).
      // ORDER MATTERS: Vite alias matching is prefix-based with `/` separator
      // semantics, so the most-specific subpaths MUST come BEFORE the bare
      // `@comis/skills` alias -- otherwise `@comis/skills/tools` would be
      // matched as bare-prefix + `/tools` and routed to the `.` subpath
      // target. Surfaced in Phase 33 Plan 03 when daemon's setup-tools.ts
      // started importing from `@comis/skills/tools` (Rule 3 fix).
      "@comis/skills/platform-tools": resolve(packages, "skills/dist/platform-tools/index.js"),
      "@comis/skills/tools": resolve(packages, "skills/dist/tools/index.js"),
      "@comis/skills": resolve(packages, "skills/dist/skills/index.js"),
      "@comis/orchestrator": resolve(packages, "orchestrator/dist/index.js"),
      "@comis/cli": resolve(packages, "cli/dist/index.js"),
    },
  },
  test: {
    globalSetup: ["./test/support/global-setup.ts"],
    include: ["test/support/**/*.test.ts", "test/integration/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    teardownTimeout: 30_000,
    pool: "forks",
    maxConcurrency: 1,
    retry: 1,
    env: {
      // Repo root, exposed to test daemon configs as ${COMIS_REPO_ROOT}.
      // Replaces hardcoded ${HOME}/Projects/comisai/comis in test-only YAMLs
      // so the integration suite is portable across CI runners, worktrees,
      // and contributor checkouts.
      COMIS_REPO_ROOT: resolve(__dirname, ".."),
    },
    // Phase 40 COV-04: integration-tier coverage threshold.
    //
    // Measures in-process imports the integration suite actually loads —
    // `packages/*/dist/**/*.js` (the alias targets above). Subprocess daemon
    // code is NOT measured here; that is the E2E tier's territory (Plan 40-09).
    //
    // Floor: Math.floor(measured) — same Math.floor protocol as the unit
    // tier (COV-03). The §3.5 aspirational target is ≥80% line coverage.
    //
    // Ramp history (most recent first):
    //   - Plan 40-16-ramp1 (Path B): 34 → 35. Math.floor(measured=35.81)
    //     after Plan 40-16 Tasks 1–4 added 19 new integration test files
    //     across channels, cli, daemon, scheduler, skills, memory, agent,
    //     orchestrator (1604 tests total vs. 1494 baseline). The §3.5
    //     ≥80% target requires walking hundreds more code paths and is
    //     bottlenecked by huge untested swaths in `skills/integrations/`
    //     and `skills/tools/` whose v8 line counts dominate the gap. The
    //     ramp is monotonic-forward; further closure is deferred to a
    //     follow-on plan. Audit trail:
    //     `.planning/code-quality/coverage-ramp-2026-05-15/ramp-history.json`
    //     (integration_tier section, closure_type: "partial",
    //     residual_gap: 45pp).
    //   - Plan 40-07: wired the floor at lines=34 (Math.floor(34.64)).
    //
    // Branches/functions/statements deliberately omitted: the unit tier
    // (COV-03) owns those at the unit level; integration focuses on
    // line coverage of in-process seams only.
    coverage: {
      provider: "v8",
      reporter: ["text", "json"],
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
        // Plan 40-16-ramp1 (Path B): Math.floor(35.81) = 35. Locks in
        // forward gain from Tasks 1–4; residual 45pp deferred.
        lines: 35,
      },
    },
  },
});
