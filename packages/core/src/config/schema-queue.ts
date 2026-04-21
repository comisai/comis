// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/**
 * Debounce buffer configuration for ingress-layer message coalescing.
 *
 * Sits BEFORE the CommandQueue to coalesce rapid successive messages from the
 * same user within a configurable time window, preventing duplicate agent
 * invocations. This is different from the collect-mode debounce which operates
 * during execution.
 */
export const DebounceBufferConfigSchema = z.strictObject({
  /** Per-channel debounce window in milliseconds. 0 = disabled. */
  windowMs: z.number().int().nonnegative().default(0),
  /** Maximum messages to buffer per session before forced flush */
  maxBufferedMessages: z.number().int().positive().default(10),
  /** First message in burst triggers immediately (skip debounce) */
  firstMessageImmediate: z.boolean().default(true),
});

export type DebounceBufferConfig = z.infer<typeof DebounceBufferConfigSchema>;

/**
 * Queue mode determines how rapid messages during active execution are handled.
 *
 * - `followup`: Enqueue as separate turn (simplest)
 * - `collect`: Accumulate and coalesce into single follow-up
 * - `steer`: Abort current execution and restart with combined context
 * - `steer+followup`: Use SDK session.steer() when streaming, fall back to session.followUp() otherwise (default)
 */
export const QueueModeSchema = z.enum(["followup", "collect", "steer", "steer+followup"]).default("steer+followup");

/**
 * Overflow policy when queue depth exceeds maxDepth.
 *
 * - `drop-old`: Remove oldest queued message
 * - `drop-new`: Reject the new message (default)
 * - `summarize`: Condense queued messages via LLM (best-effort)
 */
export const OverflowPolicySchema = z
  .enum(["drop-old", "drop-new", "summarize"])
  .default("drop-new");

/**
 * Overflow prevention configuration for a queue lane.
 */
export const OverflowConfigSchema = z.strictObject({
    /** Maximum queued messages per session before overflow triggers */
    maxDepth: z.number().int().positive().default(20),
    /** What to do when maxDepth is reached */
    policy: OverflowPolicySchema,
  });

/**
 * Per-channel-type queue configuration overrides.
 *
 * Allows different channels (e.g., telegram vs. slack) to use different
 * queue modes and overflow policies.
 */
export const PerChannelQueueConfigSchema = z.strictObject({
    /** How rapid messages during active execution are handled */
    mode: QueueModeSchema,
    /** Overflow prevention settings */
    overflow: OverflowConfigSchema.default(() => OverflowConfigSchema.parse({})),
    /** Debounce delay in ms (0 = disabled). Waits this long after last message before processing. */
    debounceMs: z.number().int().nonnegative().default(0),
  });

/**
 * Follow-up trigger configuration for continuation runs after tool/compaction events.
 *
 * Controls how the agent pipeline re-enqueues itself for multi-step workflows
 * without external intervention.
 */
export const FollowupConfigSchema = z.strictObject({
  /** Maximum follow-up runs in a single chain (prevents infinite loops) */
  maxFollowupRuns: z.number().int().nonnegative().default(3),
  /** Whether to trigger follow-up on compaction flush events */
  followupOnCompaction: z.boolean().default(true),
});

export type FollowupConfig = z.infer<typeof FollowupConfigSchema>;

/**
 * Priority lane configuration for multi-lane queue scheduling.
 *
 * Each lane gets its own PQueue with independent concurrency,
 * enabling DMs, group mentions, and background tasks to have
 * different scheduling priorities.
 */
export const PriorityLaneConfigSchema = z.strictObject({
  /** Lane name (e.g., "high", "normal", "low") */
  name: z.string().min(1),
  /** Concurrency limit for this lane */
  concurrency: z.number().int().positive().default(3),
  /** Scheduling priority (higher number = higher priority) */
  priority: z.number().int().nonnegative().default(0),
  /** Age threshold in ms after which tasks emit aging promotion events (0 = disabled) */
  agingPromotionMs: z.number().int().nonnegative().default(30_000),
});

export type PriorityLaneConfig = z.infer<typeof PriorityLaneConfigSchema>;

/**
 * Lane assignment rules for routing messages to priority lanes.
 *
 * Maps message characteristics (DM, mention, follow-up, scheduled) to
 * named priority lanes. The lane names must match entries in priorityLanes.
 */
export const LaneAssignmentConfigSchema = z.strictObject({
  /** Default lane for messages that don't match any rule */
  defaultLane: z.string().min(1).default("normal"),
  /** Lane for DM messages */
  dmLane: z.string().min(1).default("high"),
  /** Lane for group mentions */
  mentionLane: z.string().min(1).default("normal"),
  /** Lane for follow-up messages */
  followupLane: z.string().min(1).default("normal"),
  /** Lane for scheduled/background tasks */
  scheduledLane: z.string().min(1).default("low"),
});

export type LaneAssignmentConfig = z.infer<typeof LaneAssignmentConfigSchema>;

/**
 * Root queue configuration schema.
 *
 * Controls the command queue that serializes agent executions per session
 * and caps global concurrency across all sessions.
 */
export const QueueConfigSchema = z.strictObject({
    /** Whether the command queue is enabled */
    enabled: z.boolean().default(true),
    /** Maximum concurrent agent executions across all sessions */
    maxConcurrentSessions: z.number().int().positive().default(10),
    /** Milliseconds before an idle lane is garbage collected (default: 10 minutes) */
    cleanupIdleMs: z.number().int().positive().default(600_000),
    /** Default queue mode for channels without per-channel override */
    defaultMode: QueueModeSchema,
    /** Default overflow config for channels without per-channel override */
    defaultOverflow: OverflowConfigSchema.default(() => OverflowConfigSchema.parse({})),
    /** Default debounce delay in ms for channels without per-channel override */
    defaultDebounceMs: z.number().int().nonnegative().default(0),
    /** Per-channel-type queue configuration overrides */
    perChannel: z.record(z.string(), PerChannelQueueConfigSchema).default({}),
    /** Global debounce buffer configuration (ingress-layer coalescing before queue entry) */
    debounce: DebounceBufferConfigSchema.default(() => DebounceBufferConfigSchema.parse({})),
    /** Per-channel-type debounce buffer overrides */
    perChannelDebounce: z.record(z.string(), DebounceBufferConfigSchema).default({}),
    /** Follow-up trigger configuration for continuation runs */
    followup: FollowupConfigSchema.default(() => FollowupConfigSchema.parse({})),
    /** Priority lane definitions. Default: high(3), normal(5), low(2) = total concurrency 10 */
    priorityLanes: z.array(PriorityLaneConfigSchema).default([
      { name: "high", concurrency: 3, priority: 2, agingPromotionMs: 30_000 },
      { name: "normal", concurrency: 5, priority: 1, agingPromotionMs: 60_000 },
      { name: "low", concurrency: 2, priority: 0, agingPromotionMs: 0 },
    ]),
    /** Lane assignment rules */
    laneAssignment: LaneAssignmentConfigSchema.default(() => LaneAssignmentConfigSchema.parse({})),
    /** Enable priority lane scheduling (false = single global gate) */
    priorityEnabled: z.boolean().default(false),
  });

export type QueueConfig = z.infer<typeof QueueConfigSchema>;
export type PerChannelQueueConfig = z.infer<typeof PerChannelQueueConfigSchema>;
export type QueueMode = z.infer<typeof QueueModeSchema>;
export type OverflowPolicy = z.infer<typeof OverflowPolicySchema>;
export type OverflowConfig = z.infer<typeof OverflowConfigSchema>;
