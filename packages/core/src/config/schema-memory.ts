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
    /** Maximum total entries (0 = no limit) */
    maxEntries: z.number().int().nonnegative().default(0),
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
  });

export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;
export type CompactionConfig = z.infer<typeof CompactionConfigSchema>;
export type RetentionConfig = z.infer<typeof RetentionConfigSchema>;
