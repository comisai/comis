import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [],
    projects: ["packages/*", "test/architecture", "scripts/contracts"],
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
      // Thresholds are wired in Task 3 once the baseline is captured.
    },
  },
});
