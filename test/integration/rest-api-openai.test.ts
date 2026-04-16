/**
 * REST-API-OPENAI: REST API Chat and OpenAI-Compatible API E2E Tests
 *
 * Tests the daemon's REST API /api/chat endpoint and OpenAI-compatible
 * /v1/chat/completions (non-streaming and streaming), /v1/models endpoints
 * against a running daemon with real LLM providers.
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
  "../config/config.test-rest-api-openai.yaml",
);

const env = getProviderEnv();
const hasLlmKey = hasAnyProvider(env, PROVIDER_GROUPS.llm);

// ---------------------------------------------------------------------------
// SSE chunk parser helper
// ---------------------------------------------------------------------------

interface OpenAIChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: string; content?: string };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Read OpenAI SSE chunks from a streaming fetch response.
 *
 * Parses `data: {json}` lines and `data: [DONE]` terminal marker.
 * Returns parsed JSON chunks (excluding [DONE]).
 */
async function readOpenAISSEChunks(
  response: Response,
  timeoutMs: number,
): Promise<OpenAIChunk[]> {
  const chunks: OpenAIChunk[] = [];

  if (!response.body) {
    return chunks;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const deadline = Date.now() + timeoutMs;

  try {
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Split on newlines and process complete lines
      const lines = buffer.split("\n");
      // Keep last potentially incomplete line in buffer
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (trimmed.startsWith("data:")) {
          const data = trimmed.slice(5).trim();

          if (data === "[DONE]") {
            return chunks;
          }

          try {
            const parsed = JSON.parse(data) as OpenAIChunk;
            chunks.push(parsed);
          } catch {
            // Malformed JSON line -- skip
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe.skipIf(!hasLlmKey)(
  "REST-API-OPENAI: REST API Chat and OpenAI-Compatible API",
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
    // RESTAPI-01: REST API /api/chat with real LLM
    // -----------------------------------------------------------------------

    it(
      "RESTAPI-01: POST /api/chat returns real LLM response",
      async () => {
        const response = await fetch(`${handle.gatewayUrl}/api/chat`, {
          method: "POST",
          headers: makeAuthHeaders(handle.authToken),
          body: JSON.stringify({ message: "Respond with exactly one word." }),
        });

        expect(response.status).toBe(200);

        const body = (await response.json()) as { response: string };
        expect(typeof body.response).toBe("string");
        expect(body.response.length).toBeGreaterThan(0);
      },
      90_000,
    );

    // -----------------------------------------------------------------------
    // OPENAI-01: Non-streaming /v1/chat/completions
    // -----------------------------------------------------------------------

    it(
      "OPENAI-01: POST /v1/chat/completions returns valid ChatCompletion",
      async () => {
        const response = await fetch(
          `${handle.gatewayUrl}/v1/chat/completions`,
          {
            method: "POST",
            headers: makeAuthHeaders(handle.authToken),
            body: JSON.stringify({
              model: "anthropic/claude-sonnet-4-5-20250929",
              messages: [
                { role: "user", content: "Say exactly one word." },
              ],
            }),
          },
        );

        expect(response.status).toBe(200);

        const body = (await response.json()) as Record<string, unknown>;

        // Verify ChatCompletion structure
        expect(body.id).toMatch(/^chatcmpl-/);
        expect(body.object).toBe("chat.completion");
        expect(typeof body.created).toBe("number");

        // Verify choices
        const choices = body.choices as Array<{
          index: number;
          message: { role: string; content: string };
          finish_reason: string;
        }>;
        expect(choices.length).toBe(1);
        expect(choices[0].message.role).toBe("assistant");
        expect(typeof choices[0].message.content).toBe("string");
        expect(choices[0].message.content.length).toBeGreaterThan(0);
        expect(["stop", "length"]).toContain(choices[0].finish_reason);

        // Verify usage
        const usage = body.usage as {
          prompt_tokens: number;
          completion_tokens: number;
          total_tokens: number;
        };
        expect(usage.prompt_tokens).toBeGreaterThan(0);
        expect(usage.completion_tokens).toBeGreaterThan(0);
        expect(usage.total_tokens).toBeGreaterThan(0);
      },
      90_000,
    );

    // -----------------------------------------------------------------------
    // OPENAI-02: Streaming /v1/chat/completions
    // -----------------------------------------------------------------------

    it(
      "OPENAI-02: POST /v1/chat/completions with stream:true returns SSE chunks",
      async () => {
        const response = await fetch(
          `${handle.gatewayUrl}/v1/chat/completions`,
          {
            method: "POST",
            headers: makeAuthHeaders(handle.authToken),
            body: JSON.stringify({
              model: "anthropic/claude-sonnet-4-5-20250929",
              messages: [
                { role: "user", content: "Say exactly one word." },
              ],
              stream: true,
            }),
          },
        );

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain(
          "text/event-stream",
        );

        const chunks = await readOpenAISSEChunks(response, 90_000);

        // Should have at least 2 chunks (role + content)
        expect(chunks.length).toBeGreaterThanOrEqual(2);

        // First chunk should announce role
        expect(chunks[0].choices[0].delta.role).toBe("assistant");
        expect(chunks[0].object).toBe("chat.completion.chunk");

        // At least one chunk should have content
        const contentChunks = chunks.filter(
          (c) =>
            c.choices.length > 0 &&
            typeof c.choices[0].delta.content === "string" &&
            c.choices[0].delta.content.length > 0,
        );
        expect(contentChunks.length).toBeGreaterThan(0);

        // A chunk with finish_reason should exist
        const finishChunks = chunks.filter(
          (c) =>
            c.choices.length > 0 &&
            c.choices[0].finish_reason !== null,
        );
        expect(finishChunks.length).toBeGreaterThan(0);
        expect(["stop", "length"]).toContain(
          finishChunks[0].choices[0].finish_reason,
        );

        // A chunk with usage should exist
        const usageChunks = chunks.filter((c) => c.usage !== undefined);
        expect(usageChunks.length).toBeGreaterThan(0);
        expect(usageChunks[0].usage!.prompt_tokens).toBeGreaterThan(0);
      },
      90_000,
    );

    // -----------------------------------------------------------------------
    // OPENAI-03: GET /v1/models
    // -----------------------------------------------------------------------

    it(
      "OPENAI-03: GET /v1/models returns model list",
      async () => {
        const response = await fetch(`${handle.gatewayUrl}/v1/models`, {
          method: "GET",
          headers: makeAuthHeaders(handle.authToken),
        });

        expect(response.status).toBe(200);

        const body = (await response.json()) as {
          object: string;
          data: Array<{
            id: string;
            object: string;
            created: number;
            owned_by: string;
          }>;
        };

        expect(body.object).toBe("list");
        expect(Array.isArray(body.data)).toBe(true);
        expect(body.data.length).toBeGreaterThan(0);

        // Verify first model structure
        const model = body.data[0];
        expect(typeof model.id).toBe("string");
        expect(model.object).toBe("model");
        expect(typeof model.owned_by).toBe("string");
      },
      90_000,
    );

    // -----------------------------------------------------------------------
    // OPENAI-04: Auth enforcement on /v1/chat/completions
    // -----------------------------------------------------------------------

    it(
      "OPENAI-04: /v1/chat/completions without auth returns 401",
      async () => {
        const response = await fetch(
          `${handle.gatewayUrl}/v1/chat/completions`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "test",
              messages: [{ role: "user", content: "test" }],
            }),
          },
        );

        expect(response.status).toBe(401);

        const body = (await response.json()) as {
          error: { message: string; type: string };
        };
        expect(body.error).toBeDefined();
        expect(body.error.type).toBe("authentication_error");
      },
      90_000,
    );

    // -----------------------------------------------------------------------
    // OPENAI-05: Auth enforcement on /v1/models
    // -----------------------------------------------------------------------

    it(
      "OPENAI-05: GET /v1/models without auth returns 401",
      async () => {
        const response = await fetch(`${handle.gatewayUrl}/v1/models`, {
          method: "GET",
        });

        expect(response.status).toBe(401);
      },
      90_000,
    );
  },
);
