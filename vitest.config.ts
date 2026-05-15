import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [],
    // Phase 40 / Plan 40-09 / COV-15: test/e2e is the wire-level
    // end-to-end project — spawns real daemons against 127.0.0.1 mock
    // chat-platform servers. Has its own vitest.config.ts (no coverage
    // thresholds; e2e tier owns its own scope per AGENTS.md §2.5).
    projects: ["packages/*", "test/architecture", "test/e2e", "scripts/contracts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      // Phase 40 COV-01 / design §3.5: measurement scope is production source only.
      include: ["packages/*/src/**/*.ts"],
      // Phase 40 COV-01 / design §3.5 exclusion list (verbatim):
      exclude: [
        "**/*.test.ts",
        "**/__tests__/**",
        "**/__snapshots__/**",
        "**/dist/**",
        "**/*.d.ts",
        "**/*.generated.ts",
        "packages/web/src/**/*.css.ts",
        "packages/web/src/api/contracts.generated.ts",
      ],
      // Phase 40 COV-05 monotonic ramp protocol: per-package floors derived from
      // baseline JSON captured under .planning/code-quality/coverage-baseline-<date>/.
      // Plan 40-07 (Cohort 2) ramps each floor toward the final 90/85/90/90 target.
      // NOTE: integration-tier coverage (`pnpm test:integration --coverage`) measures
      // in-process imports only — subprocess daemon code is the E2E tier's territory.
      //
      // COV-03 / COV-05: per-package floor thresholds — Math.floor(measured) so the
      // floor is strictly ≤ measured (no off-by-one fail on first run). Baseline
      // captured 2026-05-15 (Phase 40 Wave 0); see
      // .planning/code-quality/coverage-baseline-2026-05-15/README.md for the
      // measured-vs-floor table. The `comis` umbrella package (re-export-only,
      // no test files) is intentionally floored at 0/0/0/0 — no enforcement.
      thresholds: {
        "packages/shared/src/**/*.ts":       { lines: 97, branches: 92, functions: 96,  statements: 97 },
        "packages/core/src/**/*.ts":         { lines: 91, branches: 79, functions: 91,  statements: 91 },
        "packages/infra/src/**/*.ts":        { lines: 97, branches: 95, functions: 100, statements: 97 },
        "packages/memory/src/**/*.ts":       { lines: 95, branches: 85, functions: 96,  statements: 95 },
        "packages/skills/src/**/*.ts":       { lines: 90, branches: 81, functions: 91,  statements: 90 },
        "packages/agent/src/**/*.ts":        { lines: 88, branches: 79, functions: 87,  statements: 88 },
        "packages/channels/src/**/*.ts":     { lines: 82, branches: 70, functions: 85,  statements: 82 },
        "packages/cli/src/**/*.ts":          { lines: 71, branches: 62, functions: 73,  statements: 71 },
        "packages/scheduler/src/**/*.ts":    { lines: 96, branches: 88, functions: 98,  statements: 96 },
        "packages/orchestrator/src/**/*.ts": { lines: 93, branches: 81, functions: 92,  statements: 92 },
        "packages/daemon/src/**/*.ts":       { lines: 73, branches: 61, functions: 73,  statements: 73 },
        "packages/gateway/src/**/*.ts":      { lines: 80, branches: 69, functions: 84,  statements: 80 },
        "packages/web/src/**/*.ts":          { lines: 55, branches: 45, functions: 48,  statements: 55 },
        "packages/comis/src/**/*.ts":        { lines: 0,  branches: 0,  functions: 0,   statements: 0  },
      },
    },
  },
});
