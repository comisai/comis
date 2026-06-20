// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

// ── Monitoring ──────────────────────────────────────────────────────────

/**
 * Monitoring configuration schemas.
 *
 * Defines thresholds and settings for system monitoring heartbeat sources:
 * disk space, CPU/memory resources, systemd services, security updates,
 * and git repository watching.
 *
 * Disk space monitoring
 * Resource utilization monitoring
 * Service health monitoring
 * Security update and git repo monitoring
 */

const DiskMonitorSchema = z.strictObject({
    /** Whether disk space monitoring is enabled. */
    enabled: z.boolean().default(true),
    /** Filesystem paths to monitor. */
    paths: z.array(z.string()).default(["/"]),
    /** Alert when usage exceeds this percentage. */
    thresholdPercent: z.number().min(0).max(100).default(90),
  });

const ResourceMonitorSchema = z.strictObject({
    /** Whether CPU/memory monitoring is enabled. */
    enabled: z.boolean().default(true),
    /** Alert when CPU usage exceeds this percentage. */
    cpuThresholdPercent: z.number().min(0).max(100).default(85),
    /** Alert when memory usage exceeds this percentage. */
    memoryThresholdPercent: z.number().min(0).max(100).default(90),
  });

const SystemdMonitorSchema = z.strictObject({
    /** Whether systemd service monitoring is enabled. */
    enabled: z.boolean().default(true),
    /** Specific services to monitor (empty = check all failed). */
    services: z.array(z.string()).default([]),
  });

const SecurityUpdateMonitorSchema = z.strictObject({
    /** Whether security update monitoring is enabled. */
    enabled: z.boolean().default(true),
    /** Only check for security updates (not all updates). */
    securityOnly: z.boolean().default(true),
  });

const GitMonitorSchema = z.strictObject({
    /** Whether git repository monitoring is enabled (default: off). */
    enabled: z.boolean().default(false),
    /** Absolute paths to git repositories to monitor. */
    repositories: z.array(z.string()).default([]),
    /** Check remote for unpushed commits. */
    checkRemote: z.boolean().default(true),
  });

/**
 * Root monitoring configuration schema.
 *
 * Each sub-section has sensible defaults so an empty object
 * produces a valid MonitoringConfig.
 */
export const MonitoringConfigSchema = z.strictObject({
    /** Disk space monitoring. */
    disk: DiskMonitorSchema.default(() => DiskMonitorSchema.parse({})),
    /** CPU and memory monitoring. */
    resources: ResourceMonitorSchema.default(() => ResourceMonitorSchema.parse({})),
    /** systemd service health monitoring. */
    systemd: SystemdMonitorSchema.default(() => SystemdMonitorSchema.parse({})),
    /** Security update monitoring. */
    securityUpdates: SecurityUpdateMonitorSchema.default(() => SecurityUpdateMonitorSchema.parse({})),
    /** Git repository monitoring. */
    git: GitMonitorSchema.default(() => GitMonitorSchema.parse({})),
  });

export type MonitoringConfig = z.infer<typeof MonitoringConfigSchema>;
export type DiskMonitorConfig = z.infer<typeof DiskMonitorSchema>;
export type ResourceMonitorConfig = z.infer<typeof ResourceMonitorSchema>;
export type SystemdMonitorConfig = z.infer<typeof SystemdMonitorSchema>;
export type SecurityUpdateMonitorConfig = z.infer<typeof SecurityUpdateMonitorSchema>;
export type GitMonitorConfig = z.infer<typeof GitMonitorSchema>;

// ── Observability ───────────────────────────────────────────────────────

/**
 * Observability persistence configuration schemas.
 *
 * Defines settings for the SQLite-backed observability store:
 * retention period, snapshot interval, and enable/disable toggle.
 *
 * Observability Persistence Store.
 */

const ObservabilityPersistenceSchema = z.strictObject({
  /** Whether observability persistence is enabled. */
  enabled: z.boolean().default(true),
  /** Number of days to retain observability data before pruning. */
  retentionDays: z.number().int().min(1).max(365).default(30),
  /** Interval in milliseconds between channel health snapshots. */
  snapshotIntervalMs: z.number().int().min(60000).default(300000),
  /**
   * Whether detected prompt-cache breaks are persisted to obs_diagnostics
   * (category 'cache_break') + the trajectory (PERSIST-01). Default on. NOTE:
   * this lives under `persistence.*` deliberately — there is NO top-level
   * `persist` key (the schema already owns persistence; a colliding `persist`
   * would be the anti-pattern, Pitfall 5).
   */
  cacheBreaks: z.boolean().default(true),
});

/**
 * Security-audit persistence configuration (AUDIT-01). Controls whether
 * `audit:event`/`secret:accessed`/`security:*` records are durably persisted and
 * to which sink(s). Rotation is NOT configured here — the audit JSONL is the 6th
 * stream under the shared `logRotation` policy (no per-sink rotation knob).
 */
const AuditConfigSchema = z.strictObject({
  /** Whether security-audit events are persisted (SQLite + JSONL). Default on. */
  persist: z.boolean().default(true),
  /** Which sink(s) receive audit records: the SQLite table, the JSONL file, or both. */
  sink: z.enum(["sqlite", "jsonl", "both"]).default("both"),
});

/**
 * Spend kill-switch configuration (SPEND-01). The operator's opt-in surface for
 * the daemon-wide cost-enforcement accumulator. Ships OFF: all three ceilings
 * default `null` (a deployment that does not opt in is never enforced and cannot
 * be DoSed by a fat-fingered cap), and `action` defaults `warn` (observe-only).
 * A non-null ceiling on any dimension turns enforcement on for that scope.
 */
const SpendConfigSchema = z.strictObject({
  /** Per-agent cumulative USD ceiling. `null` = off (opt-in). */
  perAgentUsd: z.number().positive().nullable().default(null),
  /** Per-tenant cumulative USD ceiling (the cross-tenant isolation dimension). `null` = off. */
  perTenantUsd: z.number().positive().nullable().default(null),
  /** Daemon-wide cumulative USD ceiling across all agents/tenants. `null` = off. */
  daemonGlobalUsd: z.number().positive().nullable().default(null),
  /**
   * The conservative per-turn RESERVATION the bridge reserves at admission —
   * there is no pre-flight cost estimate at that point (Plan 03 Task 2), so a
   * fixed amount is reserved up front and reconciled to the actual billed amount
   * post-turn. A sane per-turn cap.
   */
  perTurnMax: z.number().positive().default(0.5),
  /** Behaviour on a ceiling breach: `warn` (observe-only, the shipped default) or `abort`. */
  action: z.enum(["warn", "abort"]).default("warn"),
  /** Emit the early `observability:spend_warning` once spend crosses this fraction of a ceiling. */
  warnAtFraction: z.number().min(0).max(1).default(0.8),
  /**
   * Forward-extensibility placeholder with a single current member, `"snapshot"`
   * (the dated model-catalog snapshot rate). No live price fetch is in scope; a
   * live HTTP feed would add a member here later. Kept as an enum (not a bare
   * literal) so that a future member is an additive change, not a shape change.
   */
  pricingFallback: z.enum(["snapshot"]).default("snapshot"),
  /** Behaviour when a remote model's price is unknown while it burns tokens: `warn` (fail loud, the default) or `abort`. */
  onUnknownPricing: z.enum(["warn", "abort"]).default("warn"),
});

/**
 * Trajectory observability configuration schema.
 *
 * Defines the optional `dirOverride` that relocates the runtime trajectory
 * file to an operator-specified directory. When set, the pointer sidecar
 * at `<sessionFile>.trajectory-path.json` still lives next to the session
 * JSONL and its `runtimeFile` field points at the relocated file.
 *
 * See also: `COMIS_TRAJECTORY_DIR` env var (projected via env-layer.ts).
 * Precedence: diagnostics.trajectory.dir → observability.trajectory.dirOverride → env → default.
 */
const TrajectoryObservabilityConfigSchema = z.strictObject({
  /** Override directory for runtime trajectory JSONL files. */
  dirOverride: z.string().optional(),
});

/**
 * Log rotation configuration schema.
 *
 * Cross-stream rotation policy applied to all 6 observability streams:
 * daemon.log, cache-trace.jsonl, config-audit.jsonl,
 * session-index.YYYY-MM-DD.jsonl, *.trajectory.jsonl, and
 * security-audit.jsonl (the AUDIT-01 security-audit stream).
 *
 * Defaults: 50 MB max size, 5 files kept, 30 days retention, gzip enabled.
 * Visible via `comis config get observability.logRotation`.
 */
const LogRotationConfigSchema = z.strictObject({
  /** Maximum size in bytes before rotation is triggered. Defaults to 50 * 1024 * 1024 = 52428800 (50 MB). */
  maxSizeBytes: z.number().int().positive().default(50 * 1024 * 1024),
  /** Maximum number of rotated files to keep per stream. */
  maxFiles: z.number().int().positive().default(5),
  /** Maximum age in days before rotated files are pruned. */
  maxAgeDays: z.number().int().positive().default(30),
  /** Whether to gzip rotated files (appends .gz suffix). */
  compressAged: z.boolean().default(true),
});

/**
 * Alert budget threshold schema — per-errorKind sliding-window counter.
 *
 * `count`: maximum number of events of a given errorKind within `windowMs`
 * before `health:budget_exceeded` is emitted once.
 * `windowMs`: sliding window length in milliseconds.
 *
 * Both fields require a positive integer; zero or negative values are rejected
 * at schema validation time (prevents deadlock/infinite latch).
 */
const AlertBudgetThresholdSchema = z.strictObject({
  count: z.number().int().positive(),
  windowMs: z.number().int().positive(),
});

/**
 * Alert budget configuration schema.
 *
 * Defaults cover all 10 errorKind closed-union members. Operators may
 * override individual thresholds; unrecognised errorKind keys are
 * silently accepted (future-proofing) but won't fire unless the aggregator
 * also knows about them.
 *
 * Visible via `comis config get observability.alertBudget`.
 */
export const AlertBudgetConfigSchema = z.strictObject({
  /** Whether the health budget aggregator is enabled. Default true. */
  enabled: z.boolean().default(true),
  /**
   * Per-errorKind threshold table. All 10 errorKind closed-union members
   * are pre-seeded with sane defaults. Individual entries can be overridden;
   * extra keys (unknown errorKinds) are accepted by the schema but ignored
   * by the aggregator's lookup.
   */
  thresholds: z.record(z.string(), AlertBudgetThresholdSchema).default({
    network:      { count: 100, windowMs: 60_000 },
    config:       { count: 10,  windowMs: 60_000 },
    auth:         { count: 20,  windowMs: 60_000 },
    validation:   { count: 100, windowMs: 60_000 },
    precondition: { count: 50,  windowMs: 60_000 },
    timeout:      { count: 50,  windowMs: 60_000 },
    resource:     { count: 10,  windowMs: 60_000 },
    dependency:   { count: 20,  windowMs: 60_000 },
    internal:     { count: 5,   windowMs: 60_000 },
    platform:     { count: 50,  windowMs: 60_000 },
  }),
});

/**
 * Root observability configuration schema.
 *
 * Has sensible defaults so an empty object produces a valid ObservabilityConfig.
 */
export const ObservabilityConfigSchema = z.strictObject({
  /** Persistence layer settings. */
  persistence: ObservabilityPersistenceSchema.default(() => ObservabilityPersistenceSchema.parse({})),
  /** Trajectory storage override. */
  trajectory: TrajectoryObservabilityConfigSchema.default(() => TrajectoryObservabilityConfigSchema.parse({})),
  /** Cross-stream log rotation policy. */
  logRotation: LogRotationConfigSchema.default(() => LogRotationConfigSchema.parse({})),
  /** Alert budget rate-aggregator policy. */
  alertBudget: AlertBudgetConfigSchema.default(() => AlertBudgetConfigSchema.parse({})),
  /** Security-audit persistence policy (AUDIT-01). */
  audit: AuditConfigSchema.default(() => AuditConfigSchema.parse({})),
  /** Spend kill-switch policy (SPEND-01) — ships off (null ceilings, action 'warn'). */
  spend: SpendConfigSchema.default(() => SpendConfigSchema.parse({})),
});

export type ObservabilityConfig = z.infer<typeof ObservabilityConfigSchema>;
export type ObservabilityPersistenceConfig = z.infer<typeof ObservabilityPersistenceSchema>;
export type TrajectoryObservabilityConfig = z.infer<typeof TrajectoryObservabilityConfigSchema>;
export type LogRotationConfig = z.infer<typeof LogRotationConfigSchema>;
export type AlertBudgetConfig = z.infer<typeof AlertBudgetConfigSchema>;
export type AlertBudgetThreshold = z.infer<typeof AlertBudgetThresholdSchema>;
export type AuditConfig = z.infer<typeof AuditConfigSchema>;
export type SpendConfig = z.infer<typeof SpendConfigSchema>;
export { LogRotationConfigSchema, AuditConfigSchema, SpendConfigSchema };
