// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

// ── Delivery Timing ─────────────────────────────────────��───────────────

/**
 * Delivery timing mode determines how inter-block delays are calculated.
 *
 * - `off`: No delay between blocks (instant delivery)
 * - `natural`: Human-like typing delay based on block length
 * - `custom`: Fixed delay range (minMs..maxMs + jitter)
 * - `adaptive`: Adjusts delay based on conversation pace and block complexity
 */
export const DeliveryTimingModeSchema = z
  .enum(["off", "natural", "custom", "adaptive"])
  .default("natural");

/**
 * Delivery timing configuration schema.
 *
 * Controls the pacing of block-by-block message delivery to simulate
 * natural typing rhythm. Applies after the coalescer flushes a block
 * and before the channel adapter sends it.
 */
export const DeliveryTimingConfigSchema = z.strictObject({
  /** Timing mode: off, natural, custom, or adaptive */
  mode: DeliveryTimingModeSchema,
  /** Minimum delay (ms) between block deliveries */
  minMs: z.number().int().nonnegative().default(800),
  /** Maximum delay (ms) between block deliveries */
  maxMs: z.number().int().nonnegative().default(2500),
  /** Random jitter (ms) added to each delay for natural feel */
  jitterMs: z.number().int().nonnegative().default(200),
  /** Extra delay (ms) before delivering the first block of a response */
  firstBlockDelayMs: z.number().int().nonnegative().default(0),
});

export type DeliveryTimingConfig = z.infer<typeof DeliveryTimingConfigSchema>;
export type DeliveryTimingMode = z.infer<typeof DeliveryTimingModeSchema>;

// ── Delivery Queue ──────────────────────────────────────────────────────

/**
 * Delivery queue configuration schema.
 *
 * Defines settings for the crash-safe outbound delivery queue:
 * enable/disable, depth limits, retry policy, drain behavior, and pruning.
 *
 * Crash-Safe Delivery Queue.
 */

/**
 * DeliveryQueueConfigSchema -- validated configuration for the delivery queue.
 *
 * All fields have sensible defaults so an empty object produces a valid config.
 */
export const DeliveryQueueConfigSchema = z.strictObject({
  /** Whether the delivery queue is enabled. When false, messages bypass persistence. */
  enabled: z.boolean().default(true),
  /** Maximum number of entries allowed in the queue. Enqueue rejects when full. */
  maxQueueDepth: z.number().int().positive().default(10_000),
  /** Default maximum delivery attempts before marking an entry as failed. */
  defaultMaxAttempts: z.number().int().positive().default(5),
  /** Default time-to-live in milliseconds before an entry expires (1 hour). */
  defaultExpireMs: z.number().int().positive().default(3_600_000),
  /** Whether to drain pending entries on daemon startup (crash recovery). */
  drainOnStartup: z.boolean().default(true),
  /** Maximum time in milliseconds allowed for startup drain before continuing. */
  drainBudgetMs: z.number().int().positive().default(60_000),
  /** Interval in milliseconds between automatic prune sweeps for expired entries. */
  pruneIntervalMs: z.number().int().positive().default(300_000),
});

export type DeliveryQueueConfig = z.infer<typeof DeliveryQueueConfigSchema>;

// ── Delivery Mirror ─────────────────────────────────────────────────────

/**
 * Delivery mirror configuration schema.
 *
 * Defines settings for the session mirroring persistence layer:
 * enable/disable, retention, pruning, and injection limits.
 *
 * Session Mirroring.
 */

/**
 * DeliveryMirrorConfigSchema -- validated configuration for the delivery mirror.
 *
 * All fields have sensible defaults so an empty object produces a valid config.
 */
export const DeliveryMirrorConfigSchema = z.strictObject({
  /** Whether the delivery mirror is enabled. When false, no entries are recorded. */
  enabled: z.boolean().default(true),
  /** Maximum age in milliseconds before mirror entries are pruned (24 hours). */
  retentionMs: z.number().int().positive().default(86_400_000),
  /** Interval in milliseconds between automatic prune sweeps (5 minutes). */
  pruneIntervalMs: z.number().int().positive().default(300_000),
  /** Maximum number of mirror entries injected per prompt turn. */
  maxEntriesPerInjection: z.number().int().positive().default(10),
  /** Maximum total characters of mirror text injected per prompt turn. */
  maxCharsPerInjection: z.number().int().positive().default(4000),
});

export type DeliveryMirrorConfig = z.infer<typeof DeliveryMirrorConfigSchema>;
