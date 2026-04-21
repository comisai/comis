// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/**
 * Scheduler configuration schema.
 *
 * Controls cron scheduling, heartbeat monitoring, quiet hours,
 * task extraction, and execution safety for proactive automation.
 *
 * Note: This is the canonical schema used in AppConfigSchema.
 * The @comis/scheduler package re-exports the same schema shape
 * from its own config module for standalone use.
 */

const CronConfigSchema = z.strictObject({
    /** Enable cron job scheduling */
    enabled: z.boolean().default(true),
    /** Directory for cron job state persistence */
    storeDir: z.string().default("./data/scheduler"),
    /** Maximum concurrent cron job runs */
    maxConcurrentRuns: z.number().int().positive().default(3),
    /** Default timezone for cron expressions (empty = UTC) */
    defaultTimezone: z.string().default(""),
    /** Maximum number of cron jobs allowed (0 = unlimited) */
    maxJobs: z.number().int().nonnegative().default(100),
    /** Maximum consecutive errors before auto-suspending a cron job (0 = never suspend) */
    maxConsecutiveErrors: z.number().int().nonnegative().default(5),
  });

export const HeartbeatConfigSchema = z.strictObject({
    /** Enable periodic heartbeat checks */
    enabled: z.boolean().default(true),
    /** Heartbeat interval in milliseconds */
    intervalMs: z.number().int().positive().default(300_000),
    /** Show OK status in heartbeat output */
    showOk: z.boolean().default(false),
    /** Show alerts in heartbeat output */
    showAlerts: z.boolean().default(true),
    /** Consecutive failures before alerting */
    alertThreshold: z.number().int().positive().default(2),
    /** Minimum ms between alerts for the same source */
    alertCooldownMs: z.number().int().positive().default(300_000),
    /** Max ms a heartbeat tick can run before stuck detection */
    staleMs: z.number().int().positive().default(120_000),
  });

const QuietHoursConfigSchema = z.strictObject({
    /** Enable quiet hours (suppress non-critical automation) */
    enabled: z.boolean().default(false),
    /** Quiet hours start time (HH:MM format) */
    start: z.string().default("22:00"),
    /** Quiet hours end time (HH:MM format) */
    end: z.string().default("07:00"),
    /** Timezone for quiet hours (empty = system local) */
    timezone: z.string().default(""),
    /** Allow critical-priority items to bypass quiet hours */
    criticalBypass: z.boolean().default(true),
  });

const ExecutionConfigSchema = z.strictObject({
    /** Directory for execution lock files */
    lockDir: z.string().default("./data/scheduler/locks"),
    /** Lock stale timeout in milliseconds */
    staleMs: z.number().int().positive().default(600_000),
    /** Lock update interval in milliseconds */
    updateMs: z.number().int().positive().default(30_000),
    /** Directory for execution log files */
    logDir: z.string().default("./data/scheduler/logs"),
    /** Maximum log file size in bytes */
    maxLogBytes: z.number().int().positive().default(2_000_000),
    /** Maximum lines to keep in ring-buffer log */
    keepLines: z.number().int().positive().default(2_000),
  });

const TasksConfigSchema = z.strictObject({
    /** Enable task extraction from conversations */
    enabled: z.boolean().default(false),
    /** Minimum confidence threshold for extracted tasks (0-1) */
    confidenceThreshold: z.number().min(0).max(1).default(0.8),
    /** Directory for task state persistence */
    storeDir: z.string().default("./data/scheduler/tasks"),
  });

export type HeartbeatConfig = z.infer<typeof HeartbeatConfigSchema>;

export const SchedulerConfigSchema = z.strictObject({
    /** Cron job scheduling configuration */
    cron: CronConfigSchema.default(() => CronConfigSchema.parse({})),
    /** Heartbeat monitoring configuration */
    heartbeat: HeartbeatConfigSchema.default(() => HeartbeatConfigSchema.parse({})),
    /** Quiet hours configuration */
    quietHours: QuietHoursConfigSchema.default(() => QuietHoursConfigSchema.parse({})),
    /** Execution safety configuration */
    execution: ExecutionConfigSchema.default(() => ExecutionConfigSchema.parse({})),
    /** Task extraction from conversations */
    tasks: TasksConfigSchema.default(() => TasksConfigSchema.parse({})),
  });

export type SchedulerConfig = z.infer<typeof SchedulerConfigSchema>;
