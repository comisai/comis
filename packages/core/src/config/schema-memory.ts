// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/**
 * Memory configuration schema.
 *
 * Controls the SQLite-backed memory system including WAL mode,
 * embedding model selection, compaction, and retention policies.
 */

export const CompactionConfigSchema = z.strictObject({
    /** Whether automatic compaction is enabled */
    enabled: z.boolean().default(true),
    /** Minimum number of entries before compaction triggers */
    threshold: z.number().int().positive().default(1000),
    /** Maximum entries to keep after compaction */
    targetSize: z.number().int().positive().default(500),
  });

export const RetentionConfigSchema = z.strictObject({
    /** Maximum age of entries in days (0 = no limit) */
    maxAgeDays: z.number().int().nonnegative().default(0),
  });

/**
 * Recall keepers (the load-bearing $0 on-device recall substrate).
 *
 * Phase 226 nests the three formerly-flat recall knobs under `memory.recall`
 * (design §5). These select the embedding + reranker models the recall path uses;
 * they cost no API budget and are NOT gated by the master `memory.enabled` switch.
 */
export const MemoryRecallConfigSchema = z.strictObject({
    /** Embedding model identifier */
    embeddingModel: z.string().default("text-embedding-3-small"),
    /** Embedding vector dimensions */
    embeddingDimensions: z.number().int().positive().default(1536),
    /** Reranker GGUF model URI (hf: auto-downloads on first enable). Default is the Q8_0 quantization. */
    rerankerModel: z
      .string()
      .default("hf:gpustack/bge-reranker-v2-m3-GGUF:bge-reranker-v2-m3-Q8_0.gguf"),
  });

export const MemoryConfigSchema = z.strictObject({
    /**
     * Master kill-switch over EVERY LLM cost-bearing memory + learning feature (v1
     * opt-out posture; renamed from `memory.costFeatures.enabled` in Phase 226). A
     * single top-level gate over the offline crons (memoryReview, the __REFLECT__
     * reflection cron, …), the per-agent learning layer (`learning.enabled`), and the
     * query-time dialectic tool (`memory_ask`). When `false`, ALL of them are
     * force-disabled at their registration sites regardless of their per-agent config —
     * the operator's single escape hatch from any LLM/API spend the memory stack would
     * otherwise incur. Default `true` (opt-out): the gate is ON but gates nothing until a
     * per-agent feature is itself enabled. NOT in scope: the $0 on-device recall features
     * (memory.recall / rerank / lanes / forget / mmr) and `socialModeling` (its own
     * privacy gate).
     */
    enabled: z.boolean().default(true),
    /** Path to the SQLite database file (resolved relative to dataDir if not absolute) */
    dbPath: z.string().default("memory.db"),
    /** Enable WAL mode for better concurrent read performance */
    walMode: z.boolean().default(true),
    /** Recall keepers (embedding + reranker model selection — the $0 on-device recall substrate). */
    recall: MemoryRecallConfigSchema.default(() => MemoryRecallConfigSchema.parse({})),
    /** Compaction settings */
    compaction: CompactionConfigSchema.default(() => CompactionConfigSchema.parse({})),
    /** Retention policy */
    retention: RetentionConfigSchema.default(() => RetentionConfigSchema.parse({})),
    /** Directory (relative to dataDir) to store/resolve the reranker GGUF. */
    rerankerModelsDir: z.string().default("models"),
    /** GPU acceleration mode for the reranker ranking context. */
    rerankerGpu: z.enum(["auto", "metal", "cuda", "vulkan", "false"]).default("auto"),
    /** Thread count for the reranker ranking context. Bounds CPU contention (recommended 4-8). */
    rerankerThreads: z.number().int().positive().default(4),
  });

export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;
export type MemoryRecallConfig = z.infer<typeof MemoryRecallConfigSchema>;
export type CompactionConfig = z.infer<typeof CompactionConfigSchema>;
export type RetentionConfig = z.infer<typeof RetentionConfigSchema>;
