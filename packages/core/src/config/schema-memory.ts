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
 * Master cost-feature kill switch (v1 opt-out posture).
 *
 * A single top-level gate over EVERY LLM cost-bearing memory feature — the
 * offline crons (memoryReview, the __REFLECT__ reflection cron, memoryUsefulnessJudge,
 * memoryTripleExtraction, socialModeling) and the
 * query-time dialectic tool (`memory_ask`). When `enabled` is `false`, ALL of
 * them are force-disabled at their registration sites regardless of their
 * per-agent config — the operator's single escape hatch from any LLM/API spend
 * the memory stack would otherwise incur.
 *
 * Default `true` because the v1 posture is opt-OUT: the gate is ON, but it
 * gates nothing until a per-agent cost feature is itself enabled — so a bare
 * config is byte-identical (no feature is on by default in this increment).
 *
 * NOT in scope of this gate: the $0 on-device recall features
 * (rerank/lanes/query-understanding/forget/mmr), which cost no API budget; and
 * `socialModeling`, which has its OWN privacy gate (`privacyReviewSignedOffBy`)
 * and stays independent.
 */
export const CostFeaturesConfigSchema = z.strictObject({
    /** Master switch over all LLM cost-bearing memory features. Default true (opt-out posture); set false to force-disable every cost feature. */
    enabled: z.boolean().default(true),
  });

export const MemoryConfigSchema = z.strictObject({
    /** Path to the SQLite database file (resolved relative to dataDir if not absolute) */
    dbPath: z.string().default("memory.db"),
    /** Enable WAL mode for better concurrent read performance */
    walMode: z.boolean().default(true),
    /** Embedding model identifier */
    embeddingModel: z.string().default("text-embedding-3-small"),
    /** Embedding vector dimensions */
    embeddingDimensions: z.number().int().positive().default(1536),
    /** Compaction settings */
    compaction: CompactionConfigSchema.default(() => CompactionConfigSchema.parse({})),
    /** Retention policy */
    retention: RetentionConfigSchema.default(() => RetentionConfigSchema.parse({})),
    /** Reranker GGUF model URI (hf: auto-downloads on first enable). Default is the Q8_0 quantization. */
    rerankerModel: z
      .string()
      .default("hf:gpustack/bge-reranker-v2-m3-GGUF:bge-reranker-v2-m3-Q8_0.gguf"),
    /** Directory (relative to dataDir) to store/resolve the reranker GGUF. */
    rerankerModelsDir: z.string().default("models"),
    /** GPU acceleration mode for the reranker ranking context. */
    rerankerGpu: z.enum(["auto", "metal", "cuda", "vulkan", "false"]).default("auto"),
    /** Thread count for the reranker ranking context. Bounds CPU contention (recommended 4-8). */
    rerankerThreads: z.number().int().positive().default(4),
    /** Master cost-feature kill switch — force-disables ALL LLM cost-bearing memory features when `enabled: false`. Default ON (opt-out posture). */
    costFeatures: CostFeaturesConfigSchema.default(() => CostFeaturesConfigSchema.parse({})),
  });

export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;
export type CompactionConfig = z.infer<typeof CompactionConfigSchema>;
export type RetentionConfig = z.infer<typeof RetentionConfigSchema>;
export type CostFeaturesConfig = z.infer<typeof CostFeaturesConfigSchema>;
