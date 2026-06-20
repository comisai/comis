import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [],
    // test/e2e is the wire-level end-to-end project — opt-in via
    // `pnpm test:e2e` (it uses its own vitest.config.ts and imports
    // adapter SDKs that are not hoisted to the repo root, so it cannot
    // run from the default `pnpm test` invocation in a clean install).
    projects: ["packages/*", "test/architecture", "scripts/contracts"],
    // Forked workers reuse one process across many test files. Libraries
    // (better-sqlite3, Pino transports, node-llama-cpp, ...) that register
    // `process.on("unhandledRejection", ...)` on import accumulate listeners
    // until Node fires `MaxListenersExceededWarning`, after which the worker
    // fails to terminate at teardown. Setup file raises the ceiling; the
    // teardown bump gives slow disposal paths room to drain. Neither
    // changes any production code path.
    setupFiles: ["./test/support/vitest-process-listeners.ts"],
    teardownTimeout: 30000,
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
        // Forked PROCESS entry (`node terminal-worker-main.js`): main() wires real
        // process stdin/stdout/fd3/exit, which cannot be unit-tested in-process
        // (attaching to the runner's stdin / calling process.exit would corrupt it).
        // Its pure helpers ARE unit-tested (terminal-worker-main.test.ts) and the real
        // fork is exercised by terminal-worker-fork.linux.test.ts on Linux/the VPS.
        "packages/skills/src/tools/builtin/terminal-driver/terminal-worker-main.ts",
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
        "packages/shared/src/**/*.ts":       { lines: 97, branches: 91, functions: 96,  statements: 97 },
        "packages/core/src/**/*.ts":         { lines: 91, branches: 79, functions: 91,  statements: 91 },
        "packages/infra/src/**/*.ts":        { lines: 95, branches: 92, functions: 100, statements: 95 },
        "packages/memory/src/**/*.ts":       { lines: 94, branches: 78, functions: 96,  statements: 94 },
        "packages/skills/src/**/*.ts":       { lines: 90, branches: 81, functions: 91,  statements: 90 },
        "packages/agent/src/**/*.ts":        { lines: 88, branches: 79, functions: 87,  statements: 88 },
        "packages/channels/src/**/*.ts":     { lines: 87, branches: 76, functions: 90,  statements: 86 },
        "packages/cli/src/**/*.ts":          { lines: 73, branches: 63, functions: 73,  statements: 72 },
        "packages/scheduler/src/**/*.ts":    { lines: 96, branches: 87, functions: 97,  statements: 96 },
        "packages/orchestrator/src/**/*.ts": { lines: 93, branches: 81, functions: 92,  statements: 92 },
        "packages/observability-otel/src/**/*.ts": { lines: 90, branches: 64, functions: 100, statements: 89 },
        "packages/daemon/src/**/*.ts":       { lines: 78, branches: 65, functions: 74,  statements: 77 },
        "packages/gateway/src/**/*.ts":      { lines: 85, branches: 75, functions: 86,  statements: 84 },
        "packages/web/src/**/*.ts":          { lines: 59, branches: 49, functions: 53,  statements: 60 },
        "packages/comis/src/**/*.ts":        { lines: 0,  branches: 0,  functions: 0,   statements: 0  },
      },
    },
  },
});
