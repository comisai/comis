// SPDX-License-Identifier: Apache-2.0
/**
 * CONFIG-SAFETY-E2E: End-to-end tests for config safety mechanisms.
 *
 * Validates the config safety pipeline through the full daemon stack:
 *   E2E-05: Audit event emission on config.patch success
 *   E2E-02: config.patch triggers SIGUSR2 restart (process.kill spy)
 *   E2E-03: Trust escalation enforcement (admin vs user vs missing)
 *   E2E-04: Rate limiting enforces 5-per-minute budget with wait guidance
 *
 * Test order is deliberate: audit first (needs token budget), then restart,
 * trust, and rate limit last (exhausts remaining budget).
 *
 * Uses a dedicated config (port 8541, dual tokens) and temp config copy.
 * Spies on process.kill to capture SIGUSR2 calls without killing the process.
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
import { createEventAwaiter, type EventAwaiter } from "../support/event-awaiter.js";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BASE_CONFIG_PATH = resolve(
  __dirname,
  "../config/config.test-config-e2e-safety.yaml",
);

// ---------------------------------------------------------------------------
// Type aliases
// ---------------------------------------------------------------------------

type RpcCall = (method: string, params: Record<string, unknown>) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("CONFIG-SAFETY-E2E", () => {
  let handle: TestDaemonHandle;
  let rpcCall: RpcCall;
  let eventAwaiter: EventAwaiter;
  let tmpDir: string;
  let tmpConfigPath: string;
  let processKillSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    // Create temp directory for mutable config (config.patch writes to disk)
    tmpDir = join(tmpdir(), `comis-config-safety-e2e-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    // Copy config to temp location for mutation safety
    tmpConfigPath = join(tmpDir, "config.test-config-e2e-safety.yaml");
    const configContent = readFileSync(BASE_CONFIG_PATH, "utf-8");
    writeFileSync(tmpConfigPath, configContent, "utf-8");

    // Spy on process.kill to intercept SIGUSR2 without actually sending the signal.
    // This lets us observe that config.patch WOULD restart the daemon.
    processKillSpy = vi.spyOn(process, "kill").mockImplementation(
      (pid: number, signal?: string | number): true => {
        if (signal === "SIGUSR2") {
          // No-op: prevent actual SIGUSR2 from killing the test process
          return true;
        }
        // For other signals, call original (should not happen in tests)
        return process.kill.call(process, pid, signal as string);
      },
    );

    handle = await startTestDaemon({ configPath: tmpConfigPath });

    // Access internal rpcCall from daemon instance
    rpcCall = handle.daemon.rpcCall;
    expect(rpcCall).toBeDefined();

    // Create event awaiter for audit event assertions
    eventAwaiter = createEventAwaiter(handle.daemon.container.eventBus);
  }, 120_000);

  afterAll(async () => {
    // Dispose event awaiter
    if (eventAwaiter) {
      eventAwaiter.dispose();
    }

    // Restore process.kill spy
    if (processKillSpy) {
      processKillSpy.mockRestore();
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

  // =========================================================================
  // E2E-05: Audit event emission (FIRST -- needs fresh token budget)
  // =========================================================================

  describe("E2E-05: Audit event emission", () => {
    it(
      "config.patch success emits audit event with actionType and classification",
      async () => {
        const events = await eventAwaiter.collectDuring("audit:event", async () => {
          await rpcCall("config.patch", {
            section: "daemon",
            key: "configWebhook.timeoutMs",
            value: 3000,
            _trustLevel: "admin",
          });
          // Brief settle time for async event emission
          await new Promise((r) => setTimeout(r, 100));
        });

        // Find the audit event for config.patch success
        const auditEvent = events.find(
          (e) => e.actionType === "config.patch" && e.outcome === "success",
        );

        expect(auditEvent).toBeDefined();
        expect(auditEvent!.classification).toBe("destructive");
        expect(auditEvent!.metadata).toBeDefined();
        expect((auditEvent!.metadata as Record<string, unknown>).section).toBe("daemon");
        expect(auditEvent!.timestamp).toBeTypeOf("number");
      },
      30_000,
    );
  });

  // =========================================================================
  // E2E-02: config.patch triggers SIGUSR2 restart
  // =========================================================================

  describe("E2E-02: config.patch triggers SIGUSR2 restart", () => {
    it(
      "config.patch schedules SIGUSR2 signal to restart daemon",
      async () => {
        // Clear spy call history
        processKillSpy.mockClear();

        const result = (await rpcCall("config.patch", {
          section: "scheduler",
          key: "heartbeat.intervalMs",
          value: 600000,
          _trustLevel: "admin",
        })) as Record<string, unknown>;

        // Wait for the 200ms delayed setTimeout + buffer
        await new Promise((r) => setTimeout(r, 400));

        // Verify process.kill was called with SIGUSR2
        expect(processKillSpy).toHaveBeenCalledWith(process.pid, "SIGUSR2");

        // Verify the result indicates restarting
        expect(result.restarting).toBe(true);
        expect(result.patched).toBe(true);
      },
      30_000,
    );
  });

  // =========================================================================
  // E2E-03: Trust escalation enforcement
  // =========================================================================

  describe("E2E-03: Trust escalation enforcement", () => {
    it(
      "admin trust level can modify config",
      async () => {
        const result = (await rpcCall("config.patch", {
          section: "scheduler",
          key: "heartbeat.showOk",
          value: true,
          _trustLevel: "admin",
        })) as Record<string, unknown>;

        expect(result.patched).toBe(true);
      },
      30_000,
    );

    it(
      "non-admin trust level is rejected",
      async () => {
        await expect(
          rpcCall("config.patch", {
            section: "scheduler",
            key: "heartbeat.showOk",
            value: false,
            _trustLevel: "user",
          }),
        ).rejects.toThrow(/admin/i);
      },
      30_000,
    );

    it(
      "missing trust level is rejected",
      async () => {
        await expect(
          rpcCall("config.patch", {
            section: "scheduler",
            key: "heartbeat.showOk",
            value: false,
          }),
        ).rejects.toThrow(/admin/i);
      },
      30_000,
    );
  });

  // =========================================================================
  // E2E-04: Rate limiting enforcement (LAST -- exhausts remaining budget)
  // =========================================================================

  describe("E2E-04: Rate limiting enforcement", () => {
    it(
      "config.patch rate limit returns error with wait guidance after budget exhaustion",
      async () => {
        let successes = 0;
        let rateLimitError: string | null = null;

        // Send patches in a loop until rate limited.
        // Prior tests consumed tokens (E2E-05: 1, E2E-02: 1, E2E-03 admin: 1 = ~3).
        // The bucket has 5 tokens with continuous refill (5 per 60s).
        // At test execution speed, minimal refill occurs, so ~2 tokens remain.
        for (let i = 0; i < 8; i++) {
          try {
            await rpcCall("config.patch", {
              section: "scheduler",
              key: "heartbeat.showAlerts",
              value: i % 2 === 0,
              _trustLevel: "admin",
            });
            successes++;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            rateLimitError = msg;
            break;
          }
        }

        // At least one should have succeeded (proves the bucket isn't empty from the start)
        expect(successes).toBeGreaterThanOrEqual(1);

        // Total successes should not exceed 5 (initial bucket size)
        // accounting for tokens consumed by prior tests
        expect(successes).toBeLessThanOrEqual(5);

        // Rate limit error must be present and contain guidance
        expect(rateLimitError).not.toBeNull();
        expect(rateLimitError).toMatch(/rate limit/i);
        expect(rateLimitError).toContain("seconds");
      },
      30_000,
    );
  });
});
