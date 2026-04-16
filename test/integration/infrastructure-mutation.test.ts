/**
 * INFRA: Infrastructure Mutation Operations Integration Tests
 *
 * Validates mutation RPC methods through the running daemon's internal rpcCall:
 *   INFRA-02: config.patch modifies config with validation, immutable key protection,
 *             and admin trust enforcement
 *   INFRA-05: gateway.restart returns correct response with admin trust enforcement
 *
 * Uses a temp config file (copied from config.test.yaml with port 8451 and unique
 * dbPath) to avoid corrupting committed test configs when config.patch writes to disk.
 *
 * config.patch and gateway.restart are internal rpcCall methods (platform tool dispatch),
 * not gateway WebSocket RPC methods. We access them via handle.daemon.rpcCall directly,
 * following the same pattern as scheduler and messaging integration tests.
 *
 * Test ordering: config.patch tests run first, then gateway.restart rejection (non-admin),
 * then gateway.restart success (admin) LAST because it kills the daemon via SIGUSR1.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const BASE_CONFIG_PATH = resolve(__dirname, "../config/config.test.yaml");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Type alias for the daemon's internal rpcCall function. */
type RpcCall = (method: string, params: Record<string, unknown>) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("INFRA: Infrastructure Mutation Operations", () => {
  let handle: TestDaemonHandle;
  let rpcCall: RpcCall;
  let tmpDir: string;
  let tmpConfigPath: string;
  let shutdownTriggered = false;

  beforeAll(async () => {
    // 1. Create temp directory for mutable config
    tmpDir = join(tmpdir(), `comis-infra-mutation-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    // 2. Copy base config and modify port + dbPath
    tmpConfigPath = join(tmpDir, "config.test-infra-mutation.yaml");
    let configContent = readFileSync(BASE_CONFIG_PATH, "utf-8");
    configContent = configContent.replace(/port:\s*\d+/, "port: 8451");
    configContent = configContent.replace(
      /dbPath:\s*"[^"]*"/,
      'dbPath: "test-memory-infra-mutation.db"',
    );
    writeFileSync(tmpConfigPath, configContent, "utf-8");

    // 3. Start daemon with tmp config
    handle = await startTestDaemon({ configPath: tmpConfigPath });

    // 4. Access internal rpcCall from daemon instance
    // rpcCall is exposed on the DaemonInstance for integration testing (same pattern as
    // cronSchedulers and adapterRegistry accessed via handle.daemon cast)
    rpcCall = (handle.daemon as any).rpcCall as RpcCall;
  }, 120_000);

  afterAll(async () => {
    // Cleanup daemon
    if (handle) {
      if (!shutdownTriggered) {
        try {
          await handle.cleanup();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes("Daemon exit with code")) {
            throw err;
          }
        }
      } else {
        // Shutdown already happened via gateway.restart -- just dispose and clean env
        try {
          handle.daemon.shutdownHandle.dispose();
        } catch {
          // May already be disposed
        }
        delete process.env["COMIS_CONFIG_PATHS"];
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
  // INFRA-02: config.patch tests
  // -------------------------------------------------------------------------

  it(
    "config.patch with admin trust modifies config and writes to YAML",
    async () => {
      const result = (await rpcCall("config.patch", {
        section: "scheduler",
        key: "heartbeat.intervalMs",
        value: 600000,
        _trustLevel: "admin",
      })) as Record<string, unknown>;

      expect(result.patched).toBe(true);
      expect(result.section).toBe("scheduler");
      expect(result.key).toBe("heartbeat.intervalMs");

      // Verify the patch was written to the tmp config YAML file on disk
      const updatedContent = readFileSync(tmpConfigPath, "utf-8");
      expect(updatedContent).toContain("intervalMs");
      expect(updatedContent).toContain("600000");
    },
    30_000,
  );

  it(
    "config.patch rejects immutable security path",
    async () => {
      await expect(
        rpcCall("config.patch", {
          section: "security",
          key: "agentToAgent.enabled",
          value: false,
          _trustLevel: "admin",
        }),
      ).rejects.toThrow(/immutable/i);
    },
    30_000,
  );

  it(
    "config.patch rejects immutable gateway.tokens path",
    async () => {
      await expect(
        rpcCall("config.patch", {
          section: "gateway",
          key: "tokens",
          value: [],
          _trustLevel: "admin",
        }),
      ).rejects.toThrow(/immutable/i);
    },
    30_000,
  );

  it(
    "config.patch rejects invalid value (validation error)",
    async () => {
      await expect(
        rpcCall("config.patch", {
          section: "scheduler",
          key: "heartbeat.intervalMs",
          value: "not-a-number",
          _trustLevel: "admin",
        }),
      ).rejects.toThrow(/validation/i);
    },
    30_000,
  );

  it(
    "config.patch rejects non-admin trust level",
    async () => {
      await expect(
        rpcCall("config.patch", {
          section: "scheduler",
          key: "heartbeat.intervalMs",
          value: 600000,
          _trustLevel: "external",
        }),
      ).rejects.toThrow(/admin/i);
    },
    30_000,
  );

  // -------------------------------------------------------------------------
  // INFRA-05: gateway.restart tests
  // -------------------------------------------------------------------------

  // Non-admin rejection MUST run before the success test (which kills the daemon)
  it(
    "gateway.restart rejects non-admin trust level",
    async () => {
      await expect(
        rpcCall("gateway.restart", { _trustLevel: "external" }),
      ).rejects.toThrow(/admin/i);
    },
    30_000,
  );

  // This test MUST be last -- gateway.restart sends SIGUSR1 via setTimeout, killing the daemon
  it(
    "gateway.restart returns restart confirmation",
    async () => {
      // Safety net: suppress any unhandled rejections from the exit-override throw
      // (graceful-shutdown catches the throw internally, but guard against edge cases)
      const rejectionHandler = (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("Daemon exit with code")) {
          return; // Suppress expected exit throw
        }
        // Re-throw unexpected rejections
        throw err;
      };
      process.on("unhandledRejection", rejectionHandler);

      const result = (await rpcCall("gateway.restart", {
        _trustLevel: "admin",
      })) as Record<string, unknown>;

      expect(result.restarting).toBe(true);
      expect(result.systemd).toBe(false);
      expect(typeof result.warning).toBe("string");
      expect(result.warning as string).toContain("Not running under systemd");

      // Mark shutdown triggered so afterAll doesn't try to cleanup a dead daemon
      shutdownTriggered = true;

      // Allow SIGUSR1 setTimeout(200ms) to fire and graceful shutdown to complete
      await new Promise((r) => setTimeout(r, 3000));

      // Clean up rejection handler
      process.removeListener("unhandledRejection", rejectionHandler);

      // Verify the SIGUSR1 did trigger shutdown via the shutdown handle
      // (graceful-shutdown catches the exit() throw internally, so we check isShuttingDown)
      expect(handle.daemon.shutdownHandle.isShuttingDown).toBe(true);
    },
    30_000,
  );
});
