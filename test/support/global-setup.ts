// SPDX-License-Identifier: Apache-2.0
/**
 * Vitest globalSetup: automatic cleanup of test-generated artifacts.
 *
 * Exports named `setup()` and `teardown()` functions called by Vitest's
 * globalSetup lifecycle. Both call the same cleanup logic so that:
 * - setup() ensures tests start clean even if a previous run crashed
 * - teardown() removes artifacts after all tests complete while preserving
 *   the JSON report that the orchestrator consumes
 *
 * Cleanup targets:
 * 1. test/.test-results.json (orchestrate.ts output)
 * 2. test/config/.git and test/config/.gitignore
 *
 * Safety: never reads or writes the operator's ~/.comis data directory.
 * Tests own their temporary data directories and clean them at their creation
 * sites, where the exact disposable path is known.
 *
 * @module
 */

import { rmSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { ensureSharedModelCache } from "./model-cache.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Vitest JSON results file produced by orchestrate.ts. */
const TEST_RESULTS_FILE = resolve(__dirname, "../.test-results.json");

/**
 * Test config directory used as configDir by the test daemon.
 *
 * The daemon's git-manager creates a nested config-history repo here on
 * first commit (see packages/core/src/config/git-manager.ts:initRepo).
 * Without cleanup the nested .git and its .gitignore linger between
 * runs, dirtying the outer working tree.
 */
const TEST_CONFIG_DIR = resolve(__dirname, "../config");

// ---------------------------------------------------------------------------
// Shared cleanup logic
// ---------------------------------------------------------------------------

/**
 * Remove repository-owned test artifacts.
 *
 * Best-effort: never throws. All file operations are wrapped in try/catch
 * so cleanup cannot break the test run.
 */
function cleanTestArtifacts(removeResultsFile: boolean): void {
  // 1. Clean up a stale Vitest JSON results file before a run. The current
  //    run's report must survive teardown so orchestrate.ts can consume it.
  if (removeResultsFile) {
    try {
      unlinkSync(TEST_RESULTS_FILE);
    } catch {
      // File may not exist
    }
  }

  // 2. Clean up nested config-history repo created by the test daemon
  //    in test/config/. Without this, the .git/ and .gitignore linger
  //    between runs (and the daemon's gitignore template un-ignores
  //    *.yaml, which makes *.last-good.yaml show as untracked in the
  //    outer repo via most-specific-gitignore-wins).
  //
  //    NOTE: test/config/.gitignore is a daemon ARTIFACT (written by
  //    git-manager.ts initRepo from GITIGNORE_CONTENT), not a source
  //    file — it is intentionally untracked and outer-ignored (see the
  //    root .gitignore `test/config/.gitignore` entry). Do NOT re-add it
  //    to git: a tracked copy turns this best-effort delete into a dirty
  //    working tree on every cleanup, which is what caused the #129/#130
  //    "accidentally deleted → restore" loop.
  for (const entry of [".git", ".gitignore"]) {
    try {
      rmSync(join(TEST_CONFIG_DIR, entry), { recursive: true, force: true });
    } catch {
      // Best-effort
    }
  }
}

// ---------------------------------------------------------------------------
// Vitest globalSetup exports
// ---------------------------------------------------------------------------

/**
 * Called before test workers are created.
 * Cleans stale artifacts from previous runs (crash recovery).
 */
export async function setup(): Promise<void> {
  cleanTestArtifacts(true);
  // Pre-seed the shared embedding-model cache ONCE so per-fork daemon boots
  // hard-link it (via seedModelCache) instead of each downloading the ~635 MB
  // GGUF in parallel — the cause of the chronic CI "Hook timed out" failures.
  await ensureSharedModelCache();
}

/**
 * Called after all test files finish.
 * Removes artifacts generated during this test run.
 */
export function teardown(): void {
  cleanTestArtifacts(false);
}
