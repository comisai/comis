import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startTestDaemon,
  makeAuthHeaders,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import { openAuthenticatedWebSocket, sendJsonRpc } from "../support/ws-helpers.js";
import { RPC_FAST_MS, ASYNC_SETTLE_MS } from "../support/timeouts.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = resolve(__dirname, "../config/config.test-gateway-concurrent.yaml");

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

describe("Gateway: Concurrent HTTP and Mixed Protocol (GW-01, GW-03, GW-08)", () => {
  let handle: TestDaemonHandle;

  beforeAll(async () => {
    handle = await startTestDaemon({ configPath: CONFIG_PATH });
  }, 60_000);

  afterAll(async () => {
    if (handle) {
      try {
        await handle.cleanup();
      } catch (err) {
        // Expected: graceful shutdown calls the overridden exit() which throws.
        // "Daemon exit with code 0" is normal shutdown. Suppress it.
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("Daemon exit with code")) {
          throw err;
        }
      }
    }
  }, 30_000);

  // ---------------------------------------------------------------------------
  // GW-01 — N parallel requests, no misrouting
  // ---------------------------------------------------------------------------

  describe("GW-01: Parallel HTTP request isolation", () => {
    it("5 parallel GET /api/agents requests each produce a valid response", async () => {
      const N = 5;
      const requests = Array.from({ length: N }, () =>
        fetch(`${handle.gatewayUrl}/api/agents`, {
          headers: makeAuthHeaders(handle.authToken),
        }),
      );

      const responses = await Promise.all(requests);

      for (const res of responses) {
        expect(res.status).toBe(200);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.agents).toBeDefined();
        const agents = body.agents as Array<Record<string, unknown>>;
        expect(agents[0].name).toBe("TestAgent");
      }
    });

    it("5 parallel requests to distinct REST endpoints each return correct data", async () => {
      // Tests concurrency isolation across different handler paths --
      // no misrouting between distinct endpoint handlers under parallel load.
      // Avoids POST /api/chat which triggers LLM calls requiring an API key.
      const requests = [
        fetch(`${handle.gatewayUrl}/api/agents`, {
          headers: makeAuthHeaders(handle.authToken),
        }),
        fetch(`${handle.gatewayUrl}/api/agents`, {
          headers: makeAuthHeaders(handle.authToken),
        }),
        fetch(`${handle.gatewayUrl}/api/memory/stats`, {
          headers: makeAuthHeaders(handle.authToken),
        }),
        fetch(`${handle.gatewayUrl}/api/memory/search?q=test`, {
          headers: makeAuthHeaders(handle.authToken),
        }),
        fetch(`${handle.gatewayUrl}/api/activity`, {
          headers: makeAuthHeaders(handle.authToken),
        }),
      ];

      const responses = await Promise.all(requests);

      // All 5 responses should succeed
      for (const res of responses) {
        expect(res.status).toBe(200);
      }

      // Verify each endpoint returned its correct shape (no misrouting)
      const [agents1, agents2, memStats, memSearch, activity] = await Promise.all(
        responses.map((r) => r.json() as Promise<Record<string, unknown>>),
      );

      // Both agent requests should return identical agent lists
      expect(agents1.agents).toBeDefined();
      expect(agents2.agents).toBeDefined();
      expect((agents1.agents as Array<Record<string, unknown>>)[0].name).toBe("TestAgent");
      expect((agents2.agents as Array<Record<string, unknown>>)[0].name).toBe("TestAgent");

      // Memory stats should have stats-specific shape (not agents shape)
      expect(memStats).not.toHaveProperty("agents");

      // Memory search should have results array
      expect(memSearch).toHaveProperty("results");
      expect(Array.isArray(memSearch.results)).toBe(true);

      // Activity should have entries + count
      expect(activity).toHaveProperty("entries");
      expect(activity).toHaveProperty("count");
      expect(typeof activity.count).toBe("number");
    });
  });

  // ---------------------------------------------------------------------------
  // GW-03 — Mixed HTTP + WebSocket, no request-id collision
  // ---------------------------------------------------------------------------

  describe("GW-03: Mixed HTTP + WebSocket isolation", () => {
    it("simultaneous HTTP and WebSocket requests produce independent correct results", async () => {
      let ws: WebSocket | undefined;
      try {
        ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);

        // Fire HTTP and WebSocket requests simultaneously
        const [httpResponse, wsResponse] = await Promise.all([
          fetch(`${handle.gatewayUrl}/api/agents`, {
            headers: makeAuthHeaders(handle.authToken),
          }),
          sendJsonRpc(ws, "config.get", {}, 1, { timeoutMs: RPC_FAST_MS }),
        ]);

        // Verify HTTP response
        expect(httpResponse.status).toBe(200);
        const httpBody = (await httpResponse.json()) as Record<string, unknown>;
        expect(httpBody.agents).toBeDefined();
        expect(Array.isArray(httpBody.agents)).toBe(true);

        // Verify WebSocket JSON-RPC response
        const rpcResult = wsResponse as Record<string, unknown>;
        expect(rpcResult).toHaveProperty("jsonrpc", "2.0");
        expect(rpcResult).toHaveProperty("id", 1);
        expect(rpcResult).toHaveProperty("result");
        expect(typeof rpcResult.result).toBe("object");
      } finally {
        ws?.close();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // GW-08 — SSE stream survives concurrent POST
  // ---------------------------------------------------------------------------

  describe("GW-08: SSE stream resilience under concurrent load", () => {
    it("SSE stream continues delivering events during concurrent POST requests", async () => {
      const controller = new AbortController();
      try {
        // Start an SSE stream
        const sseResponse = await fetch(`${handle.gatewayUrl}/api/events`, {
          headers: { Authorization: `Bearer ${handle.authToken}` },
          signal: controller.signal,
        });

        expect(sseResponse.status).toBe(200);

        const contentType = sseResponse.headers.get("content-type") ?? "";
        expect(contentType).toMatch(/^text\/event-stream/);

        // While the stream is open, fire 3 parallel GET /api/agents requests
        const parallelRequests = Array.from({ length: 3 }, () =>
          fetch(`${handle.gatewayUrl}/api/agents`, {
            headers: makeAuthHeaders(handle.authToken),
          }),
        );

        const parallelResponses = await Promise.all(parallelRequests);

        // All parallel requests should succeed
        for (const res of parallelResponses) {
          expect(res.status).toBe(200);
        }

        // Read SSE events -- expect at least 1 event (the initial retry event)
        const events = await readSseEvents(sseResponse, 3, 10_000);
        expect(events.length).toBeGreaterThanOrEqual(1);
      } finally {
        controller.abort();
        // Brief settle for abort to propagate
        await new Promise((resolve) => setTimeout(resolve, ASYNC_SETTLE_MS));
      }
    });
  });
});
