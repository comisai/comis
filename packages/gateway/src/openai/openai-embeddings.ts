// SPDX-License-Identifier: Apache-2.0
/**
 * OpenAI-compatible /v1/embeddings endpoint.
 *
 * Proxies embedding requests to the configured EmbeddingPort and returns
 * responses in OpenAI's Embeddings format. Supports single string or
 * array-of-strings input.
 *
 * @module
 */

import { Hono } from "hono";
import { z } from "zod";
import { createOpenAIError } from "./openai-types.js";

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

/** Zod schema for POST /v1/embeddings request body. */
export const EmbeddingsRequestSchema = z.object({
  model: z.string().min(1),
  input: z.union([z.string(), z.array(z.string())]),
  encoding_format: z.enum(["float", "base64"]).optional().default("float"),
});

/** Inferred type from the request schema. */
export type EmbeddingsRequest = z.infer<typeof EmbeddingsRequestSchema>;

// ---------------------------------------------------------------------------
// Dependencies interface
// ---------------------------------------------------------------------------

/** Embedding port shape expected by the embeddings route. */
export interface EmbeddingsPort {
  embed(
    text: string,
  ): Promise<{ ok: true; value: number[] } | { ok: false; error: Error }>;
  embedBatch(
    texts: string[],
  ): Promise<{ ok: true; value: number[][] } | { ok: false; error: Error }>;
  modelId: string;
  dimensions: number;
}

/**
 * Dependencies for the OpenAI embeddings route.
 *
 * `getEmbeddingPort` returns the configured embedding provider, or undefined
 * if no provider is configured.
 */
export interface OpenaiEmbeddingsDeps {
  /** Return the configured embedding port, or undefined if not available. */
  getEmbeddingPort: () => EmbeddingsPort | undefined;
  /** Logger for error reporting. */
  logger: { error(...args: unknown[]): void };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an OpenAI-compatible /v1/embeddings route handler.
 *
 * Returns a Hono app with a single POST / handler. Mount at
 * `/v1/embeddings` in the parent router.
 *
 * Supports:
 * - Single string input (normalized to array internally)
 * - Array of strings input for batch embedding
 * - Returns 404 if no embedding provider is configured
 * - Returns 500 if the embedding port returns an error
 */
export function createOpenaiEmbeddingsRoute(
  deps: OpenaiEmbeddingsDeps,
): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    try {
      // Parse and validate request body
      const rawBody = await c.req.json();
      const parseResult = EmbeddingsRequestSchema.safeParse(rawBody);

      if (!parseResult.success) {
        const issues = parseResult.error.issues;
        const firstParam =
          issues.length > 0 && issues[0].path.length > 0
            ? String(issues[0].path[0])
            : undefined;
        const message =
          "Invalid request: " +
          issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");

        return c.json(createOpenAIError(400, message, firstParam), 400);
      }

      const body = parseResult.data;

      // Check for configured embedding provider
      const port = deps.getEmbeddingPort();
      if (!port) {
        return c.json(
          createOpenAIError(404, "No embedding provider configured"),
          404,
        );
      }

      // Normalize input to array
      const texts =
        typeof body.input === "string" ? [body.input] : body.input;

      // Call embedding port
      const result = await port.embedBatch(texts);

      if (!result.ok) {
        deps.logger.error(
          { err: result.error, hint: "Check embedding provider configuration and connectivity", errorKind: "dependency" as const },
          "Embedding port returned error",
        );
        return c.json(createOpenAIError(500, "Internal server error"), 500);
      }

      const vectors = result.value;

      // Build OpenAI-format response
      return c.json({
        object: "list",
        data: vectors.map((embedding, index) => ({
          object: "embedding" as const,
          embedding,
          index,
        })),
        model: port.modelId,
        usage: {
          prompt_tokens: texts.reduce(
            (sum, t) => sum + Math.ceil(t.length / 4),
            0,
          ),
          total_tokens: texts.reduce(
            (sum, t) => sum + Math.ceil(t.length / 4),
            0,
          ),
        },
      });
    } catch (err) {
      deps.logger.error({ err, hint: "Inspect the request body and embedding provider configuration", errorKind: "internal" as const }, "OpenAI embeddings endpoint error");
      return c.json(createOpenAIError(500, "Internal server error"), 500);
    }
  });

  return app;
}
