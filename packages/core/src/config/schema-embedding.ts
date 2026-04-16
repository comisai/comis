import { z } from "zod";

/**
 * Embedding provider configuration schema.
 *
 * Controls the embedding pipeline including provider selection (local GGUF
 * models via node-llama-cpp or remote OpenAI), caching, batch indexing,
 * and automatic re-indexing on model change.
 */

const EmbeddingLocalSchema = z.strictObject({
    /** HuggingFace model URI or path to local GGUF file */
    modelUri: z
      .string()
      .default(
        "hf:nomic-ai/nomic-embed-text-v1.5-GGUF:nomic-embed-text-v1.5.Q8_0.gguf",
      ),
    /** Directory to store downloaded models */
    modelsDir: z.string().default("models"),
    /** GPU acceleration mode */
    gpu: z.enum(["auto", "metal", "cuda", "vulkan", "false"]).default("auto"),
    /** Context size for embedding model (tokens). nomic-embed-text-v1.5 trains on 2048; 8192 requires YaRN RoPE scaling not available in node-llama-cpp. */
    contextSize: z.number().int().positive().default(2048),
  });

const EmbeddingOpenaiSchema = z.strictObject({
    /** OpenAI embedding model */
    model: z.string().default("text-embedding-3-small"),
    /** Vector dimensions (must match model output) */
    dimensions: z.number().int().positive().default(1536),
  });

const EmbeddingCacheSchema = z.strictObject({
    /** Maximum cached embeddings in L1 in-memory cache (0 = disabled) */
    maxEntries: z.number().int().nonnegative().default(10_000),
    /** Enable persistent L2 SQLite cache. Default: false (in-memory only). */
    persistent: z.boolean().default(false),
    /** Maximum entries in L2 persistent cache. Default: 50_000. */
    persistentMaxEntries: z.number().int().nonnegative().default(50_000),
    /** TTL in milliseconds for cache entries. Default: undefined (no TTL, LRU only). */
    ttlMs: z.number().int().positive().optional(),
    /** Prune check interval in milliseconds. Default: 300_000 (5 min). */
    pruneIntervalMs: z.number().int().positive().default(300_000),
  });

const EmbeddingBatchSchema = z.strictObject({
    /** Texts per batch call to embedBatch() */
    batchSize: z.number().int().positive().default(100),
    /** Whether to index unembedded memories on startup */
    indexOnStartup: z.boolean().default(true),
  });

export const EmbeddingConfigSchema = z.strictObject({
    /** Enable embedding generation. When false, only FTS5 search is used. */
    enabled: z.boolean().default(true),
    /** Provider preference: "auto" tries local then remote */
    provider: z.enum(["auto", "local", "openai"]).default("auto"),
    /** Local model configuration (node-llama-cpp GGUF) */
    local: EmbeddingLocalSchema.default(() => EmbeddingLocalSchema.parse({})),
    /** Remote OpenAI configuration */
    openai: EmbeddingOpenaiSchema.default(() => EmbeddingOpenaiSchema.parse({})),
    /** Embedding cache configuration */
    cache: EmbeddingCacheSchema.default(() => EmbeddingCacheSchema.parse({})),
    /** Batch indexer configuration */
    batch: EmbeddingBatchSchema.default(() => EmbeddingBatchSchema.parse({})),
    /** Whether to auto-reindex when provider model changes */
    autoReindex: z.boolean().default(true),
  });

export type EmbeddingConfig = z.infer<typeof EmbeddingConfigSchema>;
