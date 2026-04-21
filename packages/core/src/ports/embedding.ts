// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";

/**
 * EmbeddingPort: The hexagonal architecture boundary for text embedding.
 *
 * Embedding providers (OpenAI, Ollama, local models) implement this
 * interface to convert text into vector representations for semantic
 * memory search.
 *
 * The port abstracts away the provider, model, and API details so
 * that MemoryPort adapters can request embeddings without coupling
 * to a specific provider.
 */
export interface EmbeddingPort {
  /**
   * Short identifier for the embedding provider backend.
   * Example: "openai", "local"
   */
  readonly provider: string;

  /**
   * The dimensionality of the embedding vectors produced by this provider.
   * Example: 1536 for text-embedding-ada-002, 384 for all-MiniLM-L6-v2
   */
  readonly dimensions: number;

  /**
   * The model identifier used by this provider.
   * Example: "text-embedding-3-small", "nomic-embed-text"
   */
  readonly modelId: string;

  /**
   * Embed a single text string into a vector.
   *
   * @param text - The text to embed
   * @returns A numeric vector of length `dimensions`, or an error
   */
  embed(text: string): Promise<Result<number[], Error>>;

  /**
   * Embed multiple text strings in a single batch request.
   * More efficient than calling `embed()` in a loop.
   *
   * @param texts - Array of texts to embed
   * @returns Array of numeric vectors (one per text, in order), or an error
   */
  embedBatch(texts: string[]): Promise<Result<number[][], Error>>;

  /**
   * Dispose of provider resources (GPU contexts, models).
   * Optional -- only local providers with native resources need this.
   * Called during daemon graceful shutdown to free Metal/CUDA contexts
   * before process exit.
   */
  dispose?(): Promise<void>;
}
