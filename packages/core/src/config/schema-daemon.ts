// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { SecretRefSchema } from "../domain/secret-ref.js";

/**
 * JSONL trace file defaults schema.
 *
 * Controls default output directory and rotation limits for per-agent
 * JSONL trace files.  Per-agent tracing config (agents.<name>.tracing)
 * can override outputDir; maxSize/maxFiles flow from here to all agents.
 *
 * Trace file rotation and configurable trace paths.
 */
const TracingDefaultsSchema = z.strictObject({
    /** Default output directory for JSONL trace files. Supports ~ expansion. */
    outputDir: z.string().default("~/.comis/traces"),
    /** Maximum trace file size before rotation. Supports k/m/g suffixes. */
    maxSize: z
      .string()
      .regex(/^\d+[kmg]?$/i, "Must be a number with optional k/m/g suffix")
      .default("5m"),
    /** Number of rotated trace files to keep per session. */
    maxFiles: z.number().int().min(0).max(100).default(3),
  });

/**
 * Log file rotation + redactor configuration schema.
 *
 * Controls where the daemon writes structured log files, how
 * rotation/retention is handled, and the edge-keeping redactor knobs
 * that govern Pino's censor function. All fields are immutable at
 * runtime (daemon restart required to change).
 *
 * The redact knobs land inside this existing `daemon.logging` section
 * (NOT a new `schema-logging.ts` file), so the section-registry parity
 * snapshot is unaffected — the snapshot covers section names, not field
 * additions.
 */
const LoggingConfigSchema = z.strictObject({
    /** Path to the active log file. Supports ~ expansion. */
    filePath: z.string().default("~/.comis/logs/daemon.log"),
    /** Maximum file size before rotation. Supports k/m/g suffixes. */
    maxSize: z
      .string()
      .regex(/^\d+[kmg]?$/i, "Must be a number with optional k/m/g suffix (e.g., '10m', '1g')")
      .default("10m"),
    /** Number of rotated files to keep. */
    maxFiles: z.number().int().min(0).max(100).default(5),
    /** Compress rotated files (not yet supported by transport). */
    compress: z.boolean().default(false),
    /** JSONL trace file defaults (overridable per agent in agents.<name>.tracing) */
    tracing: TracingDefaultsSchema.default(() => TracingDefaultsSchema.parse({})),
    /**
     * Redact-sensitive mode.
     *   - `"off"`   — redactor is disabled (residency-test only; production
     *                 source is forbidden from setting this; equivalent of
     *                 the `disableRedaction` LoggerOptions escape hatch).
     *   - `"tools"` — full redactor: edge-keeping censor + free-form
     *                 regex transport.
     */
    redactSensitive: z.enum(["off", "tools"]).default("tools"),
    /**
     * Optional operator-supplied additional pattern strings appended to
     * the canonical default set in `@comis/observability`. Each entry is
     * compiled via `new RegExp(...)` at logger init. Empty/undefined →
     * use only the default pattern set.
     */
    redactPatterns: z.array(z.string()).optional(),
    /** Minimum input length to apply the edge-keeping mask; below → "***". */
    redactMinLength: z.number().int().min(8).default(18),
    /** Characters preserved at the head of the masked value (0..12). */
    redactKeepStart: z.number().int().min(0).max(12).default(6),
    /** Characters preserved at the tail of the masked value (0..12). */
    redactKeepEnd: z.number().int().min(0).max(12).default(4),
  });

/**
 * Config change webhook notification schema.
 *
 * When a webhook URL is configured, the daemon sends a best-effort
 * HTTP POST with structured JSON payload on every config.patch or
 * config.apply. Delivery never blocks the config write response.
 *
 * Payload structure.  Best-effort delivery.
 * HMAC-SHA256 signature.
 */
const ConfigWebhookSchema = z.strictObject({
    /** Webhook URL to receive config change notifications (empty = disabled) */
    url: z.string().url().optional(),
    /** Timeout in milliseconds for webhook delivery (default: 5000) */
    timeoutMs: z.number().int().positive().default(5000),
    /** Optional shared secret for HMAC-SHA256 signature in X-Webhook-Signature header (string or SecretRef) */
    secret: z.union([z.string().min(1), SecretRefSchema]).optional(),
  });

/**
 * Daemon process configuration schema.
 *
 * Controls graceful shutdown, metrics collection, per-module log level
 * overrides, log file rotation, and config-change webhooks.
 */
export const DaemonConfigSchema = z.strictObject({
    /** Graceful shutdown timeout in milliseconds */
    shutdownTimeoutMs: z.number().int().min(40_000).default(45_000),
    /** Process metrics collection interval in milliseconds */
    metricsIntervalMs: z.number().int().positive().default(30_000),
    /** Per-module log level overrides (module name -> level) */
    logLevels: z
      .record(z.string(), z.enum(["trace", "debug", "info", "warn", "error", "fatal"]))
      .default({}),
    /** Log file rotation configuration */
    logging: LoggingConfigSchema.default(() => LoggingConfigSchema.parse({})),
    /** Config change webhook notification (best-effort HTTP POST on every config.patch/apply) */
    configWebhook: ConfigWebhookSchema.default(() => ConfigWebhookSchema.parse({})),
  });

export type DaemonConfig = z.infer<typeof DaemonConfigSchema>;
export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;
export type TracingDefaults = z.infer<typeof TracingDefaultsSchema>;
export type ConfigWebhook = z.infer<typeof ConfigWebhookSchema>;
export { LoggingConfigSchema, TracingDefaultsSchema, ConfigWebhookSchema };
