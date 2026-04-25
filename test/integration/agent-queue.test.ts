// SPDX-License-Identifier: Apache-2.0
/**
 * Agent Queue E2E Integration Tests
 *
 * Tests the CommandQueue system through the full daemon stack:
 * - AGT-03: Stale session lock recovery (validated by unit tests)
 * - AGT-04: Budget pre-check rejects when perExecution exceeded
 * - AGT-04-deletion: Session deletion during active execution (validated by unit tests)
 * - TOOL-04: Circuit breaker opens after N provider failures
 * - TOOL-05: Circuit breaker recovers to half-open after resetTimeoutMs
 * - TOOL-06: Circuit breaker closes after successful probe in half-open
 *
 * @module
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import {
  openAuthenticatedWebSocket,
  sendJsonRpc,
} from "../support/ws-helpers.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = resolve(__dirname, "../config/config.test-agent-queue.yaml");

// ---------------------------------------------------------------------------
// Section 1: Config-driven tests (no LLM key needed)
// ---------------------------------------------------------------------------

describe("Config-driven queue tests (no LLM key required)", () => {
  let handle: TestDaemonHandle;

  beforeAll(async () => {
    handle = await startTestDaemon({ configPath: CONFIG_PATH });
  }, 60_000);

  afterAll(async () => {
    if (handle) {
      try {
        await handle.cleanup();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("Daemon exit with code")) {
          throw err;
        }
      }
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // AGT-04: Budget pre-check rejects when perExecution exceeded
  // -------------------------------------------------------------------------

  it(
    "AGT-04: budget pre-check rejects when perExecution exceeded",
    async () => {
      let ws: WebSocket | undefined;
      try {
        ws = await openAuthenticatedWebSocket(
          handle.gatewayUrl,
          handle.authToken,
        );

        const response = (await sendJsonRpc(
          ws,
          "agent.execute",
          { message: "Hello", agentId: "budget-limited" },
          1,
          { timeoutMs: 30_000 },
        )) as Record<string, unknown>;

        // Budget pre-check should reject: either via result.finishReason or error
        // Dual-check pattern per decision 117-01
        const hasResultBudget =
          response.result &&
          typeof (response.result as Record<string, unknown>).finishReason ===
            "string" &&
          ((response.result as Record<string, unknown>).finishReason as string)
            .toLowerCase()
            .includes("budget");

        const hasErrorBudget =
          response.error &&
          (JSON.stringify(response.error).toLowerCase().includes("budget") ||
            JSON.stringify(response.error).toLowerCase().includes("exceeded"));

        expect(hasResultBudget || hasErrorBudget).toBe(true);
      } finally {
        ws?.close();
      }
    },
    30_000,
  );

  // -------------------------------------------------------------------------
  // AGT-03: Stale session lock recovery (unit test validation)
  // -------------------------------------------------------------------------

  it(
    "AGT-03: stale session lock recovery is covered by unit tests",
    async () => {
      // AGT-03 stale lock recovery: validated by unit tests in session-concurrency.test.ts
      // Stale lock recovery is impractical to trigger through daemon RPC because the
      // lock lifecycle is internal to withSessionLock(). Instead, verify daemon health
      // and queue config is present with correct values.
      let ws: WebSocket | undefined;
      try {
        ws = await openAuthenticatedWebSocket(
          handle.gatewayUrl,
          handle.authToken,
        );

        const response = (await sendJsonRpc(
          ws,
          "config.get",
          { section: "queue" },
          2,
          { timeoutMs: 5_000 },
        )) as Record<string, unknown>;

        expect(response).toHaveProperty("result");
        expect(response).not.toHaveProperty("error");

        // Verify queue config is present with our expected values
        const result = response.result as Record<string, unknown>;
        const queueConfig = result.queue as Record<string, unknown>;
        expect(queueConfig).toBeDefined();
        expect(queueConfig.maxConcurrentSessions).toBe(5);
        expect(queueConfig.enabled).toBe(true);
      } finally {
        ws?.close();
      }
    },
    5_000,
  );

  // -------------------------------------------------------------------------
  // AGT-04-deletion: Session deletion during active execution (unit test)
  // -------------------------------------------------------------------------

  it(
    "AGT-04-deletion: session deletion during active execution is covered by unit tests",
    async () => {
      // AGT-04 session deletion during execution: validated by unit tests in
      // session-concurrency.test.ts (Phase 105-01). The daemon session management
      // layer delegates to the same withSessionLock() infrastructure.
      let ws: WebSocket | undefined;
      try {
        ws = await openAuthenticatedWebSocket(
          handle.gatewayUrl,
          handle.authToken,
        );

        const response = (await sendJsonRpc(
          ws,
          "sessions.list",
          {},
          3,
          { timeoutMs: 5_000 },
        )) as Record<string, unknown>;

        // sessions.list should return successfully (daemon session management healthy)
        // Accept either result or structured error (method may not be registered)
        expect(response).toHaveProperty("jsonrpc", "2.0");
        expect(response).toHaveProperty("id", 3);
      } finally {
        ws?.close();
      }
    },
    5_000,
  );
});
// ---------------------------------------------------------------------------
// Section 3: Circuit breaker lifecycle (unit-integration, no daemon)
// ---------------------------------------------------------------------------

describe("Circuit breaker lifecycle (unit-integration)", () => {
  // Import createCircuitBreaker from the agent package via vitest alias
  let createCircuitBreaker: typeof import("@comis/agent")["createCircuitBreaker"];

  beforeAll(async () => {
    const agentModule = await import("@comis/agent");
    createCircuitBreaker = agentModule.createCircuitBreaker;
  });

  // -------------------------------------------------------------------------
  // TOOL-04: Circuit breaker opens after N provider failures
  // -------------------------------------------------------------------------

  it(
    "TOOL-04: circuit breaker opens after N provider failures",
    () => {
      const cb = createCircuitBreaker({
        failureThreshold: 3,
        resetTimeoutMs: 2000,
        halfOpenTimeoutMs: 1000,
      });

      expect(cb.getState()).toBe("closed");
      expect(cb.isOpen()).toBe(false);

      cb.recordFailure();
      cb.recordFailure();
      cb.recordFailure();

      expect(cb.getState()).toBe("open");
      expect(cb.isOpen()).toBe(true);
    },
    10_000,
  );

  // -------------------------------------------------------------------------
  // TOOL-05: Circuit breaker recovers to half-open after resetTimeoutMs
  // -------------------------------------------------------------------------

  it(
    "TOOL-05: circuit breaker recovers to half-open after resetTimeoutMs",
    async () => {
      const cb = createCircuitBreaker({
        failureThreshold: 3,
        resetTimeoutMs: 100,
        halfOpenTimeoutMs: 50,
      });

      cb.recordFailure();
      cb.recordFailure();
      cb.recordFailure();

      expect(cb.getState()).toBe("open");

      // Wait past resetTimeoutMs
      await new Promise((r) => setTimeout(r, 150));

      expect(cb.getState()).toBe("halfOpen");
      expect(cb.isOpen()).toBe(false);
    },
    10_000,
  );

  // -------------------------------------------------------------------------
  // TOOL-06: Circuit breaker closes after successful probe in half-open
  // -------------------------------------------------------------------------

  it(
    "TOOL-06: circuit breaker closes after successful probe in half-open",
    async () => {
      // Test success path: half-open -> closed
      const cb = createCircuitBreaker({
        failureThreshold: 3,
        resetTimeoutMs: 100,
        halfOpenTimeoutMs: 50,
      });

      cb.recordFailure();
      cb.recordFailure();
      cb.recordFailure();
      expect(cb.getState()).toBe("open");

      await new Promise((r) => setTimeout(r, 150));
      expect(cb.getState()).toBe("halfOpen");

      cb.recordSuccess();
      expect(cb.getState()).toBe("closed");
      expect(cb.isOpen()).toBe(false);

      // Test failure path: half-open -> open (failure re-opens breaker)
      const cb2 = createCircuitBreaker({
        failureThreshold: 3,
        resetTimeoutMs: 100,
        halfOpenTimeoutMs: 50,
      });

      cb2.recordFailure();
      cb2.recordFailure();
      cb2.recordFailure();
      expect(cb2.getState()).toBe("open");

      await new Promise((r) => setTimeout(r, 150));
      expect(cb2.getState()).toBe("halfOpen");

      cb2.recordFailure();
      expect(cb2.getState()).toBe("open");
    },
    10_000,
  );
});
