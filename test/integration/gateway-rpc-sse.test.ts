// SPDX-License-Identifier: Apache-2.0
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startTestDaemon,
  makeAuthHeaders,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import { openAuthenticatedWebSocket, sendJsonRpc } from "../support/ws-helpers.js";
import { RPC_FAST_MS } from "../support/timeouts.js";
import { getProviderEnv, hasAnyProvider, PROVIDER_GROUPS } from "../support/provider-env.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = resolve(__dirname, "../config/config.test-gateway-rpc-sse.yaml");

const env = getProviderEnv();
const hasLlmKey = hasAnyProvider(env, PROVIDER_GROUPS.llm);

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
          // retry: directives are part of the SSE spec but we capture event name
        }

        events.push(event);

        if (events.length >= maxEvents) {
          break;
        }
      }
    }
  } catch {
    // Reader was cancelled by timeout or stream ended — expected
  } finally {
    clearTimeout(abortTimeout);
    reader.cancel().catch(() => {});
  }

  return events;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Gateway: WebSocket RPC, Chat API, and SSE Streaming", () => {
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
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("Daemon exit with code")) {
          throw err;
        }
      }
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // GATE-03 — Authenticated WebSocket JSON-RPC
  // -------------------------------------------------------------------------

  describe("GATE-03: Authenticated WebSocket JSON-RPC", () => {
    it("WebSocket connects with valid token", async () => {
      let ws: WebSocket | undefined;
      try {
        ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);
        expect(ws.readyState).toBe(WebSocket.OPEN);
      } finally {
        ws?.close();
      }
    });

    it("JSON-RPC config.get returns data over WebSocket", async () => {
      let ws: WebSocket | undefined;
      try {
        ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);

        const response = (await sendJsonRpc(ws, "config.get", {}, 1, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

        expect(response).toHaveProperty("jsonrpc", "2.0");
        expect(response).toHaveProperty("id", 1);
        expect(response).toHaveProperty("result");
        expect(response).not.toHaveProperty("error");
        expect(typeof response.result).toBe("object");
      } finally {
        ws?.close();
      }
    });

    it("JSON-RPC invalid method returns error over WebSocket", async () => {
      let ws: WebSocket | undefined;
      try {
        ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);

        const response = (await sendJsonRpc(ws, "nonexistent.method", {}, 2, { timeoutMs: RPC_FAST_MS })) as Record<
          string,
          unknown
        >;

        expect(response).toHaveProperty("error");
        const error = response.error as Record<string, unknown>;
        expect(typeof error.code).toBe("number");
      } finally {
        ws?.close();
      }
    });
  });

  // -------------------------------------------------------------------------
  // GATE-05 — POST /api/chat
  // -------------------------------------------------------------------------

  describe("GATE-05: POST /api/chat", () => {
    it(
      "POST /api/chat with valid message returns agent response",
      async () => {
        const response = await fetch(`${handle.gatewayUrl}/api/chat`, {
          method: "POST",
          headers: makeAuthHeaders(handle.authToken),
          body: JSON.stringify({ message: "Say exactly: GATEWAY_TEST_OK" }),
        });

        expect(response.status).toBe(200);

        const body = (await response.json()) as Record<string, unknown>;
        expect(typeof body.response).toBe("string");
        expect((body.response as string).length).toBeGreaterThan(0);
        expect(typeof body.tokensUsed).toBe("object");
        expect(typeof body.finishReason).toBe("string");
      },
      60_000,
    );

    it("POST /api/chat with missing message returns 400", async () => {
      const response = await fetch(`${handle.gatewayUrl}/api/chat`, {
        method: "POST",
        headers: makeAuthHeaders(handle.authToken),
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(400);

      const body = (await response.json()) as Record<string, unknown>;
      expect(typeof body.error).toBe("string");
      expect((body.error as string).toLowerCase()).toContain("message");
    });

    it("POST /api/chat with invalid JSON returns 400", async () => {
      const response = await fetch(`${handle.gatewayUrl}/api/chat`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${handle.authToken}`,
          "Content-Type": "application/json",
        },
        body: "not valid json {{{",
      });

      expect(response.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // GATE-06 — SSE /api/events
  // -------------------------------------------------------------------------

  describe("GATE-06: SSE /api/events", () => {
    it("GET /api/events returns SSE stream", async () => {
      const controller = new AbortController();
      try {
        const response = await fetch(`${handle.gatewayUrl}/api/events`, {
          headers: { Authorization: `Bearer ${handle.authToken}` },
          signal: controller.signal,
        });

        expect(response.status).toBe(200);

        const contentType = response.headers.get("content-type") ?? "";
        expect(contentType).toMatch(/^text\/event-stream/);

        // Read a few SSE events (the first should be the retry directive)
        const events = await readSseEvents(response, 2, 5_000);
        expect(events.length).toBeGreaterThanOrEqual(1);

        // First event should be the retry directive
        const retryEvent = events.find((e) => e.event === "retry");
        expect(retryEvent).toBeDefined();
      } finally {
        controller.abort();
      }
    });

    it("GET /api/events without auth returns 401", async () => {
      const response = await fetch(`${handle.gatewayUrl}/api/events`);
      expect(response.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // GATE-07 — SSE /api/chat/stream
  // -------------------------------------------------------------------------

  describe.skipIf(!hasLlmKey)("GATE-07: SSE /api/chat/stream", () => {
    it(
      "GET /api/chat/stream delivers streaming response",
      async () => {
        const controller = new AbortController();
        try {
          const url = `${handle.gatewayUrl}/api/chat/stream?message=${encodeURIComponent("Say exactly: STREAM_OK")}&token=${encodeURIComponent(handle.authToken)}`;

          const response = await fetch(url, {
            signal: controller.signal,
          });

          expect(response.status).toBe(200);

          const contentType = response.headers.get("content-type") ?? "";
          expect(contentType).toMatch(/^text\/event-stream/);

          // Read SSE events — expect a "done" event with the agent response
          const events = await readSseEvents(response, 20, 60_000);

          // There should be at least one event with type "done"
          const doneEvent = events.find((e) => e.event === "done");
          expect(doneEvent).toBeDefined();
          expect(doneEvent!.data).toBeTruthy();

          // The done event data should be valid JSON with a response field
          const doneData = JSON.parse(doneEvent!.data) as Record<string, unknown>;
          expect(doneData).toHaveProperty("response");
          expect(typeof doneData.response).toBe("string");
        } finally {
          controller.abort();
        }
      },
      90_000,
    );
  });
});
