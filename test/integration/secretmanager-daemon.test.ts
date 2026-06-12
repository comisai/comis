// SPDX-License-Identifier: Apache-2.0
/**
 * SecretManager Daemon E2E Tests (real daemon)
 *
 * Validates that SecretManager is correctly wired into the daemon bootstrap
 * composition root, provider config is accessible via RPC, and daemon logs
 * contain no raw credentials.
 *
 *   - Daemon bootstrap with SecretManager
 *   - Provider config wiring
 *   - Daemon log sanitization verification
 *
 * Uses the daemon harness for programmatic daemon startup/teardown.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import { openAuthenticatedWebSocket, sendJsonRpc } from "../support/ws-helpers.js";
import { DAEMON_STARTUP_MS, RPC_FAST_MS } from "../support/timeouts.js";
import { createLogCapture } from "../support/log-verifier.js";
import { sanitizeLogString } from "@comis/core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = resolve(__dirname, "../config/config.test-secretmanager.yaml");

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("SecretManager Daemon E2E Tests (real daemon)", () => {
  let handle: TestDaemonHandle;
  let ws: WebSocket;
  let logCapture: ReturnType<typeof createLogCapture>;

  beforeAll(async () => {
    logCapture = createLogCapture();
    handle = await startTestDaemon({
      configPath: CONFIG_PATH,
      logStream: logCapture.stream,
    });
    ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);
    // DAEMON_STARTUP_MS + headroom, matching the other daemon-boot suites: a
    // bare 60s equals the harness's own internal startup budget, so a slow
    // CI runner (concurrent GGUF model loads across fork workers) times the
    // hook out before startTestDaemon can even report failure.
  }, DAEMON_STARTUP_MS + 30_000);

  afterAll(async () => {
    if (ws) ws.close();
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
  }, 30_000);

  // ---------------------------------------------------------------------------
  // Daemon Bootstrap with SecretManager
  // ---------------------------------------------------------------------------

  describe("Daemon Bootstrap with SecretManager", () => {
    it("config.get with no section returns valid JSON-RPC result (bootstrap complete)", async () => {
      const response = (await sendJsonRpc(ws, "config.get", {}, 10, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      expect(response).toHaveProperty("id", 10);
      // config.get is a core registered method -- must return result if bootstrap succeeded
      expect(response).toHaveProperty("result");
      expect(typeof response.result).toBe("object");
    });

    it("gateway.status returns operational status (full gateway stack running)", async () => {
      const response = (await sendJsonRpc(ws, "gateway.status", {}, 11, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      expect(response).toHaveProperty("id", 11);
      // gateway.status is a core registered method -- must return result
      expect(response).toHaveProperty("result");
      const result = response.result as Record<string, unknown>;
      expect(typeof result.pid).toBe("number");
      expect(typeof result.uptime).toBe("number");
    });
  });

  // ---------------------------------------------------------------------------
  // Provider Config Wiring
  // ---------------------------------------------------------------------------

  describe("Provider Config Wiring", () => {
    it("agents.get returns the default agent config with a provider field", async () => {
      // Agent provider config is read via agents.get rather than
      // config.get({section:"agents"}), which no longer egresses agent configs.
      const response = (await sendJsonRpc(ws, "agents.get", { agentId: "default" }, 20, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      expect(response).toHaveProperty("id", 20);
      expect(response).toHaveProperty("result");
      expect(response).not.toHaveProperty("error");

      const result = response.result as Record<string, unknown>;
      expect(result.agentId).toBe("default");
      expect(result).toHaveProperty("config");
      const config = result.config as Record<string, unknown>;

      expect(config).toHaveProperty("provider");
      expect(typeof config.provider).toBe("string");
    });

    it("provider name follows the ${PROVIDER}_API_KEY naming convention", async () => {
      // Provider read via agents.get rather than config.get({section:"agents"}).
      const response = (await sendJsonRpc(ws, "agents.get", { agentId: "default" }, 21, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      expect(response).toHaveProperty("result");
      const result = response.result as Record<string, unknown>;
      const config = result.config as Record<string, unknown>;

      const provider = config.provider as string;
      expect(typeof provider).toBe("string");
      expect(provider.length).toBeGreaterThan(0);

      // Verify the provider name follows the convention: PROVIDER_API_KEY is a valid key name
      const keyName = `${provider.toUpperCase()}_API_KEY`;
      expect(keyName).toMatch(/^[A-Z]+_API_KEY$/);
      // Specifically for our test config, provider should be "anthropic"
      expect(provider).toBe("anthropic");
      expect(keyName).toBe("ANTHROPIC_API_KEY");
    });
  });

  // ---------------------------------------------------------------------------
  // Daemon Log Sanitization Verification
  // ---------------------------------------------------------------------------

  describe("Daemon Log Sanitization Verification", () => {
    it("daemon log entries contain no raw credential patterns", async () => {
      // After daemon startup and RPC calls, capture all log entries
      const entries = logCapture.getEntries();

      // Sanity check: we should have captured some log entries
      expect(entries.length).toBeGreaterThan(0);

      // For each log entry with a msg field, verify sanitizeLogString produces identical output
      for (const entry of entries) {
        const msg = entry.msg ?? "";
        if (msg.length > 0) {
          const sanitized = sanitizeLogString(msg);
          expect(sanitized).toBe(msg);
        }
      }
    });

    it("log capture contains meaningful startup entries (not testing empty data)", async () => {
      const entries = logCapture.getEntries();

      // Verify we have a non-trivial number of log entries
      // A daemon startup typically produces 10+ log messages
      expect(entries.length).toBeGreaterThanOrEqual(5);

      // Verify at least some entries have non-empty messages
      const entriesWithMessages = entries.filter((e) => e.msg && e.msg.length > 0);
      expect(entriesWithMessages.length).toBeGreaterThan(0);
    });
  });
});
