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
   * (category 'cache_break') + the trajectory. Default on. NOTE:
   * this lives under `persistence.*` deliberately — there is NO top-level
   * `persist` key (the schema already owns persistence; a colliding `persist`
   * would be the anti-pattern).
   */
  cacheBreaks: z.boolean().default(true),
});

/**
 * Security-audit persistence configuration. Controls whether
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
 * Spend kill-switch configuration. The operator's opt-in surface for
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
   * there is no pre-flight cost estimate at that point, so a
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
 * security-audit.jsonl (the security-audit stream).
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
 * OpenTelemetry (OTLP push) configuration — the opt-in export
 * surface for the `@comis/observability-otel` extension. Ships OFF
 * (`enabled:false`) and CONTENT-FREE by default: the GenAI semconv stays at the
 * pre-stable shape (`genaiSemconv:false`) and the 3 message/content span
 * attributes are spec-`Opt-In` and OMITTED (`captureContent:false`) — and even
 * with both on, `sanitizeForPersistence` re-redacts at the exporter.
 *
 * `protocol` ships ONLY `http/protobuf` (the `-proto` exporters are
 * installed); `grpc` validates but FALLS BACK to `-proto` with a WARN+hint at
 * runtime (the grpc transport is not implemented — no silent wrong-transport).
 * The seam that loads this is the config-gated `await import()` in
 * `setupObservability` (daemon), gated on `enabled || prometheus.enabled`.
 */
const OtelConfigSchema = z.strictObject({
  /** Master switch for the OTLP push surface (traces/metrics/logs). Default off. */
  enabled: z.boolean().default(false),
  /** OTLP collector endpoint URL; `''` means use the OTel env/SDK default. */
  endpoint: z.string().default(""),
  /**
   * OTLP transport. `http/protobuf` is the shipped transport (the `-proto` exporters);
   * `grpc` validates but falls back to `-proto` with a WARN+hint at runtime
   * (the grpc transport is not implemented).
   */
  protocol: z.enum(["http/protobuf", "grpc"]).default("http/protobuf"),
  /** Emit OTLP trace spans (per-turn/tool/graph). Default on (when `enabled`). */
  traces: z.boolean().default(true),
  /** Emit OTLP metrics off the single catalog. Default on (when `enabled`). */
  metrics: z.boolean().default(true),
  /** Emit bus events as OTLP log records (scrubbed). Default on (when `enabled`). */
  logs: z.boolean().default(true),
  /**
   * Opt into the LATEST (pre-stable `Development`) GenAI semconv shape (the
   * `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental` gate). Default off
   * (pre-1.36 shape). Content STILL never leaks: re-redaction is independent.
   */
  genaiSemconv: z.boolean().default(false),
  /**
   * Capture the 3 GenAI content span attributes (input/output messages,
   * system_instructions). Spec-`Opt-In` → default off (omitted). Even when on,
   * `sanitizeForPersistence` re-redacts at the exporter boundary.
   */
  captureContent: z.boolean().default(false),
});

/**
 * Prometheus (`/metrics` pull) configuration — the standalone scrape
 * surface, INDEPENDENT of `otel.enabled` (it serves valid exposition with no
 * OTLP collector). Realized by the OTel `PrometheusExporter`, which opens its OWN
 * loopback HTTP listener (NOT the gateway). Ships OFF (`enabled:false`) and
 * LOOPBACK-bound (`host:'127.0.0.1'`) — never `0.0.0.0` implicitly.
 *
 * `auth` is the literal `'trusted-operator'`: the OTel exporter has NO built-in
 * auth, so the posture is realized as the loopback bind + the operator's reverse
 * proxy/firewall (documented honestly — NOT gateway-token-gated). `cardinalityCap`
 * (default 10000) WARNs with a hint on breach; the `comis_prometheus_series`
 * self-metric exposes the active series count.
 */
const PrometheusConfigSchema = z.strictObject({
  /** Master switch for the `/metrics` pull surface (independent of `otel.enabled`). Default off. */
  enabled: z.boolean().default(false),
  /** Bind host for the exporter's loopback HTTP listener. Default 127.0.0.1 (never 0.0.0.0 implicitly). */
  host: z.string().default("127.0.0.1"),
  /** Bind port for the exporter's HTTP listener. */
  port: z.number().int().min(1).max(65535).default(9464),
  /** The scrape path the exporter serves. */
  path: z.string().default("/metrics"),
  /**
   * Access posture. ONLY `'trusted-operator'` — the OTel PrometheusExporter has
   * no built-in auth; the posture is the loopback bind + the operator's reverse
   * proxy/firewall (NOT gateway-token-gated; documented honestly).
   */
  auth: z.literal("trusted-operator").default("trusted-operator"),
  /**
   * Whether exemplars are desired on the pull surface. NOTE: the installed
   * `@opentelemetry/exporter-prometheus@0.219.0` does NOT render OpenMetrics
   * exemplars (`PROMETHEUS_EXEMPLARS_SUPPORTED===false`); the `trace_id` rides as
   * a span attribute instead. Kept as a forward-looking knob.
   */
  exemplars: z.boolean().default(true),
  /** Max active series before a WARN-with-hint fires (the label-explosion DoS guard). */
  cardinalityCap: z.number().int().positive().default(10000),
});

/**
 * Cost-attribution granularity configuration. Controls
 * whether the per-tool tag (`tool_tag` on `obs_token_usage`) and the per-subagent
 * corrected-$ rollup are computed/surfaced. Both ship ON. NOTE: the per-tool
 * attribution is best-effort and labeled as such — an even split across the turn's tools
 * that conserves the total, never exact per-tool accounting.
 */
const CostGranularitySchema = z.strictObject({
  /** Tag each token_usage row with the distinct tools that fired the turn. Default on. */
  perTool: z.boolean().default(true),
  /** Roll up corrected-$ per subagent node/subtree. Default on. */
  subagentRollup: z.boolean().default(true),
});

/**
 * Cost-export configuration. Controls the CSV export surface and
 * quarter-hour time bucketing for the cost views/CLI. Both ship ON. (Named to
 * avoid collision with the existing `persistence`/`audit` keys.)
 */
const ExportConfigSchema = z.strictObject({
  /** Offer CSV (alongside JSON) on the cost export surface (CLI + SPA). Default on. */
  csv: z.boolean().default(true),
  /** Expose 15-minute (quarter-hour) cost buckets in addition to hourly. Default on. */
  quarterHourBuckets: z.boolean().default(true),
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
  /** Security-audit persistence policy. */
  audit: AuditConfigSchema.default(() => AuditConfigSchema.parse({})),
  /** Spend kill-switch policy — ships off (null ceilings, action 'warn'). */
  spend: SpendConfigSchema.default(() => SpendConfigSchema.parse({})),
  /** OpenTelemetry OTLP push policy — opt-in extension, ships off + content-free. */
  otel: OtelConfigSchema.default(() => OtelConfigSchema.parse({})),
  /** Prometheus `/metrics` pull policy — opt-in, standalone, loopback-bound, ships off. */
  prometheus: PrometheusConfigSchema.default(() => PrometheusConfigSchema.parse({})),
  /** Cost-attribution granularity — per-tool tag + per-subagent rollup, ship on. */
  costGranularity: CostGranularitySchema.default(() => CostGranularitySchema.parse({})),
  /** Cost-export surface — CSV + quarter-hour bucketing, ship on. */
  export: ExportConfigSchema.default(() => ExportConfigSchema.parse({})),
});

export type ObservabilityConfig = z.infer<typeof ObservabilityConfigSchema>;
export type ObservabilityPersistenceConfig = z.infer<typeof ObservabilityPersistenceSchema>;
export type TrajectoryObservabilityConfig = z.infer<typeof TrajectoryObservabilityConfigSchema>;
export type LogRotationConfig = z.infer<typeof LogRotationConfigSchema>;
export type AlertBudgetConfig = z.infer<typeof AlertBudgetConfigSchema>;
export type AlertBudgetThreshold = z.infer<typeof AlertBudgetThresholdSchema>;
export type AuditConfig = z.infer<typeof AuditConfigSchema>;
export type SpendConfig = z.infer<typeof SpendConfigSchema>;
export type OtelConfig = z.infer<typeof OtelConfigSchema>;
export type PrometheusConfig = z.infer<typeof PrometheusConfigSchema>;
export type CostGranularityConfig = z.infer<typeof CostGranularitySchema>;
export type ExportConfig = z.infer<typeof ExportConfigSchema>;
export {
  LogRotationConfigSchema,
  AuditConfigSchema,
  SpendConfigSchema,
  OtelConfigSchema,
  PrometheusConfigSchema,
  CostGranularitySchema,
  ExportConfigSchema,
};
