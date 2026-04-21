// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createOpenaiModelsRoute,
  type OpenaiModelsDeps,
  type ModelsCatalogEntry,
} from "./openai-models.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CATALOG_ENTRIES: ModelsCatalogEntry[] = [
  {
    provider: "anthropic",
    modelId: "claude-sonnet-4-5-20250929",
    displayName: "Claude Sonnet 4",
    contextWindow: 200000,
  },
  {
    provider: "anthropic",
    modelId: "claude-haiku-3-20250219",
    displayName: "Claude Haiku 3",
    contextWindow: 200000,
  },
  {
    provider: "openai",
    modelId: "gpt-4o",
    displayName: "GPT-4o",
    contextWindow: 128000,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDeps(
  entries: ModelsCatalogEntry[] = CATALOG_ENTRIES,
): OpenaiModelsDeps {
  return {
    getCatalogEntries: vi.fn(() => entries),
  };
}

function createApp(deps?: OpenaiModelsDeps) {
  return createOpenaiModelsRoute(deps ?? createDeps());
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("openai-models", () => {
  describe("GET / (list models)", () => {
    it("returns object: list with data array", async () => {
      const app = createApp();
      const res = await app.request("/");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.object).toBe("list");
      expect(Array.isArray(body.data)).toBe(true);
    });

    it("returns correct number of entries", async () => {
      const app = createApp();
      const res = await app.request("/");
      const body = await res.json();
      expect(body.data).toHaveLength(3);
    });

    it("each entry has object: model", async () => {
      const app = createApp();
      const res = await app.request("/");
      const body = await res.json();

      for (const model of body.data) {
        expect(model.object).toBe("model");
      }
    });

    it("model IDs use provider/modelId format", async () => {
      const app = createApp();
      const res = await app.request("/");
      const body = await res.json();

      expect(body.data[0].id).toBe("anthropic/claude-sonnet-4-5-20250929");
      expect(body.data[1].id).toBe("anthropic/claude-haiku-3-20250219");
      expect(body.data[2].id).toBe("openai/gpt-4o");
    });

    it("owned_by matches provider", async () => {
      const app = createApp();
      const res = await app.request("/");
      const body = await res.json();

      expect(body.data[0].owned_by).toBe("anthropic");
      expect(body.data[1].owned_by).toBe("anthropic");
      expect(body.data[2].owned_by).toBe("openai");
    });

    it("created is 0 (static catalog)", async () => {
      const app = createApp();
      const res = await app.request("/");
      const body = await res.json();

      for (const model of body.data) {
        expect(model.created).toBe(0);
      }
    });

    it("returns empty data array when catalog is empty", async () => {
      const app = createApp(createDeps([]));
      const res = await app.request("/");
      const body = await res.json();

      expect(body.object).toBe("list");
      expect(body.data).toHaveLength(0);
    });
  });

  describe("GET /:model_id (single model lookup)", () => {
    it("returns single model for valid ID", async () => {
      const app = createApp();
      const res = await app.request("/anthropic/claude-sonnet-4-5-20250929");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.id).toBe("anthropic/claude-sonnet-4-5-20250929");
      expect(body.object).toBe("model");
      expect(body.owned_by).toBe("anthropic");
      expect(body.created).toBe(0);
    });

    it("returns 404 for unknown model", async () => {
      const app = createApp();
      const res = await app.request("/unknown/no-such-model");
      expect(res.status).toBe(404);

      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.message).toBe("Model not found");
      expect(body.error.type).toBe("not_found_error");
    });

    it("finds openai model by provider/modelId format", async () => {
      const app = createApp();
      const res = await app.request("/openai/gpt-4o");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.id).toBe("openai/gpt-4o");
      expect(body.owned_by).toBe("openai");
    });
  });
});
