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

// ---------------------------------------------------------------------------
// Test-isolation sandbox env injection (Fix A — log-review)
//
// Under VITEST=true, redirect Comis's filesystem read/writes to a
// per-worker tmpdir so test code can't touch the user's ~/.comis/. This
// is the SETUP-FILE half of a two-layer guard:
//   1. (here) Set sandbox env vars before any production code reads them.
//   2. (in daemon.ts / rpc-client.ts) Hard-throw if a test bypasses the
//      setup file (e.g., a per-package vitest config without setupFiles)
//      so the leak surfaces as a test failure, not silent ~/.comis/ writes.
//
// Idempotent: existing env wins. Tests that NEED the real ~/.comis/ path
// must set the env var explicitly in their own `beforeAll` — we never
// overwrite.
//
// Cleanup: registered via `process.on("exit")` (fires once per worker
// process at teardown). `rmSync(..., { force: true })` swallows ENOENT
// so a tmpdir already cleaned by a prior hook is not an error.
// ---------------------------------------------------------------------------

if (process.env["VITEST"] === "true") {
  // Lazy import — keep this file dependency-free at module-load time so a
  // sibling `setupFiles` ordering bug doesn't block the listener bump.
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- setup file runs before vitest's ESM loader fully initializes; sync require keeps the env injection ordered before any test module's top-level imports
  const { mkdtempSync, rmSync } = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("node:path") as typeof import("node:path");

  const sandboxDir = mkdtempSync(join(tmpdir(), "comis-vitest-"));

  if (!process.env["COMIS_CONFIG_PATHS"]) {
    // Point at a NON-EXISTENT path inside the sandbox dir. daemon.ts's
    // `.filter((p) => existsSync(p))` drops missing paths, producing an
    // empty configPaths array — bootstrap then uses schema defaults only.
    // This proves we never read ~/.comis/config.yaml from a test process.
    process.env["COMIS_CONFIG_PATHS"] = join(sandboxDir, "config.yaml");
  }
  if (!process.env["COMIS_CONFIG_AUDIT_LOG"]) {
    process.env["COMIS_CONFIG_AUDIT_LOG"] = join(sandboxDir, "config-audit.jsonl");
  }
  if (!process.env["COMIS_DATA_DIR"]) {
    process.env["COMIS_DATA_DIR"] = sandboxDir;
  }

  process.on("exit", () => {
    try {
      rmSync(sandboxDir, { recursive: true, force: true });
    } catch {
      // Sandbox already gone — nothing to do.
    }
  });
}
