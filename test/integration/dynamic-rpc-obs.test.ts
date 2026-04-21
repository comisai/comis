// SPDX-License-Identifier: Apache-2.0
/**
 * OBS: Observability Namespace Dynamic RPC Methods Integration Tests
 *
 * Validates all 10 dynamically registered obs.* namespace RPC methods
 * through WebSocket JSON-RPC against a running daemon:
 *
 *   OBS-DIAG:  obs.diagnostics
 *   OBS-BILL:  obs.billing.byProvider, obs.billing.byAgent,
 *              obs.billing.bySession, obs.billing.total
 *   OBS-CHAN:  obs.channels.all, obs.channels.stale, obs.channels.get
 *   OBS-DELIV: obs.delivery.recent, obs.delivery.stats
 *
 * Uses a dedicated config (port 8492, dual tokens, separate memory DB)
 * to avoid conflicts with other test suites.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import { openAuthenticatedWebSocket, sendJsonRpc } from "../support/ws-helpers.js";
import { RPC_FAST_MS } from "../support/timeouts.js";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONFIG_PATH = resolve(
  __dirname,
  "../config/config.test-dynamic-rpc.yaml",
);

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("OBS: Observability Namespace Dynamic RPC Methods", () => {
  let handle: TestDaemonHandle;
  let ws: WebSocket;
  let rpcId = 0;

  beforeAll(async () => {
    handle = await startTestDaemon({ configPath: CONFIG_PATH });
    ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);
  }, 120_000);

  afterAll(async () => {
    if (ws) {
      ws.close();
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
  }, 30_000);

  // -------------------------------------------------------------------------
  // OBS-DIAG — obs.diagnostics
  // -------------------------------------------------------------------------

  describe("OBS-DIAG: obs.diagnostics", () => {
    it("obs.diagnostics returns events and counts", async () => {
      const response = (await sendJsonRpc(
        ws,
        "obs.diagnostics",
        {},
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(response).toHaveProperty("result");
      expect(response).not.toHaveProperty("error");

      const result = response.result as Record<string, unknown>;
      expect(Array.isArray(result.events)).toBe(true);
      expect(typeof result.counts).toBe("object");
      expect(result.counts).not.toBeNull();
    });

    it("obs.diagnostics accepts filter params", async () => {
      const response = (await sendJsonRpc(
        ws,
        "obs.diagnostics",
        { limit: 5 },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(response).toHaveProperty("result");
      expect(response).not.toHaveProperty("error");

      const result = response.result as Record<string, unknown>;
      expect(Array.isArray(result.events)).toBe(true);
      expect((result.events as unknown[]).length).toBeLessThanOrEqual(5);
    });
  });

  // -------------------------------------------------------------------------
  // OBS-BILL — obs.billing.*
  // -------------------------------------------------------------------------

  describe("OBS-BILL: obs.billing.*", () => {
    it("obs.billing.byProvider returns providers array", async () => {
      const response = (await sendJsonRpc(
        ws,
        "obs.billing.byProvider",
        {},
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(response).toHaveProperty("result");
      expect(response).not.toHaveProperty("error");

      const result = response.result as Record<string, unknown>;
      expect(Array.isArray(result.providers)).toBe(true);
    });

    it("obs.billing.byAgent rejects missing agentId", async () => {
      const response = (await sendJsonRpc(
        ws,
        "obs.billing.byAgent",
        {},
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(response).toHaveProperty("error");
      expect(response).not.toHaveProperty("result");

      const error = response.error as Record<string, unknown>;
      expect(typeof error.code).toBe("number");
      expect(typeof error.message).toBe("string");
      expect((error.message as string).toLowerCase()).toContain("agentid");
    });

    it("obs.billing.byAgent returns data for valid agentId", async () => {
      const response = (await sendJsonRpc(
        ws,
        "obs.billing.byAgent",
        { agentId: "default" },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(response).toHaveProperty("result");
      expect(response).not.toHaveProperty("error");

      // In a fresh daemon, result may be an object with billing fields (possibly empty/zero)
      expect(typeof response.result).toBe("object");
    });

    it("obs.billing.bySession rejects missing sessionKey", async () => {
      const response = (await sendJsonRpc(
        ws,
        "obs.billing.bySession",
        {},
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(response).toHaveProperty("error");
      expect(response).not.toHaveProperty("result");

      const error = response.error as Record<string, unknown>;
      expect(typeof error.code).toBe("number");
      expect(typeof error.message).toBe("string");
      expect((error.message as string).toLowerCase()).toContain("sessionkey");
    });

    it("obs.billing.total returns aggregate", async () => {
      const response = (await sendJsonRpc(
        ws,
        "obs.billing.total",
        {},
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(response).toHaveProperty("result");
      expect(response).not.toHaveProperty("error");

      // Result is a billing total object (structure may vary, but it exists)
      expect(typeof response.result).toBe("object");
    });
  });

  // -------------------------------------------------------------------------
  // OBS-CHAN — obs.channels.*
  // -------------------------------------------------------------------------

  describe("OBS-CHAN: obs.channels.*", () => {
    it("obs.channels.all returns channels array", async () => {
      const response = (await sendJsonRpc(
        ws,
        "obs.channels.all",
        {},
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(response).toHaveProperty("result");
      expect(response).not.toHaveProperty("error");

      const result = response.result as Record<string, unknown>;
      expect(Array.isArray(result.channels)).toBe(true);
    });

    it("obs.channels.stale returns stale array", async () => {
      const response = (await sendJsonRpc(
        ws,
        "obs.channels.stale",
        {},
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(response).toHaveProperty("result");
      expect(response).not.toHaveProperty("error");

      const result = response.result as Record<string, unknown>;
      expect(Array.isArray(result.stale)).toBe(true);
    });

    it("obs.channels.stale accepts thresholdMs param", async () => {
      const response = (await sendJsonRpc(
        ws,
        "obs.channels.stale",
        { thresholdMs: 1000 },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(response).toHaveProperty("result");
      expect(response).not.toHaveProperty("error");

      const result = response.result as Record<string, unknown>;
      expect(Array.isArray(result.stale)).toBe(true);
    });

    it("obs.channels.get rejects missing channelId", async () => {
      const response = (await sendJsonRpc(
        ws,
        "obs.channels.get",
        {},
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(response).toHaveProperty("error");
      expect(response).not.toHaveProperty("result");

      const error = response.error as Record<string, unknown>;
      expect(typeof error.code).toBe("number");
      expect(typeof error.message).toBe("string");
      expect((error.message as string).toLowerCase()).toContain("channelid");
    });

    it("obs.channels.get returns null for unknown channelId", async () => {
      const response = (await sendJsonRpc(
        ws,
        "obs.channels.get",
        { channelId: "nonexistent" },
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(response).toHaveProperty("result");
      expect(response).not.toHaveProperty("error");

      const result = response.result as Record<string, unknown>;
      expect(result.channel).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // OBS-DELIV — obs.delivery.*
  // -------------------------------------------------------------------------

  describe("OBS-DELIV: obs.delivery.*", () => {
    it("obs.delivery.recent returns deliveries array", async () => {
      const response = (await sendJsonRpc(
        ws,
        "obs.delivery.recent",
        {},
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(response).toHaveProperty("result");
      expect(response).not.toHaveProperty("error");

      const result = response.result as Record<string, unknown>;
      expect(Array.isArray(result.deliveries)).toBe(true);
    });

    it("obs.delivery.stats returns statistics", async () => {
      const response = (await sendJsonRpc(
        ws,
        "obs.delivery.stats",
        {},
        ++rpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(response).toHaveProperty("result");
      expect(response).not.toHaveProperty("error");

      // Stats is an object with aggregate delivery data
      expect(typeof response.result).toBe("object");
      expect(response.result).not.toBeNull();
    });
  });
});
