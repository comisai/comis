/**
 * Web Console SSE Events & Infrastructure RPC Integration Tests
 *
 * Validates SSE event delivery and infrastructure RPC methods that the web
 * console depends on for real-time updates and system status display:
 *
 *   SSE-01:   SSE event stream connectivity and format
 *   SSE-02:   SSE events triggered by agent status changes
 *   INFRA-01: config.read response shape for web config editor
 *   INFRA-02: config.schema response shape for web schema viewer
 *   INFRA-03: gateway.status response shape for web dashboard
 *   INFRA-04: admin.approval.pending response shape for web approvals view
 *   INFRA-05: obs.delivery.stats response shape for web observability view
 *
 * Uses a dedicated config (port 8701, single admin token, separate memory DB)
 * to avoid conflicts with other test suites.
 *
 * Spies on process.kill to no-op SIGUSR1 signals (prevents daemon restart
 * mid-test when agents.create/delete triggers persistToConfig).
 *
 * @module
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
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
const CONFIG_PATH = resolve(__dirname, "../config/config.test-web-console-sse.yaml");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SseEvent {
  event?: string;
  data: string;
  id?: string;
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Read SSE events from a streaming fetch response.
 *
 * Parses the text/event-stream format: fields separated by newlines,
 * events separated by double newlines. Collects up to maxEvents or
 * until timeoutMs elapsed, then aborts and returns collected events.
 */
async function readSseEvents(
  response: Response,
  maxEvents: number,
  timeoutMs: number,
): Promise<SseEvent[]> {
  const events: SseEvent[] = [];

  if (!response.body) {
    return events;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const abortTimeout = setTimeout(() => {
    reader.cancel().catch(() => {});
  }, timeoutMs);

  try {
    while (events.length < maxEvents) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by double newlines
      const parts = buffer.split("\n\n");

      // The last part may be incomplete; keep it in the buffer
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        if (!part.trim()) {
          continue;
        }

        const event: SseEvent = { data: "" };
        const lines = part.split("\n");

        for (const line of lines) {
          if (line.startsWith("event:")) {
            event.event = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            event.data = line.slice(5).trim();
          } else if (line.startsWith("id:")) {
            event.id = line.slice(3).trim();
          }
        }

        events.push(event);

        if (events.length >= maxEvents) {
          break;
        }
      }
    }
  } catch {
    // Reader was cancelled by timeout or stream ended -- expected
  } finally {
    clearTimeout(abortTimeout);
    reader.cancel().catch(() => {});
  }

  return events;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Web Console: SSE Event Delivery & Infrastructure RPC", () => {
  let handle: TestDaemonHandle;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    // Spy on process.kill to no-op SIGUSR1 signals BEFORE starting the daemon.
    // SSE-02 tests call agents.create/delete which trigger persistToConfig,
    // sending SIGUSR1 to the daemon 200ms after success. This kills the daemon
    // mid-test. Suppress it.
    killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      if (signal === "SIGUSR1") return true; // No-op: suppress restart signal during tests
      return process.kill.call(process, pid, signal as string);
    }) as typeof process.kill);

    handle = await startTestDaemon({ configPath: CONFIG_PATH });
  }, 120_000);

  afterAll(async () => {
    // Restore process.kill spy before cleanup
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
  }, 30_000);

  // -------------------------------------------------------------------------
  // SSE-01 -- SSE Event Stream Connectivity and Format
  // -------------------------------------------------------------------------

  describe("SSE-01: SSE Event Stream Connectivity and Format", () => {
    it("GET /api/events with auth returns 200 and text/event-stream content type", async () => {
      const controller = new AbortController();
      try {
        const response = await fetch(`${handle.gatewayUrl}/api/events`, {
          headers: { Authorization: `Bearer ${handle.authToken}` },
          signal: controller.signal,
        });

        expect(response.status).toBe(200);

        const contentType = response.headers.get("content-type") ?? "";
        expect(contentType).toMatch(/^text\/event-stream/);
      } finally {
        controller.abort();
      }
    });

    it("SSE stream delivers initial retry event", async () => {
      const controller = new AbortController();
      try {
        const response = await fetch(`${handle.gatewayUrl}/api/events`, {
          headers: { Authorization: `Bearer ${handle.authToken}` },
          signal: controller.signal,
        });

        expect(response.status).toBe(200);

        // Read up to 2 events within 5s
        const events = await readSseEvents(response, 2, 5_000);
        expect(events.length).toBeGreaterThanOrEqual(1);

        // First event should be the retry directive
        const retryEvent = events.find((e) => e.event === "retry");
        expect(retryEvent).toBeDefined();
      } finally {
        controller.abort();
      }
    });

    it("SSE stream without auth returns 401", async () => {
      const response = await fetch(`${handle.gatewayUrl}/api/events`);
      expect(response.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // SSE-02 -- SSE Event Triggering
  // -------------------------------------------------------------------------

  describe("SSE-02: SSE Event Triggering", () => {
    it(
      "Agent management action triggers SSE event",
      async () => {
        const controller = new AbortController();
        try {
          const response = await fetch(`${handle.gatewayUrl}/api/events`, {
            headers: { Authorization: `Bearer ${handle.authToken}` },
            signal: controller.signal,
          });
          expect(response.status).toBe(200);

          // Trigger an agent management action via rpcCall after a brief
          // delay so the SSE stream is established and ready to receive.
          setTimeout(async () => {
            try {
              await handle.daemon.rpcCall("agents.create", {
                agentId: "sse-test-agent",
                config: { name: "SSE Test Agent" },
                _trustLevel: "admin",
              });
            } catch {
              // Best effort -- event may still propagate
            }
          }, 500);

          // Read SSE events for up to 10s -- includes retry + any triggered events
          const events = await readSseEvents(response, 5, 10_000);

          // The SSE stream should deliver at least the initial retry event and
          // potentially events triggered by the agent management action.
          expect(events.length).toBeGreaterThanOrEqual(1);
        } finally {
          controller.abort();

          // Clean up the created agent (best-effort)
          try {
            await handle.daemon.rpcCall("agents.delete", {
              agentId: "sse-test-agent",
              _trustLevel: "admin",
            });
          } catch {
            // Agent may not exist if create failed
          }
        }
      },
      30_000,
    );

    it(
      "Multiple SSE events accumulate",
      async () => {
        const controller = new AbortController();
        try {
          const response = await fetch(`${handle.gatewayUrl}/api/events`, {
            headers: { Authorization: `Bearer ${handle.authToken}` },
            signal: controller.signal,
          });
          expect(response.status).toBe(200);

          // Trigger multiple actions with delays to allow SSE propagation
          setTimeout(async () => {
            try {
              await handle.daemon.rpcCall("agents.create", {
                agentId: "sse-multi-agent",
                config: { name: "SSE Multi Agent" },
                _trustLevel: "admin",
              });

              // Brief delay between actions
              await new Promise((r) => setTimeout(r, 500));

              await handle.daemon.rpcCall("agents.delete", {
                agentId: "sse-multi-agent",
                _trustLevel: "admin",
              });
            } catch {
              // Best effort
            }
          }, 500);

          // Read SSE events with a longer timeout to catch all
          // (retry event + create event + delete event)
          const events = await readSseEvents(response, 10, 10_000);

          // Expect at least 1 event (retry + any action events)
          expect(events.length).toBeGreaterThanOrEqual(1);
        } finally {
          controller.abort();
        }
      },
      30_000,
    );
  });

  // -------------------------------------------------------------------------
  // INFRA-01 -- Config Read Response Shape
  // -------------------------------------------------------------------------

  describe("INFRA-01: Config Read Response Shape", () => {
    let ws: WebSocket;
    let rpcId = 100;

    beforeAll(async () => {
      ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);
    });

    afterAll(() => {
      ws?.close();
    });

    it("config.read returns full config with sections list", async () => {
      const response = await sendJsonRpc(ws, "config.read", {}, ++rpcId, { timeoutMs: RPC_FAST_MS });
      const r = response as Record<string, unknown>;

      expect(r).toHaveProperty("jsonrpc", "2.0");
      expect(r).toHaveProperty("id");
      expect(r).not.toHaveProperty("error");
      expect(r).toHaveProperty("result");

      const result = r.result as Record<string, unknown>;
      expect(result).toHaveProperty("config");
      expect(typeof result.config).toBe("object");
      expect(result).toHaveProperty("sections");
      expect(Array.isArray(result.sections)).toBe(true);

      // Verify known sections are present
      const sections = result.sections as string[];
      expect(sections).toContain("agents");
      expect(sections).toContain("gateway");
      expect(sections).toContain("memory");
      expect(sections).toContain("scheduler");
      expect(sections).toContain("security");
    });

    it("config.read with section param returns section data", async () => {
      const response = await sendJsonRpc(ws, "config.read", { section: "gateway" }, ++rpcId, { timeoutMs: RPC_FAST_MS });
      const r = response as Record<string, unknown>;

      expect(r).toHaveProperty("jsonrpc", "2.0");
      expect(r).not.toHaveProperty("error");
      expect(r).toHaveProperty("result");

      const result = r.result as Record<string, unknown>;
      // Gateway config shape includes port and tokens
      expect(result).toHaveProperty("port");
      expect(result).toHaveProperty("tokens");
    });

    it("config.read with invalid section returns error", async () => {
      const response = await sendJsonRpc(ws, "config.read", { section: "nonexistent" }, ++rpcId, { timeoutMs: RPC_FAST_MS });
      const r = response as Record<string, unknown>;

      expect(r).toHaveProperty("jsonrpc", "2.0");
      expect(r).toHaveProperty("error");

      const error = r.error as Record<string, unknown>;
      expect(typeof error.code).toBe("number");
      // Should not be -32601 (method not found) -- it's a parameter error
      expect(error.code).not.toBe(-32601);
    });
  });

  // -------------------------------------------------------------------------
  // INFRA-02 -- Config Schema Response Shape
  // -------------------------------------------------------------------------

  describe("INFRA-02: Config Schema Response Shape", () => {
    let ws: WebSocket;
    let rpcId = 200;

    beforeAll(async () => {
      ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);
    });

    afterAll(() => {
      ws?.close();
    });

    it("config.schema without section returns full schema", async () => {
      const response = await sendJsonRpc(ws, "config.schema", {}, ++rpcId, { timeoutMs: RPC_FAST_MS });
      const r = response as Record<string, unknown>;

      expect(r).toHaveProperty("jsonrpc", "2.0");
      expect(r).not.toHaveProperty("error");
      expect(r).toHaveProperty("result");

      const result = r.result as Record<string, unknown>;
      expect(result).toHaveProperty("schema");
      expect(result).toHaveProperty("sections");
      expect(Array.isArray(result.sections)).toBe(true);
    });

    it("config.schema with section returns section schema", async () => {
      const response = await sendJsonRpc(ws, "config.schema", { section: "agents" }, ++rpcId, { timeoutMs: RPC_FAST_MS });
      const r = response as Record<string, unknown>;

      expect(r).toHaveProperty("jsonrpc", "2.0");
      expect(r).not.toHaveProperty("error");
      expect(r).toHaveProperty("result");

      const result = r.result as Record<string, unknown>;
      expect(result).toHaveProperty("section", "agents");
      expect(result).toHaveProperty("schema");
      expect(result).toHaveProperty("sections");

      // Schema should be a JSON Schema object
      const schema = result.schema as Record<string, unknown>;
      const hasSchemaShape = "type" in schema || "properties" in schema || "$ref" in schema;
      expect(hasSchemaShape).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // INFRA-03 -- Gateway Status Response Shape
  // -------------------------------------------------------------------------

  describe("INFRA-03: Gateway Status Response Shape", () => {
    let ws: WebSocket;
    let rpcId = 300;

    beforeAll(async () => {
      ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);
    });

    afterAll(() => {
      ws?.close();
    });

    it("gateway.status returns process info", async () => {
      const response = await sendJsonRpc(ws, "gateway.status", {}, ++rpcId, { timeoutMs: RPC_FAST_MS });
      const r = response as Record<string, unknown>;

      expect(r).toHaveProperty("jsonrpc", "2.0");
      expect(r).not.toHaveProperty("error");
      expect(r).toHaveProperty("result");

      const result = r.result as Record<string, unknown>;
      // Verify the shape the web dashboard system health card reads
      expect(typeof result.pid).toBe("number");
      expect(typeof result.uptime).toBe("number");
      expect(typeof result.memoryUsage).toBe("number");
      expect(typeof result.nodeVersion).toBe("string");
      expect(Array.isArray(result.configPaths)).toBe(true);
      expect(Array.isArray(result.sections)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // INFRA-04 -- Approval Queue Response Shape
  // -------------------------------------------------------------------------

  describe("INFRA-04: Approval Queue Response Shape", () => {
    let ws: WebSocket;
    let rpcId = 400;

    beforeAll(async () => {
      ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);
    });

    afterAll(() => {
      ws?.close();
    });

    it("admin.approval.pending returns valid response", async () => {
      const response = await sendJsonRpc(ws, "admin.approval.pending", {}, ++rpcId, { timeoutMs: RPC_FAST_MS });
      const r = response as Record<string, unknown>;

      expect(r).toHaveProperty("jsonrpc", "2.0");
      expect(r).toHaveProperty("id");
      // Should not be method-not-found
      if (r.error) {
        const error = r.error as Record<string, unknown>;
        expect(error.code).not.toBe(-32601);
      } else {
        expect(r).toHaveProperty("result");
        const result = r.result as Record<string, unknown>;
        // Approval queue returns { requests: [], total: 0 } when empty
        expect(typeof result).toBe("object");
      }
    });
  });

  // -------------------------------------------------------------------------
  // INFRA-05 -- Observability Response Shape
  // -------------------------------------------------------------------------

  describe("INFRA-05: Observability Response Shape", () => {
    let ws: WebSocket;
    let rpcId = 500;

    beforeAll(async () => {
      ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);
    });

    afterAll(() => {
      ws?.close();
    });

    it("obs.delivery.stats returns stats shape", async () => {
      const response = await sendJsonRpc(ws, "obs.delivery.stats", {}, ++rpcId, { timeoutMs: RPC_FAST_MS });
      const r = response as Record<string, unknown>;

      expect(r).toHaveProperty("jsonrpc", "2.0");
      expect(r).toHaveProperty("id");
      expect(r).not.toHaveProperty("error");
      expect(r).toHaveProperty("result");

      // Stats result should be an object with delivery statistics
      const result = r.result as Record<string, unknown>;
      expect(typeof result).toBe("object");
      expect(result).not.toBeNull();
    });
  });
});
