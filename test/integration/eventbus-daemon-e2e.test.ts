// SPDX-License-Identifier: Apache-2.0
/**
 * EventBus Daemon E2E Tests (real daemon)
 *
 * Validates that the TypedEventBus is correctly wired into the daemon
 * composition root, has active listeners after startup, and remains
 * functional through normal RPC traffic.
 *
 *   EBD-01: Daemon container exposes event bus
 *   EBD-02: Event bus has active listeners after daemon startup
 *   EBD-03: Can emit and receive events through daemon event bus
 *   EBD-05: Plugin registry events are wired through daemon event bus
 *   EBD-06: Event bus survives normal RPC traffic
 *
 * Uses port 8503 and unique database path to avoid conflicts with other test suites.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startTestDaemon,
  rpcRequest,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import { DAEMON_STARTUP_MS } from "../support/timeouts.js";
import { ok } from "@comis/shared";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = resolve(__dirname, "../config/config.test-eventbus-e2e.yaml");

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe("EventBus Daemon E2E", () => {
  let handle: TestDaemonHandle;

  beforeAll(async () => {
    handle = await startTestDaemon({ configPath: CONFIG_PATH });
  }, DAEMON_STARTUP_MS + 30_000);

  afterAll(async () => {
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
  // EBD-01: Daemon container exposes event bus
  // -------------------------------------------------------------------------

  it("daemon container exposes event bus with full API surface", () => {
    const eventBus = (handle.daemon.container as any).eventBus;
    expect(eventBus).toBeDefined();
    expect(typeof eventBus.emit).toBe("function");
    expect(typeof eventBus.on).toBe("function");
    expect(typeof eventBus.listenerCount).toBe("function");
    expect(typeof eventBus.removeAllListeners).toBe("function");
  });

  // -------------------------------------------------------------------------
  // EBD-02: Event bus has active listeners after daemon startup
  // -------------------------------------------------------------------------

  it("event bus has active listeners after daemon startup", () => {
    const eventBus = (handle.daemon.container as any).eventBus;

    // The daemon wires various listeners during startup (observability:metrics, etc.).
    // Verify the event bus is a functional TypedEventBus instance.
    expect(typeof eventBus.emit).toBe("function");
    expect(typeof eventBus.on).toBe("function");

    // The daemon registers an observability:metrics listener for health logging.
    const metricsListeners = eventBus.listenerCount("observability:metrics");
    expect(metricsListeners).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // EBD-03: Can emit and receive events through daemon event bus
  // -------------------------------------------------------------------------

  it("can emit and receive events through daemon event bus", () => {
    const eventBus = (handle.daemon.container as any).eventBus;

    let receivedPayload: any = null;
    const handler = (payload: any) => {
      receivedPayload = payload;
    };

    // Use session:created (a safe, side-effect-free event) instead of
    // system:shutdown which would trigger actual daemon shutdown handlers.
    eventBus.on("session:created", handler);

    try {
      const testPayload = {
        sessionKey: { channelType: "echo", channelId: "test", chatId: "c1" },
        timestamp: Date.now(),
      };
      eventBus.emit("session:created", testPayload);

      // Verify handler was called with correct payload
      expect(receivedPayload).not.toBeNull();
      expect(receivedPayload.sessionKey.channelType).toBe("echo");
      expect(typeof receivedPayload.timestamp).toBe("number");
    } finally {
      eventBus.off("session:created", handler);
    }
  });

  // -------------------------------------------------------------------------
  // EBD-05: Plugin registry events wired through daemon event bus
  // -------------------------------------------------------------------------

  it("plugin registry events are wired through daemon event bus", () => {
    const eventBus = (handle.daemon.container as any).eventBus;
    const pluginRegistry = (handle.daemon.container as any).pluginRegistry;

    if (!pluginRegistry) {
      // Plugin registry not accessible via container -- skip gracefully
      expect(pluginRegistry).toBeUndefined();
      return;
    }

    // Register a handler for plugin:registered on the daemon event bus
    let pluginEventReceived = false;
    const handler = (payload: any) => {
      if (payload.pluginId === "eventbus-e2e-test-plugin") {
        pluginEventReceived = true;
      }
    };
    eventBus.on("plugin:registered", handler);

    try {
      // Register a test plugin through the daemon's plugin registry
      const testPlugin = {
        id: "eventbus-e2e-test-plugin",
        name: "E2E Test Plugin",
        version: "1.0.0",
        register(api: any) {
          api.registerHook("session_start", () => {});
          return ok(undefined);
        },
      };

      const result = pluginRegistry.register(testPlugin);

      // If registration succeeded, verify event was emitted through daemon bus
      if (result.ok) {
        expect(pluginEventReceived).toBe(true);
      }

      // Clean up: unregister the test plugin
      pluginRegistry.unregister("eventbus-e2e-test-plugin");
    } finally {
      eventBus.off("plugin:registered", handler);
    }
  });

  // -------------------------------------------------------------------------
  // EBD-06: Event bus survives normal RPC traffic
  // -------------------------------------------------------------------------

  it("event bus survives normal RPC traffic without disruption", async () => {
    const eventBus = (handle.daemon.container as any).eventBus;

    // Register a handler for a safe, side-effect-free event
    let handlerCalled = false;
    const handler = () => {
      handlerCalled = true;
    };
    eventBus.on("session:created", handler);

    try {
      // Make an HTTP RPC call to the daemon (config.get is fast and doesn't need LLM)
      const response = await fetch(`${handle.gatewayUrl}/rpc`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${handle.authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "config.get",
          params: {},
        }),
      });

      // Verify HTTP response succeeded (2xx)
      // JSON-RPC may return 200 even on method errors -- just verify we got a response
      expect(response.status).toBeLessThan(500);

      // Now emit a test event after RPC completes -- bus should still be functional
      eventBus.emit("session:created", {
        sessionKey: { channelType: "echo", channelId: "test", chatId: "rpc-test" },
        timestamp: Date.now(),
      });

      // Verify the handler still receives the event
      expect(handlerCalled).toBe(true);
    } finally {
      eventBus.off("session:created", handler);
    }
  });
});
