/**
 * OPENRESPONSES-API: OpenResponses /v1/responses E2E Tests
 *
 * Tests the daemon's OpenResponses /v1/responses endpoint for both
 * non-streaming (JSON ResponseObject) and streaming (SSE semantic events)
 * response modes against a running daemon with real LLM providers.
 *
 * Requires ANTHROPIC_API_KEY or OPENAI_API_KEY in ~/.comis/.env.
 * Skips entirely when no LLM API keys are available.
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
  logProviderAvailability,
} from "../support/provider-env.js";
import {
  startTestDaemon,
  makeAuthHeaders,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = resolve(
  __dirname,
  "../config/config.test-openresponses.yaml",
);

const env = getProviderEnv();
const hasLlmKey = hasAnyProvider(env, PROVIDER_GROUPS.llm);

// ---------------------------------------------------------------------------
// Inline SSE parser for OpenResponses semantic events
// ---------------------------------------------------------------------------

/**
 * Read OpenResponses SSE events from a streaming fetch response.
 *
 * Parses `data: {json}` lines and `data: [DONE]` terminal marker.
 * Returns parsed JSON event objects and the raw text for [DONE] verification.
 */
async function readResponsesSSE(
  response: Response,
  timeoutMs: number,
): Promise<{ events: Record<string, unknown>[]; rawText: string }> {
  const events: Record<string, unknown>[] = [];
  if (!response.body) return { events, rawText: "" };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";

  const abortTimeout = setTimeout(() => {
    reader.cancel().catch(() => {});
  }, timeoutMs);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;
      fullText += chunk;

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          clearTimeout(abortTimeout);
          return { events, rawText: fullText };
        }
        try {
          events.push(JSON.parse(data));
        } catch {
          /* skip partial JSON */
        }
      }
    }
  } catch {
    /* cancelled or stream ended */
  } finally {
    clearTimeout(abortTimeout);
    reader.cancel().catch(() => {});
  }

  return { events, rawText: fullText };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe.skipIf(!hasLlmKey)(
  "OpenResponses /v1/responses E2E",
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
    // RESP-01: Non-streaming /v1/responses
    // -----------------------------------------------------------------------

    it(
      "RESP-01: POST /v1/responses returns valid ResponseObject",
      async () => {
        const response = await fetch(`${handle.gatewayUrl}/v1/responses`, {
          method: "POST",
          headers: makeAuthHeaders(handle.authToken),
          body: JSON.stringify({
            model: "anthropic/claude-sonnet-4-5-20250929",
            input: "Respond with exactly one word.",
          }),
        });

        expect(response.status).toBe(200);

        const body = (await response.json()) as Record<string, unknown>;

        // Verify ResponseObject structure
        expect(body.id).toMatch(/^resp_/);
        expect(body.object).toBe("response");
        expect(body.status).toBe("completed");

        // Verify output array
        const output = body.output as Array<Record<string, unknown>>;
        expect(Array.isArray(output)).toBe(true);
        expect(output.length).toBe(1);

        // Verify output message item
        expect(output[0].type).toBe("message");
        expect(output[0].role).toBe("assistant");
        expect(output[0].status).toBe("completed");

        // Verify content array
        const content = output[0].content as Array<Record<string, unknown>>;
        expect(content.length).toBe(1);
        expect(content[0].type).toBe("output_text");
        expect(typeof content[0].text).toBe("string");
        expect((content[0].text as string).length).toBeGreaterThan(0);

        // Verify usage
        const usage = body.usage as Record<string, number>;
        expect(usage.input_tokens).toBeGreaterThan(0);
        expect(usage.output_tokens).toBeGreaterThan(0);
        expect(usage.total_tokens).toBeGreaterThan(0);
      },
      90_000,
    );

    // -----------------------------------------------------------------------
    // RESP-02: Streaming /v1/responses
    // -----------------------------------------------------------------------

    it(
      "RESP-02: POST /v1/responses with stream:true returns semantic SSE event sequence",
      async () => {
        const response = await fetch(`${handle.gatewayUrl}/v1/responses`, {
          method: "POST",
          headers: makeAuthHeaders(handle.authToken),
          body: JSON.stringify({
            model: "anthropic/claude-sonnet-4-5-20250929",
            input: "Say one word.",
            stream: true,
          }),
        });

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain(
          "text/event-stream",
        );

        const { events, rawText } = await readResponsesSSE(response, 90_000);

        // Should have events
        expect(events.length).toBeGreaterThan(0);

        // Extract non-delta event types for semantic sequence verification
        const nonDeltaTypes = events
          .map((e) => e.type as string)
          .filter((t) => t !== "response.output_text.delta");

        // Verify strict 7-event semantic sequence (non-delta events)
        expect(nonDeltaTypes).toEqual([
          "response.in_progress",
          "response.output_item.added",
          "response.content_part.added",
          "response.output_text.done",
          "response.content_part.done",
          "response.output_item.done",
          "response.completed",
        ]);

        // Verify at least 1 delta event exists
        const deltaEvents = events.filter(
          (e) => e.type === "response.output_text.delta",
        );
        expect(deltaEvents.length).toBeGreaterThan(0);

        // Verify delta events are between content_part.added and output_text.done
        const allTypes = events.map((e) => e.type as string);
        const contentPartAddedIdx = allTypes.indexOf(
          "response.content_part.added",
        );
        const outputTextDoneIdx = allTypes.indexOf(
          "response.output_text.done",
        );

        for (let i = 0; i < allTypes.length; i++) {
          if (allTypes[i] === "response.output_text.delta") {
            expect(i).toBeGreaterThan(contentPartAddedIdx);
            expect(i).toBeLessThan(outputTextDoneIdx);
          }
        }

        // Verify monotonic sequence numbers
        for (let i = 1; i < events.length; i++) {
          expect(events[i].sequence_number as number).toBeGreaterThan(
            events[i - 1].sequence_number as number,
          );
        }

        // Verify response.completed has usage with positive total_tokens
        const completedEvent = events.find(
          (e) => e.type === "response.completed",
        );
        expect(completedEvent).toBeDefined();
        const completedResponse = completedEvent!.response as Record<
          string,
          unknown
        >;
        const usage = completedResponse.usage as Record<string, number>;
        expect(usage.total_tokens).toBeGreaterThan(0);

        // Verify [DONE] terminal marker
        expect(rawText).toContain("[DONE]");
      },
      90_000,
    );

    // -----------------------------------------------------------------------
    // RESP-03: Auth enforcement
    // -----------------------------------------------------------------------

    it(
      "RESP-03: POST /v1/responses without auth returns 401",
      async () => {
        const response = await fetch(`${handle.gatewayUrl}/v1/responses`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "test", input: "test" }),
        });

        expect(response.status).toBe(401);

        const body = (await response.json()) as {
          error: { message: string; type: string };
        };
        expect(body.error).toBeDefined();
        expect(body.error.type).toBe("authentication_error");
      },
      10_000,
    );

    // -----------------------------------------------------------------------
    // RESP-04: Request validation
    // -----------------------------------------------------------------------

    it(
      "RESP-04: POST /v1/responses with missing model returns 400",
      async () => {
        const response = await fetch(`${handle.gatewayUrl}/v1/responses`, {
          method: "POST",
          headers: makeAuthHeaders(handle.authToken),
          body: JSON.stringify({ input: "test" }),
        });

        expect(response.status).toBe(400);

        const body = (await response.json()) as {
          error: { message: string; type?: string };
        };
        expect(body.error).toBeDefined();
      },
      10_000,
    );
  },
);
