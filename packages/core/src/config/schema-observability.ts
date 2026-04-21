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
});

/**
 * Root observability configuration schema.
 *
 * Has sensible defaults so an empty object produces a valid ObservabilityConfig.
 */
export const ObservabilityConfigSchema = z.strictObject({
  /** Persistence layer settings. */
  persistence: ObservabilityPersistenceSchema.default(() => ObservabilityPersistenceSchema.parse({})),
});

export type ObservabilityConfig = z.infer<typeof ObservabilityConfigSchema>;
export type ObservabilityPersistenceConfig = z.infer<typeof ObservabilityPersistenceSchema>;
