// SPDX-License-Identifier: Apache-2.0
/**
 * Remote embedding provider using the OpenAI embeddings API.
 *
 * Wraps the OpenAI SDK's `embeddings.create()` for single and batch
 * embedding generation. Returns Result<T, Error> (no thrown exceptions).
 */

import type { EmbeddingPort } from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import OpenAI from "openai";

/**
 * Options for creating an OpenAI embedding provider.
 */
export interface OpenAIEmbeddingProviderOptions {
  /** OpenAI API key */
  apiKey: string;
  /** Embedding model identifier (e.g. "text-embedding-3-small") */
  model: string;
  /** Vector dimensions for the chosen model */
  dimensions: number;
}

/**
 * Create a remote embedding provider backed by the OpenAI API.
 *
 * This is synchronous (just creates the client) and returns a Result.
 * Actual API calls happen lazily when embed()/embedBatch() are called.
 *
 * @param options - OpenAI provider configuration
 * @returns An EmbeddingPort backed by OpenAI, or an error
 */
export function createOpenAIEmbeddingProvider(
  options: OpenAIEmbeddingProviderOptions,
): Result<EmbeddingPort, Error> {
  try {
    const client = new OpenAI({ apiKey: options.apiKey });

    const port: EmbeddingPort = {
      provider: "openai",
      dimensions: options.dimensions,
      modelId: options.model,

      async embed(text: string): Promise<Result<number[], Error>> {
        try {
          const response = await client.embeddings.create({
            model: options.model,
            input: text,
            dimensions: options.dimensions,
          });
          return ok(response.data[0].embedding);
        } catch (e: unknown) {
          return err(e instanceof Error ? e : new Error(String(e)));
        }
      },

      async embedBatch(texts: string[]): Promise<Result<number[][], Error>> {
        try {
          const response = await client.embeddings.create({
            model: options.model,
            input: texts,
            dimensions: options.dimensions,
          });
          return ok(response.data.map((d) => d.embedding));
        } catch (e: unknown) {
          return err(e instanceof Error ? e : new Error(String(e)));
        }
      },
    };

    return ok(port);
  } catch (e: unknown) {
    return err(
      e instanceof Error
        ? e
        : new Error(`Failed to create OpenAI embedding provider: ${String(e)}`),
    );
  }
}
