/**
 * OPENAI-EMBED/ERR: OpenAI Embeddings and Error Format Compliance E2E Tests
 *
 * Tests the daemon's OpenAI-compatible /v1/embeddings endpoint with a real
 * OpenAI embedding provider and validates error format compliance across
 * all /v1/* endpoints (completions, embeddings).
 *
 * Requires OPENAI_API_KEY in ~/.comis/.env.
 * Skips entirely when no OPENAI_API_KEY is available.
 *
 * @module
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getProviderEnv,
  hasProvider,
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
  "../config/config.test-openai-embeddings.yaml",
);

const env = getProviderEnv();
const hasOpenAIKey = hasProvider(env, "OPENAI_API_KEY");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Assert that a response body matches the OpenAI error format.
 *
 * Validates: error.message (non-empty string), error.type (matches expected),
 * error.param (present), error.code (present).
 */
function expectOpenAIError(
  body: Record<string, unknown>,
  expectedType: string,
): void {
  expect(body.error).toBeDefined();
  const error = body.error as Record<string, unknown>;
  expect(typeof error.message).toBe("string");
  expect((error.message as string).length).toBeGreaterThan(0);
  expect(error.type).toBe(expectedType);
  expect(error).toHaveProperty("param");
  expect(error).toHaveProperty("code");
}

// ---------------------------------------------------------------------------
// Test suite -- gated on OPENAI_API_KEY availability
// ---------------------------------------------------------------------------

describe.skipIf(!hasOpenAIKey)(
  "OPENAI-EMBED/ERR: Embeddings and Error Format Compliance",
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
    // Section 1: Embeddings with Real Provider
    // -----------------------------------------------------------------------

    it(
      "EMBED-01: POST /v1/embeddings returns embedding vector for single text",
      async () => {
        const response = await fetch(`${handle.gatewayUrl}/v1/embeddings`, {
          method: "POST",
          headers: makeAuthHeaders(handle.authToken),
          body: JSON.stringify({
            model: "text-embedding-3-small",
            input: "Hello world",
          }),
        });

        expect(response.status).toBe(200);

        const body = (await response.json()) as Record<string, unknown>;

        // Top-level structure
        expect(body.object).toBe("list");
        expect(Array.isArray(body.data)).toBe(true);

        const data = body.data as Array<Record<string, unknown>>;
        expect(data.length).toBe(1);

        // First embedding entry
        const entry = data[0];
        expect(entry.object).toBe("embedding");
        expect(Array.isArray(entry.embedding)).toBe(true);

        const embedding = entry.embedding as unknown[];
        expect(embedding.length).toBeGreaterThan(0);
        expect(entry.index).toBe(0);

        // All values are numbers
        expect(
          embedding.every((v: unknown) => typeof v === "number"),
        ).toBe(true);

        // Usage
        const usage = body.usage as Record<string, unknown>;
        expect((usage.prompt_tokens as number)).toBeGreaterThan(0);
        expect((usage.total_tokens as number)).toBeGreaterThan(0);

        // Model
        expect(typeof body.model).toBe("string");
      },
      90_000,
    );

    it(
      "EMBED-02: POST /v1/embeddings returns multiple embeddings for array input",
      async () => {
        const response = await fetch(`${handle.gatewayUrl}/v1/embeddings`, {
          method: "POST",
          headers: makeAuthHeaders(handle.authToken),
          body: JSON.stringify({
            model: "text-embedding-3-small",
            input: ["Hello", "World", "Test"],
          }),
        });

        expect(response.status).toBe(200);

        const body = (await response.json()) as Record<string, unknown>;

        const data = body.data as Array<Record<string, unknown>>;
        expect(data.length).toBe(3);

        // Verify each entry has correct index and valid embedding
        for (let i = 0; i < 3; i++) {
          expect(data[i].index).toBe(i);
          expect(data[i].object).toBe("embedding");

          const embedding = data[i].embedding as number[];
          expect(Array.isArray(embedding)).toBe(true);
          expect(embedding.length).toBeGreaterThan(0);
          expect(
            embedding.every((v: unknown) => typeof v === "number"),
          ).toBe(true);
        }

        // All embeddings should have consistent dimensions
        const dims = (data as Array<{ embedding: number[] }>).map(
          (d) => d.embedding.length,
        );
        expect(new Set(dims).size).toBe(1);
      },
      90_000,
    );

    it(
      "EMBED-03: POST /v1/embeddings without auth returns 401",
      async () => {
        const response = await fetch(`${handle.gatewayUrl}/v1/embeddings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "text-embedding-3-small",
            input: "Hello",
          }),
        });

        expect(response.status).toBe(401);

        const body = (await response.json()) as Record<string, unknown>;
        expectOpenAIError(body, "authentication_error");
      },
      10_000,
    );

    // -----------------------------------------------------------------------
    // Section 2: Error Format Compliance
    // -----------------------------------------------------------------------

    it(
      "ERR-01: POST /v1/chat/completions with missing messages returns 400",
      async () => {
        const response = await fetch(
          `${handle.gatewayUrl}/v1/chat/completions`,
          {
            method: "POST",
            headers: makeAuthHeaders(handle.authToken),
            body: JSON.stringify({ model: "test" }),
          },
        );

        expect(response.status).toBe(400);

        const body = (await response.json()) as Record<string, unknown>;
        expectOpenAIError(body, "invalid_request_error");
      },
      10_000,
    );

    it(
      "ERR-02: POST /v1/chat/completions with empty messages returns 400",
      async () => {
        const response = await fetch(
          `${handle.gatewayUrl}/v1/chat/completions`,
          {
            method: "POST",
            headers: makeAuthHeaders(handle.authToken),
            body: JSON.stringify({ model: "test", messages: [] }),
          },
        );

        expect(response.status).toBe(400);

        const body = (await response.json()) as Record<string, unknown>;
        expectOpenAIError(body, "invalid_request_error");
      },
      10_000,
    );

    it(
      "ERR-03: POST /v1/embeddings with missing model returns 400",
      async () => {
        const response = await fetch(`${handle.gatewayUrl}/v1/embeddings`, {
          method: "POST",
          headers: makeAuthHeaders(handle.authToken),
          body: JSON.stringify({ input: "test" }),
        });

        expect(response.status).toBe(400);

        const body = (await response.json()) as Record<string, unknown>;
        expectOpenAIError(body, "invalid_request_error");
      },
      10_000,
    );

    it(
      "ERR-04: POST /v1/embeddings with missing input returns 400",
      async () => {
        const response = await fetch(`${handle.gatewayUrl}/v1/embeddings`, {
          method: "POST",
          headers: makeAuthHeaders(handle.authToken),
          body: JSON.stringify({ model: "test" }),
        });

        expect(response.status).toBe(400);

        const body = (await response.json()) as Record<string, unknown>;
        expectOpenAIError(body, "invalid_request_error");
      },
      10_000,
    );

    it(
      "ERR-05: POST /v1/chat/completions with temperature > 2 returns 400",
      async () => {
        const response = await fetch(
          `${handle.gatewayUrl}/v1/chat/completions`,
          {
            method: "POST",
            headers: makeAuthHeaders(handle.authToken),
            body: JSON.stringify({
              model: "test",
              messages: [{ role: "user", content: "hi" }],
              temperature: 5,
            }),
          },
        );

        expect(response.status).toBe(400);

        const body = (await response.json()) as Record<string, unknown>;
        expectOpenAIError(body, "invalid_request_error");
      },
      10_000,
    );
  },
);
