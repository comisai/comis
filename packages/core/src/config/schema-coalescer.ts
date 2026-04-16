import { z } from "zod";

/**
 * Block coalescer configuration schema.
 *
 * The coalescer accumulates small streaming blocks and flushes them as
 * larger, more readable chunks. This reduces message spam on chat platforms
 * while preserving natural block boundaries (e.g., code blocks, paragraphs).
 */
export const CoalescerConfigSchema = z.strictObject({
  /** Minimum characters -- blocks below this threshold are always coalesced */
  minChars: z.number().int().nonnegative().default(0),
  /** Maximum characters -- flush threshold; coalesced content is sent when this is reached */
  maxChars: z.number().int().positive().default(500),
  /** Idle timeout (ms) before flushing accumulated content */
  idleMs: z.number().int().positive().default(1500),
  /** Code block handling: standalone (always flush separately) or coalesce (merge with surrounding text) */
  codeBlockPolicy: z.enum(["standalone", "coalesce"]).default("standalone"),
  /** Whether idle timeout adapts to accumulated block length (longer content = shorter timeout) */
  adaptiveIdle: z.boolean().default(false),
});

export type CoalescerConfig = z.infer<typeof CoalescerConfigSchema>;
