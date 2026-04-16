/**
 * Memory review configuration schema.
 *
 * Controls periodic background review of session histories to extract
 * user preferences and facts via batched cheap-model LLM calls.
 *
 * @module
 */

import { z } from "zod";

/**
 * MemoryReviewConfigSchema: Zod schema for per-agent memory review settings.
 *
 * Fields:
 * - enabled: opt-in (default false)
 * - schedule: cron expression for review timing
 * - minMessages: minimum session messages to qualify for review
 * - maxSessionsPerRun: cap on sessions processed per cycle
 * - maxReviewTokens: max LLM response tokens
 * - dedupThreshold: semantic similarity threshold for dedup (0-1)
 * - autoTags: extra tags applied to extracted memories
 */
export const MemoryReviewConfigSchema = z.strictObject({
  /** Enable periodic memory review for this agent. Default: false (opt-in). */
  enabled: z.boolean().default(false),
  /** Cron schedule for review runs. Default: daily at 2 AM UTC. */
  schedule: z.string().default("0 2 * * *"),
  /** Minimum messages in a session to qualify for review. */
  minMessages: z.number().int().positive().default(5),
  /** Maximum sessions to process per review cycle. */
  maxSessionsPerRun: z.number().int().positive().default(10),
  /** Maximum LLM response tokens for the review call. */
  maxReviewTokens: z.number().int().positive().default(4096),
  /** Semantic similarity threshold (0-1) for deduplication. */
  dedupThreshold: z.number().min(0).max(1).default(0.85),
  /** Extra tags applied to all extracted memory entries. */
  autoTags: z.array(z.string()).default([]),
});

export type MemoryReviewConfig = z.infer<typeof MemoryReviewConfigSchema>;
