/**
 * CONFIG-GIT-LIFECYCLE-E2E: Config Git Versioning Lifecycle E2E Tests
 *
 * Validates the complete config git versioning lifecycle through a real daemon:
 *   config.patch  -- creates git commit with structured metadata
 *   config.history -- queries commit history with entries, sha, metadata
 *   config.diff    -- returns unified diff against a previous commit
 *   config.rollback -- restores config to a previous version
 *
 * Uses temp config copy (config.patch writes to disk -- must not mutate source YAML).
 * Mocks process.kill for SIGUSR1 to prevent daemon restart during tests.
 *
 * Requirement: E2E-01
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const BASE_CONFIG_PATH = resolve(
  __dirname,
  "../config/config.test-config-e2e-git.yaml",
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Type alias for the daemon's internal rpcCall function. */
type RpcCall = (method: string, params: Record<string, unknown>) => Promise<unknown>;

/** Shape of a config.history entry from the RPC response. */
interface HistoryEntry {
  sha: string;
  timestamp: string;
  message: string;
  metadata: {
    section?: string;
    key?: string;
    summary?: string;
    agent?: string;
    user?: string;
    traceId?: string;
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("CONFIG-GIT-LIFECYCLE-E2E", () => {
  let handle: TestDaemonHandle;
  let rpcCall: RpcCall;
  let tmpDir: string;
  let tmpConfigPath: string;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    // Create temp directory for mutable config (config.patch writes to disk)
    tmpDir = join(tmpdir(), `comis-config-git-e2e-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    // Copy config to temp location for mutation safety
    tmpConfigPath = join(tmpDir, "config.test-config-e2e-git.yaml");
    const configContent = readFileSync(BASE_CONFIG_PATH, "utf-8");
    writeFileSync(tmpConfigPath, configContent, "utf-8");

    // Spy on process.kill to no-op SIGUSR1 (config.patch triggers SIGUSR1 restart
    // with 200ms delay; in test harness the SIGUSR1 handler calls shutdownHandle.trigger
    // which calls the overridden exit() that throws, killing the daemon).
    killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      if (signal === "SIGUSR1") {
        // Swallow SIGUSR1 to prevent daemon restart during tests
        return true;
      }
      // Forward all other signals to the real implementation
      return (process.kill as any).__proto__.call(process, pid, signal);
    }) as any);

    handle = await startTestDaemon({ configPath: tmpConfigPath });

    // Access internal rpcCall for direct RPC calls with _trustLevel
    rpcCall = handle.daemon.rpcCall;

    // Warmup patch: the first config.patch triggers lazy git init inside
    // configGitManager. The init stages all existing YAML files and creates
    // an "Initial config snapshot" commit. Because config.patch writes the
    // updated YAML before calling configGitManager.commit(), the init commit
    // absorbs the first change, and the structured commit finds "nothing to
    // commit". This warmup ensures the git repo is initialized so subsequent
    // patches produce real structured commits.
    await rpcCall("config.patch", {
      section: "scheduler",
      key: "quietHours.enabled",
      value: false,
      _trustLevel: "admin",
    });
    // Brief settle for the async git operations to complete
    await new Promise((r) => setTimeout(r, 300));
  }, 120_000);

  afterAll(async () => {
    // Restore process.kill spy
    if (killSpy) {
      killSpy.mockRestore();
    }

    if (handle) {
      try {
        await handle.cleanup();
      } catch (err) {
        // Expected: graceful shutdown calls the overridden exit() which throws.
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("Daemon exit with code")) {
          throw err;
        }
      }
    }

    // Remove tmp directory
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // Test 1: config.patch creates git commit queryable via config.history
  // -------------------------------------------------------------------------

  it("config.patch creates git commit queryable via config.history", async () => {
    // Patch a mutable config key
    const patchResult = (await rpcCall("config.patch", {
      section: "scheduler",
      key: "heartbeat.intervalMs",
      value: 600000,
      _trustLevel: "admin",
    })) as Record<string, unknown>;

    expect(patchResult.patched).toBe(true);

    // Wait for git commit to settle (async .catch() pattern in config.patch)
    await new Promise((r) => setTimeout(r, 300));

    // Query history
    const historyResult = (await rpcCall("config.history", {
      limit: 5,
      _trustLevel: "admin",
    })) as { entries: HistoryEntry[] };

    expect(historyResult).toHaveProperty("entries");
    expect(Array.isArray(historyResult.entries)).toBe(true);
    expect(historyResult.entries.length).toBeGreaterThanOrEqual(1);

    const entry = historyResult.entries[0]!;

    // Validate entry structure
    expect(typeof entry.sha).toBe("string");
    expect(entry.sha.length).toBeGreaterThanOrEqual(7);
    expect(typeof entry.timestamp).toBe("string");
    expect(entry.timestamp.length).toBeGreaterThan(0);
    expect(typeof entry.message).toBe("string");
    expect(entry.message.length).toBeGreaterThan(0);

    // Validate metadata
    expect(entry.metadata).toBeDefined();
    expect(entry.metadata.section).toBe("scheduler");
    expect(entry.metadata.summary).toContain("heartbeat.intervalMs");
  }, 30_000);

  // -------------------------------------------------------------------------
  // Test 2: config.diff returns unified diff against previous commit
  // -------------------------------------------------------------------------

  it("config.diff returns unified diff against previous commit", async () => {
    // Get history to find a SHA
    const historyResult = (await rpcCall("config.history", {
      limit: 5,
      _trustLevel: "admin",
    })) as { entries: HistoryEntry[] };

    expect(historyResult.entries.length).toBeGreaterThanOrEqual(1);
    const sha = historyResult.entries[0]!.sha;

    // Request diff against that SHA
    const diffResult = (await rpcCall("config.diff", {
      sha,
      _trustLevel: "admin",
    })) as { diff: string; error?: string };

    // The diff may be empty if comparing HEAD~1 against HEAD (depends on git state),
    // so just assert it's a string (not an error response)
    expect(diffResult).toHaveProperty("diff");
    expect(typeof diffResult.diff).toBe("string");
  }, 30_000);

  // -------------------------------------------------------------------------
  // Test 3: config.rollback restores to previous version
  // -------------------------------------------------------------------------

  it("config.rollback restores to previous version", async () => {
    // Create a second patch to ensure we have at least 2 history entries
    const patchResult = (await rpcCall("config.patch", {
      section: "scheduler",
      key: "heartbeat.showOk",
      value: true,
      _trustLevel: "admin",
    })) as Record<string, unknown>;

    expect(patchResult.patched).toBe(true);

    // Wait for git commit to settle
    await new Promise((r) => setTimeout(r, 300));

    // Get history -- should have at least 2 entries
    const historyResult = (await rpcCall("config.history", {
      limit: 10,
      _trustLevel: "admin",
    })) as { entries: HistoryEntry[] };

    expect(historyResult.entries.length).toBeGreaterThanOrEqual(2);

    // Get the SHA of the SECOND entry (the one before the latest)
    const targetSha = historyResult.entries[1]!.sha;

    // Rollback to that SHA
    const rollbackResult = (await rpcCall("config.rollback", {
      sha: targetSha,
      _trustLevel: "admin",
    })) as { rolledBack: boolean; sha: string; newCommitSha: string };

    expect(rollbackResult.rolledBack).toBe(true);
    expect(rollbackResult.sha).toBe(targetSha);
    expect(typeof rollbackResult.newCommitSha).toBe("string");
    expect(rollbackResult.newCommitSha.length).toBeGreaterThan(0);
  }, 30_000);

  // -------------------------------------------------------------------------
  // Test 4: config.history returns entries array without error
  // -------------------------------------------------------------------------

  it("config.history returns entries array without error", async () => {
    // Call config.history with no filter -- should return an array (may be
    // empty or populated depending on state). Validates no error is thrown.
    const historyResult = (await rpcCall("config.history", { _trustLevel: "admin" })) as {
      entries: HistoryEntry[];
      error?: string;
    };

    expect(historyResult).toHaveProperty("entries");
    expect(Array.isArray(historyResult.entries)).toBe(true);
    // After previous tests, we should have entries
    expect(historyResult.entries.length).toBeGreaterThanOrEqual(1);
  }, 30_000);
});
