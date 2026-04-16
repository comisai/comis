/**
 * CONFIG-APPLY-E2E: Config Apply Full Section Replacement E2E Tests
 *
 * Validates config.apply full section replacement lifecycle (E2E-06):
 *   - Replaces entire scheduler section atomically (not deep merge)
 *   - Passes through the same safety pipeline as config.patch (trust, rate limit, restart)
 *   - Non-admin trust level is rejected
 *   - Immutable sections are rejected
 *   - Triggers SIGUSR1 restart after apply
 *   - Produces git history entry with "Replaced" metadata
 *
 * Uses a temp config copy, real daemon, and internal rpcCall.
 * Spies on process.kill to no-op SIGUSR1 signals (prevents daemon restart mid-test).
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
  "../config/config.test-config-e2e-apply.yaml",
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Type alias for the daemon's internal rpcCall function. */
type RpcCall = (method: string, params: Record<string, unknown>) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("CONFIG-APPLY-E2E: Config Apply Full Section Replacement", () => {
  let handle: TestDaemonHandle;
  let rpcCall: RpcCall;
  let tmpDir: string;
  let tmpConfigPath: string;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    // Create temp directory for mutable config (config.apply writes to disk)
    tmpDir = join(tmpdir(), `comis-config-apply-e2e-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    // Copy config to temp location for mutation safety
    tmpConfigPath = join(tmpDir, "config.test-config-e2e-apply.yaml");
    const configContent = readFileSync(BASE_CONFIG_PATH, "utf-8");
    writeFileSync(tmpConfigPath, configContent, "utf-8");

    // Spy on process.kill to no-op SIGUSR1 signals (prevents daemon restart mid-test)
    killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      if (signal === "SIGUSR1") {
        // No-op: suppress restart signal during tests
        return true;
      }
      // Pass through other signals to the real implementation
      return process.kill.call(process, pid, signal as string);
    }) as typeof process.kill);

    // Start daemon with tmp config
    handle = await startTestDaemon({ configPath: tmpConfigPath });

    // Access internal rpcCall from daemon instance
    rpcCall = (handle.daemon as any).rpcCall as RpcCall;

    // Warmup: Force git repo initialization BEFORE any config mutations.
    // ConfigGitManager lazily initializes the git repo on first operation.
    // If the first operation is config.apply (which writes YAML before calling commit),
    // the initial git commit captures the already-modified file, leaving nothing for
    // the apply commit. A warmup config.patch triggers git init AND creates a structured
    // commit, ensuring subsequent operations produce distinct commits.
    await rpcCall("config.patch", {
      section: "scheduler",
      key: "quietHours.criticalBypass",
      value: true,
      _trustLevel: "admin",
    });
    // Wait for git repo initialization + warmup commit to complete
    await new Promise((r) => setTimeout(r, 500));
  }, 120_000);

  afterAll(async () => {
    // Restore process.kill spy
    if (killSpy) {
      killSpy.mockRestore();
    }

    // Cleanup daemon
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
  // Test 1: config.apply replaces entire scheduler section atomically
  // -------------------------------------------------------------------------

  it(
    "config.apply replaces entire scheduler section atomically",
    async () => {
      // 1. Read current scheduler config to verify baseline
      const currentScheduler = (await rpcCall("config.read", {
        section: "scheduler",
        _trustLevel: "admin",
      })) as Record<string, unknown>;

      const currentCron = currentScheduler.cron as Record<string, unknown>;
      const currentHeartbeat = currentScheduler.heartbeat as Record<string, unknown>;
      expect(currentCron.enabled).toBe(true);
      expect(currentHeartbeat.intervalMs).toBe(300000);

      // 2. Apply full section replacement with different values
      const result = (await rpcCall("config.apply", {
        section: "scheduler",
        value: {
          cron: {
            enabled: true,
            maxConcurrentRuns: 3,
            defaultTimezone: "America/New_York",
          },
          heartbeat: {
            intervalMs: 120000,
            showOk: true,
            showAlerts: false,
          },
          quietHours: {
            enabled: true,
            criticalBypass: false,
          },
        },
        _trustLevel: "admin",
      })) as Record<string, unknown>;

      // 3. Assert response
      expect(result.applied).toBe(true);
      expect(result.section).toBe("scheduler");
      expect(result.restarting).toBe(true);

      // 4. Verify the YAML file on disk was updated (daemon would restart to pick up changes)
      const updatedContent = readFileSync(tmpConfigPath, "utf-8");
      expect(updatedContent).toContain("maxConcurrentRuns: 3");
      expect(updatedContent).toContain("America/New_York");
      expect(updatedContent).toContain("intervalMs: 120000");
      expect(updatedContent).toContain("showOk: true");
    },
    30_000,
  );

  // -------------------------------------------------------------------------
  // Test 2: config.apply triggers git commit queryable via config.history
  // -------------------------------------------------------------------------

  it(
    "config.apply triggers git commit queryable via config.history",
    async () => {
      // Wait for git commit (async .catch() in config-handlers.ts)
      await new Promise((r) => setTimeout(r, 1500));

      const historyResult = (await rpcCall("config.history", {
        limit: 10,
        _trustLevel: "admin",
      })) as Record<string, unknown>;

      const entries = historyResult.entries as Array<Record<string, unknown>>;
      expect(Array.isArray(entries)).toBe(true);
      expect(entries.length).toBeGreaterThanOrEqual(1);

      // Find the entry with "Replaced scheduler" in the summary.
      // The first entry should be the config.apply commit (newest first in git log).
      const applyEntry = entries.find((e) => {
        const m = e.metadata as Record<string, unknown>;
        return typeof m.summary === "string" && m.summary.includes("Replaced scheduler");
      }) as Record<string, unknown> | undefined;

      expect(applyEntry).toBeDefined();
      const metadata = applyEntry!.metadata as Record<string, unknown>;
      expect(metadata.section).toBe("scheduler");
      expect(metadata.summary).toContain("Replaced scheduler");
    },
    30_000,
  );

  // -------------------------------------------------------------------------
  // Test 3: config.apply rejects non-admin trust level
  // -------------------------------------------------------------------------

  it(
    "config.apply rejects non-admin trust level",
    async () => {
      await expect(
        rpcCall("config.apply", {
          section: "scheduler",
          value: {
            cron: { enabled: false },
          },
          _trustLevel: "user",
        }),
      ).rejects.toThrow(/admin/i);
    },
    30_000,
  );

  // -------------------------------------------------------------------------
  // Test 4: config.apply rejects immutable section
  // -------------------------------------------------------------------------

  it(
    "config.apply rejects immutable section",
    async () => {
      await expect(
        rpcCall("config.apply", {
          section: "security",
          value: {
            agentToAgent: { enabled: false },
          },
          _trustLevel: "admin",
        }),
      ).rejects.toThrow(/immutable/i);
    },
    30_000,
  );

  // -------------------------------------------------------------------------
  // Test 5: config.apply triggers SIGUSR1 restart
  // -------------------------------------------------------------------------

  it(
    "config.apply triggers SIGUSR1 restart",
    async () => {
      // Clear spy call history
      killSpy.mockClear();

      // Apply a section replacement
      await rpcCall("config.apply", {
        section: "scheduler",
        value: {
          cron: {
            enabled: true,
            maxConcurrentRuns: 2,
            defaultTimezone: "UTC",
          },
          heartbeat: {
            intervalMs: 300000,
            showOk: false,
            showAlerts: true,
          },
          quietHours: {
            enabled: false,
            criticalBypass: true,
          },
        },
        _trustLevel: "admin",
      });

      // Wait for the 200ms setTimeout + buffer
      await new Promise((r) => setTimeout(r, 400));

      // Assert process.kill was called with SIGUSR1
      expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGUSR1");
    },
    30_000,
  );
});
