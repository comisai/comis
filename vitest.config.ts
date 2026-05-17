import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [],
    // test/e2e is the wire-level end-to-end project — opt-in via
    // `pnpm test:e2e` (it uses its own vitest.config.ts and imports
    // adapter SDKs that are not hoisted to the repo root, so it cannot
    // run from the default `pnpm test` invocation in a clean install).
    projects: ["packages/*", "test/architecture", "scripts/contracts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      // Measurement scope is production source only.
      include: ["packages/*/src/**/*.ts"],
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
      // Monotonic ramp protocol: per-package floors are derived from a
      // measured baseline and ramp each floor toward the final
      // 90/85/90/90 target. NOTE: integration-tier coverage
      // (`pnpm test:integration --coverage`) measures in-process imports
      // only — subprocess daemon code is the E2E tier's territory.
      //
      // Per-package floor thresholds — Math.floor(measured) so the floor
      // is strictly ≤ measured (no off-by-one fail on first run). The
      // `comis` umbrella package (re-export-only, no test files) is
      // intentionally floored at 0/0/0/0 — no enforcement.
      thresholds: {
        "packages/shared/src/**/*.ts":       { lines: 97, branches: 92, functions: 96,  statements: 97 },
        "packages/core/src/**/*.ts":         { lines: 91, branches: 79, functions: 91,  statements: 91 },
        "packages/infra/src/**/*.ts":        { lines: 97, branches: 95, functions: 100, statements: 97 },
        "packages/memory/src/**/*.ts":       { lines: 95, branches: 79, functions: 96,  statements: 94 },
        "packages/skills/src/**/*.ts":       { lines: 90, branches: 81, functions: 91,  statements: 90 },
        "packages/agent/src/**/*.ts":        { lines: 88, branches: 79, functions: 87,  statements: 88 },
        "packages/channels/src/**/*.ts":     { lines: 87, branches: 76, functions: 90,  statements: 87 },
        "packages/cli/src/**/*.ts":          { lines: 74, branches: 65, functions: 74,  statements: 73 },
        "packages/scheduler/src/**/*.ts":    { lines: 96, branches: 88, functions: 98,  statements: 96 },
        "packages/orchestrator/src/**/*.ts": { lines: 93, branches: 81, functions: 92,  statements: 92 },
        "packages/daemon/src/**/*.ts":       { lines: 78, branches: 65, functions: 75,  statements: 77 },
        "packages/gateway/src/**/*.ts":      { lines: 85, branches: 75, functions: 86,  statements: 84 },
        "packages/web/src/**/*.ts":          { lines: 62, branches: 52, functions: 54,  statements: 62 },
        "packages/comis/src/**/*.ts":        { lines: 0,  branches: 0,  functions: 0,   statements: 0  },
      },
    },
  },
});
