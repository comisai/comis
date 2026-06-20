// SPDX-License-Identifier: Apache-2.0
/**
 * OpenAI-compatible /v1/models endpoint.
 *
 * Returns the model catalog in OpenAI's List Models format. Supports
 * both listing all models (GET /) and retrieving a single model
 * (GET /:model_id).
 *
 * @module
 */

import { Hono } from "hono";
import { createOpenAIError } from "./openai-types.js";

// ---------------------------------------------------------------------------
// Dependencies interface
// ---------------------------------------------------------------------------

/** Catalog entry shape expected by the models route. */
export interface ModelsCatalogEntry {
  provider: string;
  modelId: string;
  displayName: string;
  contextWindow: number;
}

/**
 * Dependencies for the OpenAI models route.
 *
 * `getCatalogEntries` delegates to ModelCatalog.getAll() at wiring time,
 * decoupling the route handler from the catalog implementation.
 */
export interface OpenaiModelsDeps {
  /** Return all model entries from the catalog. */
  getCatalogEntries: () => ModelsCatalogEntry[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a catalog entry as an OpenAI model object. */
function toOpenAIModel(entry: ModelsCatalogEntry): {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
} {
  return {
    id: `${entry.provider}/${entry.modelId}`,
    object: "model" as const,
    created: 0,
    owned_by: entry.provider,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an OpenAI-compatible /v1/models route handler.
 *
 * Returns a Hono app with:
 * - GET / -- list all models in OpenAI format
 * - GET /:model_id -- retrieve a single model by provider/modelId
 *
 * Mount at `/v1/models` in the parent router.
 */
export function createOpenaiModelsRoute(deps: OpenaiModelsDeps): Hono {
  const app = new Hono();

  // GET / -- list all models
  app.get("/", (c) => {
    const entries = deps.getCatalogEntries();
    return c.json({
      object: "list",
      data: entries.map(toOpenAIModel),
    });
  });

  // GET /:model_id -- single model lookup
  // Model IDs use "provider/modelId" format (a slash), so a `/*` wildcard is
  // required. Read the id from the ROUTING wildcard param — NOT c.req.path,
  // which is the FULL original path (e.g. "/v1/models/openai-codex/gpt-5.5"
  // when this sub-app is mounted at /v1/models). The previous `path.slice(1)`
  // kept the "v1/models/" mount prefix, so it never matched the catalog's
  // "provider/modelId" ids → every single-model retrieve 404'd, even for an id
  // straight out of GET /v1/models (live VPS incident 2026-06-19). Hono strips
  // the mount prefix for routing, so `param("*")` is the correct relative id.
  app.get("/*", (c) => {
    // c.req.path is the FULL original path; when mounted at /v1/models it is
    // e.g. "/v1/models/openai-codex/gpt-5.5". We can't know the mount prefix in
    // here, so match the catalog id as the trailing "/provider/modelId" segment
    // (works whether mounted or standalone). decodeURIComponent handles a
    // percent-encoded slash in the id.
    const reqPath = decodeURIComponent(c.req.path);
    const entries = deps.getCatalogEntries();
    const entry = entries.find(
      (e) => reqPath.endsWith(`/${e.provider}/${e.modelId}`),
    );

    if (!entry) {
      return c.json(createOpenAIError(404, "Model not found"), 404);
    }

    return c.json(toOpenAIModel(entry));
  });

  return app;
}
