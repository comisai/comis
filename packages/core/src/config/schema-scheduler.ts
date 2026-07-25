// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { tryCatch } from "@comis/shared";

const SafePositiveIntegerSchema = z.number().int().positive().safe();
const SafeNonnegativeIntegerSchema = z.number().int().nonnegative().safe();
const TimeOfDaySchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u);
const MAX_CRON_JOBS = 10_000;
const MAX_EXECUTION_LOG_BYTES = 32 * 1_024 * 1_024;
const CRON_TERMINAL_RESERVATION_BYTES = 64 * 1_024;

function isIanaTimezone(value: string): boolean {
  return tryCatch(() => new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0)).ok;
}

const TimezoneSchema = z.string()
  .transform((value) => value === "" ? "UTC" : value)
  .refine(isIanaTimezone, { message: "Expected a valid IANA timezone" });

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
    /** Maximum due cron occurrences admitted by one scheduler tick */
    maxRunsPerTick: SafePositiveIntegerSchema.default(3),
    /** Authoring timezone used when a cron expression omits an explicit zone */
    defaultTimezone: TimezoneSchema.default("UTC"),
    /** Positive authored-job cap; config-owned and retained terminal rows are separate */
    maxJobs: SafePositiveIntegerSchema.max(MAX_CRON_JOBS).default(100),
    /** Provider/dependency failures before suspension (zero disables suspension) */
    maxConsecutiveDependencyErrors: SafeNonnegativeIntegerSchema.default(5),
    /** Stable per-job eligibility spread applied only to recurring scheduled fires */
    staggerWindowMs: SafeNonnegativeIntegerSchema.default(0),
    /**
     * Operator toggle for scheduler-initiated wake gates. Tri-state via
     * `.optional()` — NOT a boolean `.default()`, because the absent state is
     * load-bearing and a default would erase it:
     *   - `true`  → run the gate for gated jobs;
     *   - `false` → never run a scheduler-initiated gate (a gated job runs
     *               exactly as it would with no gate);
     *   - absent  → follow the agent's `autonomy.script` surface.
     * Grants NO capability: an enabled gate still runs under the agent's
     * resolved autonomy caps at the cap socket — this only enables/disables the
     * scheduler-initiated gate, a distinct trust context (no human/model in the
     * loop at fire time) from a model-initiated orchestrate script.
     */
    wakeGate: z.boolean().optional(),
  });

/**
 * Resolve whether a scheduler-initiated wake gate should run for a job, from the
 * operator `scheduler.cron.wakeGate` toggle and the agent's `autonomy.script`
 * surface. Pure — no env/clock/fs reads:
 *   - `toggle === true`  → on;
 *   - `toggle === false` → off (explicit off wins even if the script surface is on);
 *   - `toggle` undefined → follow the script surface (on iff it is explicitly true).
 */
export function resolveCronWakeGateEnabled(
  toggle: boolean | undefined,
  scriptSurfaceOn: boolean | undefined,
): boolean {
  if (toggle !== undefined) return toggle;
  return scriptSurfaceOn === true;
}

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
    start: TimeOfDaySchema.default("22:00"),
    /** Quiet hours end time (HH:MM format) */
    end: TimeOfDaySchema.default("07:00"),
    /** Explicit timezone for deterministic quiet-hour evaluation */
    timezone: TimezoneSchema.default("UTC"),
    /** Allow critical-priority items to bypass quiet hours */
    criticalBypass: z.boolean().default(true),
  });

const ExecutionConfigSchema = z.strictObject({
    /** Maximum log file size in bytes */
    maxLogBytes: SafePositiveIntegerSchema.max(MAX_EXECUTION_LOG_BYTES).default(2_000_000),
    /** Complete start/terminal execution groups retained when capacity permits */
    retainedExecutions: SafePositiveIntegerSchema.max(100_000).default(1_000),
  });

const TasksConfigSchema = z.strictObject({
    /** Enable model-inferred follow-up tasks. Explicit opt-in because this
     * capability creates autonomous work from delivered conversations. */
    enabled: z.boolean().default(false),
    /** Minimum confidence threshold for extracted tasks (0-1) */
    confidenceThreshold: z.number().min(0).max(1).default(0.8),
    /** Per-agent delay used to form a bounded extraction batch */
    debounceMs: SafePositiveIntegerSchema.min(1_000).max(300_000).default(15_000),
    /** Maximum delivered turns in one extraction batch */
    batchMax: SafePositiveIntegerSchema.max(64).default(8),
    /** Maximum exact-origin tasks considered in one proactive check */
    maxPerCheck: SafePositiveIntegerSchema.max(8).default(3),
    /** Rolling visible-send cap for one conversation */
    maxPerDayPerConversation: SafePositiveIntegerSchema.max(24).default(3),
    /** Default slack after the minimum due instant */
    defaultWindowMs: SafePositiveIntegerSchema.max(30 * 24 * 60 * 60 * 1_000).default(43_200_000),
    /** Additional pre-acceptance attempts allowed after the initial attempt */
    preAcceptanceRetryLimit: SafeNonnegativeIntegerSchema.max(3).default(3),
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
  }).superRefine((config, ctx) => {
    const requiredLedgerBytes = (config.cron.maxRunsPerTick + 1) * CRON_TERMINAL_RESERVATION_BYTES;
    if (!Number.isSafeInteger(requiredLedgerBytes) || config.execution.maxLogBytes < requiredLedgerBytes) {
      ctx.addIssue({
        code: "custom",
        path: ["execution", "maxLogBytes"],
        message: "Execution log capacity cannot reserve the configured per-tick admissions",
      });
    }
  });

export type SchedulerConfig = z.infer<typeof SchedulerConfigSchema>;
