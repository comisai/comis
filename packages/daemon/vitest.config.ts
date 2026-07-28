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
    // Several suites here call `main()` and boot a REAL daemon against a
    // per-worker temp data dir: workspace bootstrap (9 starter files + subdirs
    // + `git init`), SQLite open, watcher registration. That is genuine work
    // vitest's 5s default was never sized for -- an isolated boot measures
    // ~0.6-1.3s, and the coverage-instrumented run multiplies it several-fold.
    //
    // This budget covers real work only. It is NOT covering for the
    // boot-over-boot slowdown that used to live here: `dispose()` leaked the
    // SIGUSR2/exit/unhandled/uncaught listeners, each pinning its whole daemon
    // activation, so every boot retained the previous one (RSS 858MB -> 2.5GB
    // across six boots). That is fixed in setup-shutdown.ts and guarded by
    // "setupShutdown process-listener ownership"; raising a timeout instead
    // would have hidden a live memory leak.
    testTimeout: 30000,
    hookTimeout: 30000,
    teardownTimeout: 60000,
  },
});
