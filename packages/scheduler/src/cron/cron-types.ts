// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/**
 * Cron schedule: discriminated union on `kind`.
 *
 * - "cron": standard cron expression with optional timezone
 * - "every": interval-based (everyMs milliseconds, optional anchor)
 * - "at": one-shot at a specific ISO 8601 datetime
 */
export const CronScheduleSchema = z.discriminatedUnion("kind", [
  z.strictObject({
      kind: z.literal("cron"),
      /** Standard cron expression (5 or 6 fields) */
      expr: z.string().min(1),
      /** IANA timezone (e.g. "America/New_York"), omit for UTC */
      tz: z.string().optional(),
    }),
  z.strictObject({
      kind: z.literal("every"),
      /** Interval in milliseconds */
      everyMs: z.number().int().positive(),
      /** Optional anchor timestamp in ms (first tick aligned to this) */
      anchorMs: z.number().int().nonnegative().optional(),
    }),
  z.strictObject({
      kind: z.literal("at"),
      /** ISO 8601 datetime string for one-shot execution */
      at: z.string().min(1),
    }),
]);

export type CronSchedule = z.infer<typeof CronScheduleSchema>;

/**
 * Cron payload: discriminated union on `kind`.
 *
 * - "system_event": emit a system event with text
 * - "agent_turn": trigger an agent turn with a message
 */
export const CronPayloadSchema = z.discriminatedUnion("kind", [
  z.strictObject({
      kind: z.literal("system_event"),
      /** Event text to emit */
      text: z.string().min(1),
    }),
  z.strictObject({
      kind: z.literal("agent_turn"),
      /** Message to send to the agent */
      message: z.string().min(1),
      /** Optional model override for this turn */
      model: z.string().optional(),
      /** Optional timeout in seconds for this turn */
      timeoutSeconds: z.number().int().positive().optional(),
    }),
]);

export type CronPayload = z.infer<typeof CronPayloadSchema>;

/**
 * Session target for cron job execution.
 */
export const CronSessionTargetSchema = z.enum(["main", "isolated"]);

export type CronSessionTarget = z.infer<typeof CronSessionTargetSchema>;

/**
 * Session strategy for cron job execution.
 *
 * - "fresh": expire existing session before each execution (default for isolated jobs)
 * - "rolling": prune session to last N turns after each execution
 * - "accumulate": keep all history (existing unbounded behavior)
 */
export const CronSessionStrategySchema = z.enum(["fresh", "rolling", "accumulate"]);

export type CronSessionStrategy = z.infer<typeof CronSessionStrategySchema>;

/**
 * Delivery target for routing cron job results back to the originating channel.
 * Captured at job creation time from the agent's current context.
 */
export const CronDeliveryTargetSchema = z.strictObject({
    channelId: z.string().min(1),
    userId: z.string().min(1),
    tenantId: z.string().min(1),
    channelType: z.string().optional(),
  });

export type CronDeliveryTarget = z.infer<typeof CronDeliveryTargetSchema>;

/**
 * Full cron job definition.
 */
export const CronJobSchema = z.strictObject({
    /** Unique job identifier */
    id: z.string().min(1),
    /** Human-readable job name */
    name: z.string().max(200),
    /** Agent ID that owns this job */
    agentId: z.string().min(1),
    /** Schedule definition */
    schedule: CronScheduleSchema,
    /** Payload to execute */
    payload: CronPayloadSchema,
    /** Session target for execution */
    sessionTarget: CronSessionTargetSchema.default("isolated"),
    /** Wake mode: when to trigger heartbeat after enqueuing a system event. */
    wakeMode: z.enum(["now", "next-heartbeat"]).default("next-heartbeat"),
    /** Whether to forward isolated session results back to main heartbeat session. */
    forwardToMain: z.boolean().default(false),
    /** Session history strategy for cron executions. Default: fresh. */
    sessionStrategy: CronSessionStrategySchema.default("fresh"),
    /** Number of recent turns to keep for rolling strategy (default 3). */
    maxHistoryTurns: z.number().int().positive().default(3).optional(),
    /** Per-job cache retention override. Default inherits OPERATION_CACHE_DEFAULTS["cron"] = "short". */
    cacheRetention: z.enum(["none", "short", "long"]).optional(),
    /** Per-job tool policy override -- matches AgentConfig.toolPolicy shape.
     *
     *  Resolution order: job.toolPolicy > agentConfig.toolPolicy > passthrough
     *  (no filtering). Opt-in: omitting this field preserves existing tool set
     *  for the job. No silent defaults -- operators explicitly request
     *  conservative presets like `{ profile: "cron-minimal" }`. */
    toolPolicy: z.object({
      profile: z.string().default("full"),
      allow: z.array(z.string()).default([]),
      deny: z.array(z.string()).default([]),
    }).optional(),
    /** Delivery target for routing results to originating channel */
    deliveryTarget: CronDeliveryTargetSchema.optional(),
    /** Whether this job is currently enabled */
    enabled: z.boolean().default(true),
    /** Next scheduled run timestamp (ms since epoch) */
    nextRunAtMs: z.number().int().nonnegative().optional(),
    /** Last completed run timestamp (ms since epoch) */
    lastRunAtMs: z.number().int().nonnegative().optional(),
    /** Number of consecutive errors */
    consecutiveErrors: z.number().int().nonnegative().default(0),
    /** Maximum consecutive errors before auto-suspend. Per-job override of scheduler default. */
    maxConsecutiveErrors: z.number().int().positive().optional(),
    /** Job creation timestamp (ms since epoch) */
    createdAtMs: z.number().int().positive(),
  });

export type CronJob = z.infer<typeof CronJobSchema>;
