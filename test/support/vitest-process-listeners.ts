// SPDX-License-Identifier: Apache-2.0
/**
 * Vitest setupFiles hook — raises the per-process `MaxListeners` ceiling
 * for `unhandledRejection`/`uncaughtException`/etc.
 *
 * **Why:** vitest 4.x's `pool: "forks"` (default) reuses a worker process
 * for many test files. Some libraries (better-sqlite3 connection close
 * hooks, Pino transport workers, node-llama-cpp, etc.) register
 * `process.on("unhandledRejection", …)` listeners on import. Across the
 * 100+ daemon test files routed through one worker, the listener count
 * exceeds Node's default 10 and the worker emits a
 * `MaxListenersExceededWarning`. The follow-on symptom is that the worker
 * fails to terminate cleanly at the configured `teardownTimeout` — vitest
 * then reports `[vitest-pool]: Worker forks emitted error / Worker exited
 * unexpectedly` even though every test in the file passed.
 *
 * **What this does:** raises the ceiling for the vitest-worker process to
 * 50 listeners (5× headroom over the typical accumulation). This is a
 * tooling fix at the worker boundary; production code paths are unchanged.
 *
 * **What this does NOT do:** find and unregister the root-cause listeners.
 * A proper fix would identify which library leaks and either fix it
 * upstream or wrap its import with a cleanup hook. This file is the
 * minimum mitigation that unblocks `pnpm test`/`pnpm test:integration` on
 * the daemon test suite.
 *
 * Wired via `setupFiles: [...]` in every vitest config that runs daemon
 * tests (root workspace + per-package).
 *
 * @module
 */

process.setMaxListeners(50);
