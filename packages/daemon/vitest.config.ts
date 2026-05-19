// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    passWithNoTests: true,
    // Daemon tests stay on the default `pool: "forks"` — necessary
    // because tests call `process.kill(pid, "SIGUSR2")` (real or
    // mocked) and `pool: "threads"` would route the signal to the
    // shared vitest parent process, killing the runner. The
    // `vi.clearAllTimers()` discipline in test afterEach blocks (see
    // config-handlers.test.ts) prevents a pending fake-timer 200ms
    // SIGUSR2 restart timer from migrating to the real-timer queue
    // after `vi.restoreAllMocks()` runs (the prior worker-exit symptom).
    // setupFiles raises MaxListeners to suppress the cosmetic warning
    // from accumulating `process.on(...)` listeners across many test
    // files in one forked worker.
    setupFiles: ["../../test/support/vitest-process-listeners.ts"],
    teardownTimeout: 60000,
    // `isolate: false` shares the module cache across test files within
    // one forked worker. Modules that register `process.on(...)`
    // listeners at module-load time then register ONCE per fork (not
    // once per file). The combined effect with the
    // `vi.clearAllTimers()` discipline (config-handlers.test.ts
    // afterEach) is that no test file's residual state can keep its
    // worker fork alive past the teardown window.
    poolOptions: {
      forks: {
        isolate: false,
      },
    },
  },
});
