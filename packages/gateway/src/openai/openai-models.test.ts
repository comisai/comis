// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
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
    id: "anthropic/claude-sonnet-4-5-20250929",
    provider: "anthropic",
    modelId: "claude-sonnet-4-5-20250929",
    displayName: "Claude Sonnet 4",
    contextWindow: 200000,
  },
  {
    id: "anthropic/claude-haiku-3-20250219",
    provider: "anthropic",
    modelId: "claude-haiku-3-20250219",
    displayName: "Claude Haiku 3",
    contextWindow: 200000,
  },
  {
    id: "openai/gpt-4o",
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

    it("preserves explicit canonical ids in both the model list and lookup", async () => {
      const entries = [
        {
          id: "first",
          provider: "anthropic",
          modelId: "shared-model",
          displayName: "First",
          contextWindow: 200000,
        },
        {
          id: "second",
          provider: "anthropic",
          modelId: "shared-model",
          displayName: "Second",
          contextWindow: 200000,
        },
      ];
      const app = createApp(createDeps(entries));
      const listResponse = await app.request("/");
      const listBody = await listResponse.json();
      const firstResponse = await app.request("/first");
      const firstBody = await firstResponse.json();

      expect.soft(listBody.data.map((model: { id: string }) => model.id)).toEqual([
        "first",
        "second",
      ]);
      expect.soft(firstResponse.status).toBe(200);
      expect(firstBody.id).toBe("first");
    });

    it("matches the complete canonical id instead of an overlapping suffix", async () => {
      const entries: ModelsCatalogEntry[] = [
        {
          id: "short",
          provider: "provider-a",
          modelId: "model-a",
          displayName: "Short",
          contextWindow: 200000,
        },
        {
          id: "group/short",
          provider: "provider-b",
          modelId: "model-b",
          displayName: "Grouped short",
          contextWindow: 200000,
        },
      ];
      const app = createApp(createDeps(entries));

      const exactResponse = await app.request("/group/short");
      const prefixedResponse = await app.request("/arbitrary/short");

      expect((await exactResponse.json()).id).toBe("group/short");
      expect(prefixedResponse.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Single-model retrieve when MOUNTED (live VPS incident 2026-06-19).
  // In production the route mounts at /v1/models, so c.req.path is the FULL
  // "/v1/models/openai/gpt-4o". The prior c.req.path.slice(1) kept the
  // "v1/models/" prefix and never matched the catalog → GET of an id straight
  // from GET /v1/models returned 404. The standalone tests above missed it
  // because, un-mounted, slice(1) accidentally yields the bare id. These mount
  // the route exactly as production does.
  // -------------------------------------------------------------------------
  describe("GET /v1/models/:model_id when MOUNTED at /v1/models", () => {
    function mountedApp(deps?: OpenaiModelsDeps) {
      const root = new Hono();
      root.route("/v1/models", createApp(deps));
      return root;
    }

    it("retrieves a model by the SAME provider/modelId id that GET /v1/models advertises", async () => {
      const res = await mountedApp().request("/v1/models/openai/gpt-4o");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe("openai/gpt-4o");
      expect(body.owned_by).toBe("openai");
    });

    it("still 404s an unknown id when mounted", async () => {
      const res = await mountedApp().request("/v1/models/unknown/no-such-model");
      expect(res.status).toBe(404);
    });
  });
});
