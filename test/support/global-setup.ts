/**
 * Vitest globalSetup: automatic cleanup of test-generated artifacts.
 *
 * Exports named `setup()` and `teardown()` functions called by Vitest's
 * globalSetup lifecycle. Both call the same cleanup logic so that:
 * - setup() ensures tests start clean even if a previous run crashed
 * - teardown() removes artifacts after all tests complete
 *
 * Cleanup targets:
 * 1. ~/.comis/*.db files with "test" in the name (+ WAL/SHM companions)
 * 2. ~/.comis/workspace-{alpha,beta,helper}/ (named agent workspaces)
 * 3. ~/.comis/workspace/.scheduler/ (cron-jobs, execution logs)
 * 4. ~/.comis/workspace/ test artifacts (preserves .git/ and identity .md files)
 * 5. test/.test-results.json (orchestrate.ts output)
 *
 * Safety: NEVER deletes identity/, models/, .env, or workspace/ identity files.
 * Uses allowlist (WORKSPACE_PRESERVED) so only known system files are kept.
 *
 * @module
 */

import { rmSync, readdirSync, existsSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const COMIS_DIR = join(homedir(), ".comis");

/** Named agent workspace directories created by test configs. */
const TEST_AGENT_WORKSPACES = [
  "workspace-alpha",
  "workspace-beta",
  "workspace-helper",
];

/** Vitest JSON results file produced by orchestrate.ts. */
const TEST_RESULTS_FILE = resolve(__dirname, "../.test-results.json");

// ---------------------------------------------------------------------------
// Shared cleanup logic
// ---------------------------------------------------------------------------

/**
 * Remove all test-generated artifacts from ~/.comis/ and test/.
 *
 * Best-effort: never throws. All file operations are wrapped in try/catch
 * so cleanup cannot break the test run.
 */
function cleanTestArtifacts(): void {
  // If ~/.comis does not exist, nothing to clean
  if (!existsSync(COMIS_DIR)) {
    return;
  }

  // 1. Remove test database files (test-*.db + WAL/SHM companions)
  try {
    const entries = readdirSync(COMIS_DIR);
    for (const entry of entries) {
      const isTestDb =
        (entry.startsWith("test-") && entry.endsWith(".db")) ||
        (entry.endsWith(".db") && entry.includes("test"));
      if (isTestDb) {
        const dbPath = join(COMIS_DIR, entry);
        for (const suffix of ["", "-wal", "-shm"]) {
          try {
            unlinkSync(dbPath + suffix);
          } catch {
            // File may not exist (WAL/SHM already cleaned by db-cleanup.ts)
          }
        }
      }
    }
  } catch {
    // Best-effort: directory read may fail
  }

  // 2. Remove test-only named agent workspace directories
  for (const wsDir of TEST_AGENT_WORKSPACES) {
    try {
      rmSync(join(COMIS_DIR, wsDir), { recursive: true, force: true });
    } catch {
      // Best-effort
    }
  }

  // 3. Clean scheduler artifacts from default workspace
  try {
    rmSync(join(COMIS_DIR, "workspace", ".scheduler"), {
      recursive: true,
      force: true,
    });
  } catch {
    // Best-effort
  }

  // 4. Clean test-generated files from default workspace
  //    Preserves: .git/, identity .md files, .scheduler/ (cleaned separately above)
  const WORKSPACE_PRESERVED = new Set([
    ".git",
    ".scheduler", // Already handled in section 3
    "AGENTS.md",
    "SOUL.md",
    "IDENTITY.md",
    "BOOTSTRAP.md",
    "HEARTBEAT.md",
    "TOOLS.md",
    "USER.md",
  ]);

  try {
    const workspaceDir = join(COMIS_DIR, "workspace");
    if (existsSync(workspaceDir)) {
      const wsEntries = readdirSync(workspaceDir);
      for (const entry of wsEntries) {
        if (WORKSPACE_PRESERVED.has(entry)) continue;
        try {
          rmSync(join(workspaceDir, entry), { recursive: true, force: true });
        } catch {
          // Best-effort
        }
      }
    }
  } catch {
    // Best-effort: directory read may fail
  }

  // 5. Clean up Vitest JSON results file
  try {
    unlinkSync(TEST_RESULTS_FILE);
  } catch {
    // File may not exist
  }
}

// ---------------------------------------------------------------------------
// Vitest globalSetup exports
// ---------------------------------------------------------------------------

/**
 * Called before test workers are created.
 * Cleans stale artifacts from previous runs (crash recovery).
 */
export function setup(): void {
  cleanTestArtifacts();
}

/**
 * Called after all test files finish.
 * Removes artifacts generated during this test run.
 */
export function teardown(): void {
  cleanTestArtifacts();
}
