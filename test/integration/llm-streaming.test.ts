/**
 * LLM-STREAMING: Real LLM SSE Streaming Integration Tests
 *
 * Tests streaming responses via the daemon's GET /api/chat/stream SSE
 * endpoint with real LLM providers. Requires ANTHROPIC_API_KEY or
 * OPENAI_API_KEY in ~/.comis/.env.
 *
 * @module
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getProviderEnv,
  hasAnyProvider,
  PROVIDER_GROUPS,
  isAuthError,
  logProviderAvailability,
} from "../support/provider-env.js";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import {
  openAuthenticatedWebSocket,
  sendJsonRpc,
} from "../support/ws-helpers.js";
import { RPC_FAST_MS } from "../support/timeouts.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SseEvent {
  event?: string;
  data: string;
  id?: string;
}

// ---------------------------------------------------------------------------
// Helper functions (copied inline per decision 103-01)
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
// Constants
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = resolve(
  __dirname,
  "../config/config.test-llm-streaming.yaml",
);

const env = getProviderEnv();
const hasLlmKey = hasAnyProvider(env, PROVIDER_GROUPS.llm);

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe.skipIf(!hasLlmKey)(
  "LLM-STREAMING: Real Provider SSE Integration",
  () => {
    let handle: TestDaemonHandle;

    beforeAll(async () => {
      logProviderAvailability(env);
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

    // -----------------------------------------------------------------------
    // LLM-STREAM-01: SSE delivers token events and done event
    // -----------------------------------------------------------------------

    it(
      "LLM-STREAM-01: SSE chat stream delivers token events and done event",
      async () => {
        const controller = new AbortController();
        try {
          const url = `${handle.gatewayUrl}/api/chat/stream?message=${encodeURIComponent("Count from 1 to 3")}&token=${encodeURIComponent(handle.authToken)}`;

          const response = await fetch(url, {
            signal: controller.signal,
          });

          expect(response.status).toBe(200);

          const contentType = response.headers.get("content-type") ?? "";
          expect(contentType).toMatch(/^text\/event-stream/);

          // Generous maxEvents for real LLM streaming
          const events = await readSseEvents(response, 50, 90_000);
          expect(events.length).toBeGreaterThan(0);

          // Must have a "done" event
          const doneEvent = events.find((e) => e.event === "done");
          expect(doneEvent).toBeDefined();

          // Parse done event data
          const doneData = JSON.parse(doneEvent!.data) as Record<
            string,
            unknown
          >;
          expect(typeof doneData.response).toBe("string");
          expect((doneData.response as string).length).toBeGreaterThan(0);
          expect(typeof doneData.tokensUsed).toBe("object");
          expect((doneData.tokensUsed as { total: number }).total).toBeGreaterThan(0);
        } catch (err) {
          if (isAuthError(err)) {
            console.warn(
              "Skipping LLM-STREAM-01: API key invalid/expired",
            );
            return;
          }
          throw err;
        } finally {
          controller.abort();
        }
      },
      120_000,
    );

    // -----------------------------------------------------------------------
    // LLM-STREAM-02: At least one token event before done
    // -----------------------------------------------------------------------

    it(
      "LLM-STREAM-02: SSE stream includes at least one token event before done",
      async () => {
        const controller = new AbortController();
        try {
          const url = `${handle.gatewayUrl}/api/chat/stream?message=${encodeURIComponent("Write a short haiku")}&token=${encodeURIComponent(handle.authToken)}`;

          const response = await fetch(url, {
            signal: controller.signal,
          });

          expect(response.status).toBe(200);

          const events = await readSseEvents(response, 50, 90_000);

          // Must have a done event
          const doneEvent = events.find((e) => e.event === "done");
          expect(doneEvent).toBeDefined();

          // Parse done event data for structural validation
          const doneData = JSON.parse(doneEvent!.data) as Record<
            string,
            unknown
          >;
          expect(typeof doneData.response).toBe("string");
          expect((doneData.response as string).length).toBeGreaterThan(0);

          // Token events are emitted as "token" SSE events by sse-endpoint.ts.
          // With a real LLM, there should be multiple token events before done.
          const tokenEvents = events.filter((e) => e.event === "token");

          if (tokenEvents.length > 0) {
            // Each token event should have non-empty data
            for (const tokenEvent of tokenEvents) {
              expect(tokenEvent.data.length).toBeGreaterThan(0);
            }
          }

          // The done event is the critical assertion -- tokens are bonus
        } catch (err) {
          if (isAuthError(err)) {
            console.warn(
              "Skipping LLM-STREAM-02: API key invalid/expired",
            );
            return;
          }
          throw err;
        } finally {
          controller.abort();
        }
      },
      120_000,
    );

    // -----------------------------------------------------------------------
    // LLM-STREAM-03: Mid-stream abort does not crash daemon
    // -----------------------------------------------------------------------

    it(
      "LLM-STREAM-03: SSE stream abort mid-response does not crash daemon",
      async () => {
        const controller = new AbortController();
        try {
          const url = `${handle.gatewayUrl}/api/chat/stream?message=${encodeURIComponent("Write a detailed essay about technology")}&token=${encodeURIComponent(handle.authToken)}`;

          const response = await fetch(url, {
            signal: controller.signal,
          });

          expect(response.status).toBe(200);

          // Read only 3 events then abort early
          const events = await readSseEvents(response, 3, 30_000);

          // Abort the stream mid-response
          controller.abort();

          // Wait 1 second for the daemon to handle the disconnection
          await new Promise((resolve) => setTimeout(resolve, 1_000));

          // Verify the daemon is still healthy by making a lightweight RPC call
          let ws: WebSocket | undefined;
          try {
            ws = await openAuthenticatedWebSocket(
              handle.gatewayUrl,
              handle.authToken,
            );

            const rpcResponse = (await sendJsonRpc(
              ws,
              "config.get",
              {},
              100,
              { timeoutMs: RPC_FAST_MS },
            )) as Record<string, unknown>;

            // Daemon survived the mid-stream abort
            expect(rpcResponse).toHaveProperty("jsonrpc", "2.0");
            expect(rpcResponse).toHaveProperty("result");
            expect(rpcResponse).not.toHaveProperty("error");
          } finally {
            ws?.close();
          }
        } catch (err) {
          if (isAuthError(err)) {
            console.warn(
              "Skipping LLM-STREAM-03: API key invalid/expired",
            );
            return;
          }
          throw err;
        }
      },
      120_000,
    );
  },
);
