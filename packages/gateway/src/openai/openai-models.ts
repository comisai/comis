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
import { tryCatch } from "@comis/shared";
import { createOpenAIError } from "./openai-types.js";

// ---------------------------------------------------------------------------
// Dependencies interface
// ---------------------------------------------------------------------------

/** Catalog entry shape expected by the models route. */
export interface ModelsCatalogEntry {
  /** Canonical request ID accepted by the completion and response routes. */
  id: string;
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
    id: entry.id,
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
 * - GET /:model_id -- retrieve a single model by its canonical catalog ID
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
  // Canonical model IDs may contain a slash, so a `/*` wildcard is required.
  // Read the id from the routing path rather than assuming one segment.
  // which is the FULL original path (e.g. "/v1/models/openai-codex/gpt-5.5"
  // when this sub-app is mounted at /v1/models). The previous `path.slice(1)`
  // kept the "v1/models/" mount prefix, so it never matched the catalog's
  // "provider/modelId" ids → every single-model retrieve 404'd, even for an id
  // straight out of GET /v1/models (live VPS incident 2026-06-19). Hono strips
  // the mount prefix for routing, so `param("*")` is the correct relative id.
  app.get("/*", (c) => {
    const wildcardIndex = c.req.routePath.lastIndexOf("*");
    const routePrefix = wildcardIndex >= 0
      ? c.req.routePath.slice(0, wildcardIndex)
      : c.req.routePath;
    if (!c.req.path.startsWith(routePrefix)) {
      return c.json(createOpenAIError(404, "Model not found"), 404);
    }
    const decodedId = tryCatch(() => decodeURIComponent(c.req.path.slice(routePrefix.length)));
    if (!decodedId.ok) {
      return c.json(createOpenAIError(404, "Model not found"), 404);
    }
    const entries = deps.getCatalogEntries();
    const entry = entries.find((candidate) => candidate.id === decodedId.value);

    if (!entry) {
      return c.json(createOpenAIError(404, "Model not found"), 404);
    }

    return c.json(toOpenAIModel(entry));
  });

  return app;
}
