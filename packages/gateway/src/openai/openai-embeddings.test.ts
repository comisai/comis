// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createOpenaiEmbeddingsRoute,
  type OpenaiEmbeddingsDeps,
  type EmbeddingsPort,
} from "./openai-embeddings.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_VECTORS = [
  [0.1, 0.2, 0.3, 0.4],
  [0.5, 0.6, 0.7, 0.8],
];

function createMockPort(overrides?: Partial<EmbeddingsPort>): EmbeddingsPort {
  return {
    modelId: "text-embedding-3-small",
    dimensions: 4,
    embed: vi.fn(async () => ({
      ok: true as const,
      value: MOCK_VECTORS[0],
    })),
    embedBatch: vi.fn(async () => ({
      ok: true as const,
      value: MOCK_VECTORS,
    })),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDeps(
  port?: EmbeddingsPort | undefined,
): OpenaiEmbeddingsDeps {
  return {
    getEmbeddingPort: vi.fn(() => port ?? createMockPort()),
    logger: { error: vi.fn() },
  };
}

function createApp(deps?: OpenaiEmbeddingsDeps) {
  return createOpenaiEmbeddingsRoute(deps ?? createDeps());
}

function postRequest(body: unknown) {
  return new Request("http://localhost/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("openai-embeddings", () => {
  describe("POST / (successful embedding)", () => {
    it("returns object: list with embedding data", async () => {
      const app = createApp();
      const res = await app.request(
        postRequest({
          model: "text-embedding-3-small",
          input: ["hello", "world"],
        }),
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.object).toBe("list");
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data).toHaveLength(2);
    });

    it("each entry has object: embedding with correct index", async () => {
      const app = createApp();
      const res = await app.request(
        postRequest({
          model: "text-embedding-3-small",
          input: ["hello", "world"],
        }),
      );
      const body = await res.json();

      expect(body.data[0].object).toBe("embedding");
      expect(body.data[0].index).toBe(0);
      expect(body.data[0].embedding).toEqual([0.1, 0.2, 0.3, 0.4]);

      expect(body.data[1].object).toBe("embedding");
      expect(body.data[1].index).toBe(1);
      expect(body.data[1].embedding).toEqual([0.5, 0.6, 0.7, 0.8]);
    });

    it("returns model ID from embedding port", async () => {
      const app = createApp();
      const res = await app.request(
        postRequest({
          model: "text-embedding-3-small",
          input: ["hello"],
        }),
      );
      const body = await res.json();
      expect(body.model).toBe("text-embedding-3-small");
    });

    it("returns usage with estimated token counts", async () => {
      const app = createApp();
      const res = await app.request(
        postRequest({
          model: "text-embedding-3-small",
          input: ["hello", "world"],
        }),
      );
      const body = await res.json();

      expect(body.usage).toBeDefined();
      expect(body.usage.prompt_tokens).toBeGreaterThan(0);
      expect(body.usage.total_tokens).toBe(body.usage.prompt_tokens);
    });

    it("normalizes single string input to array", async () => {
      const port = createMockPort({
        embedBatch: vi.fn(async () => ({
          ok: true as const,
          value: [MOCK_VECTORS[0]],
        })),
      });
      const deps = createDeps(port);
      const app = createApp(deps);

      const res = await app.request(
        postRequest({
          model: "text-embedding-3-small",
          input: "single text input",
        }),
      );
      expect(res.status).toBe(200);

      // Verify embedBatch was called with array
      expect(port.embedBatch).toHaveBeenCalledWith(["single text input"]);

      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].index).toBe(0);
    });
  });

  describe("POST / (no provider configured)", () => {
    it("returns 404 when getEmbeddingPort returns undefined", async () => {
      const deps: OpenaiEmbeddingsDeps = {
        getEmbeddingPort: vi.fn(() => undefined),
        logger: { error: vi.fn() },
      };
      const app = createApp(deps);

      const res = await app.request(
        postRequest({
          model: "text-embedding-3-small",
          input: ["hello"],
        }),
      );
      expect(res.status).toBe(404);

      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.message).toBe("No embedding provider configured");
      expect(body.error.type).toBe("not_found_error");
    });
  });

  describe("POST / (embedding error)", () => {
    it("returns 500 with generic error when embedBatch returns error", async () => {
      const port = createMockPort({
        embedBatch: vi.fn(async () => ({
          ok: false as const,
          error: new Error("Provider unavailable: connection refused at api.openai.com"),
        })),
      });
      const deps = createDeps(port);
      const app = createApp(deps);

      const res = await app.request(
        postRequest({
          model: "text-embedding-3-small",
          input: ["hello"],
        }),
      );
      expect(res.status).toBe(500);

      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.message).toBe("Internal server error");
      expect(body.error.type).toBe("server_error");
      // Must NOT leak provider internals
      expect(JSON.stringify(body)).not.toContain("Provider unavailable");
      expect(JSON.stringify(body)).not.toContain("api.openai.com");
    });

    it("logs error when embedBatch fails", async () => {
      const port = createMockPort({
        embedBatch: vi.fn(async () => ({
          ok: false as const,
          error: new Error("Provider unavailable"),
        })),
      });
      const deps = createDeps(port);
      const app = createApp(deps);

      await app.request(
        postRequest({
          model: "text-embedding-3-small",
          input: ["hello"],
        }),
      );

      expect(deps.logger.error).toHaveBeenCalled();
    });
  });

  describe("POST / (validation errors)", () => {
    it("returns 400 for missing model", async () => {
      const app = createApp();
      const res = await app.request(
        postRequest({ input: ["hello"] }),
      );
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.type).toBe("invalid_request_error");
    });

    it("returns 400 for missing input", async () => {
      const app = createApp();
      const res = await app.request(
        postRequest({ model: "text-embedding-3-small" }),
      );
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.type).toBe("invalid_request_error");
    });

    it("returns 400 for empty model string", async () => {
      const app = createApp();
      const res = await app.request(
        postRequest({ model: "", input: ["hello"] }),
      );
      expect(res.status).toBe(400);
    });
  });
});
