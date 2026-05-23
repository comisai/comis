// SPDX-License-Identifier: Apache-2.0
/**
 * Diagnostics configuration scaffold.
 *
 * Top-level `diagnostics` section with three subschemas:
 *
 *   - `diagnostics.trajectory`  — `{enabled, dir, maxFileBytes, eventTypes}`.
 *   - `diagnostics.cacheTrace`  — cache-trace JSONL artifact knobs.
 *   - `diagnostics.configAudit` — `{enabled, rotateAtBytes, keepRotated}`.
 *
 * The unused fourth subschema (a placeholder slot for future redact
 * knobs) was deleted. Runtime redaction lives in
 * `packages/infra/src/logging/logger.ts` (Pino auto-redact) and the
 * `daemon.logging` edge-keeping censor schema in schema-daemon.ts —
 * neither read this subschema.
 *
 * Defaults are sticky: `.default({})` on each empty subschema so a
 * minimal AppConfig parse populates the whole tree without explicit
 * `diagnostics: {}` in YAML. This is the standard Comis schema pattern
 * (see schema-observability.ts ObservabilityConfigSchema for the same
 * shape).
 *
 * @module
 */

import { z } from "zod";

/**
 * `diagnostics.trajectory.*` schema.
 *
 * Configures the per-session trajectory JSONL sidecar that the
 * pi-executor recorder writes (see
 * `packages/observability/src/trajectory/runtime.ts`). All fields
 * carry defaults so an empty `diagnostics.trajectory: {}` block in
 * YAML produces a valid configuration:
 *
 *   - `enabled: true` — the writer is on by default (the env
 *     `COMIS_TRAJECTORY=0` is the operator escape hatch).
 *   - `dir` — optional override for the trajectory base directory.
 *     When omitted the writer's path resolution falls back through
 *     `COMIS_TRAJECTORY_DIR` env → sessionFile co-location →
 *     workspaceDir → `process.cwd()` (see `resolveTrajectoryFilePath`).
 *   - `maxFileBytes: 50 MB` — the file cap (the per-event cap of
 *     256 KB is fixed by the runtime; only the file cap is
 *     operator-tunable).
 *   - `eventTypes` — optional allowlist of trajectory event types to
 *     record. When omitted the writer records every bridge-mapped
 *     event (the default mode).
 */
const TrajectoryConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    dir: z.string().optional(),
    maxFileBytes: z
      .number()
      .int()
      .positive()
      .default(50 * 1024 * 1024),
    eventTypes: z.array(z.string()).optional(),
  })
  .default({
    enabled: true,
    maxFileBytes: 50 * 1024 * 1024,
  });

/**
 * `diagnostics.cacheTrace.*` schema.
 *
 * Configures the per-session cache-trace JSONL artifact written by
 * `packages/observability/src/cache-trace/runtime.ts`. All fields carry
 * defaults so an empty `diagnostics.cacheTrace: {}` block in YAML
 * produces a valid configuration:
 *
 *   - `enabled: true` — the writer is ON by default (matching the
 *     trajectory sidecar). Cache-hit/cache-write digests are recorded
 *     for every LLM call so operators can diagnose cache-rate
 *     regressions without flipping a flag first. PII gating remains:
 *     `includeMessages: false` keeps raw message bodies off disk —
 *     only fingerprints + digests are recorded by default.
 *   - `filePath` — optional full path override. Default resolved at
 *     runtime via `resolveCacheTraceFilePath` to
 *     `~/.comis/logs/cache-trace.jsonl`. Tilde (`~`) prefix supported.
 *   - `includeMessages: false` — PII gate. When false (default), the
 *     emitted events carry `messageFingerprints[]` + `messagesDigest`
 *     only; the raw `messages` field is omitted. Operators opt-in by
 *     setting true (typically for short-lived debug sessions).
 *   - `includePrompt: true` — reserved for future wrapper passes that
 *     may want to include / omit the raw prompt context. Currently
 *     informational.
 *   - `includeSystem: true` — gates the `system` raw field emit. When
 *     false, only `systemDigest` (the sha256 fingerprint) is recorded.
 *
 * Uses the inner-then-default pattern from `TrajectoryConfigSchema`
 * (above) and `DiagnosticsConfigSchema` (below) so a missing key in
 * YAML still produces a fully-populated default object.
 */
const CacheTraceConfigSchemaInner = z.object({
  enabled: z.boolean().default(true),
  filePath: z.string().optional(),
  /**
   * Per-file byte cap for the cache-trace JSONL artifact. When the
   * file reaches this size, additional appends are rejected by
   * `appendRegularFile` with `FileSizeLimitExceeded`; the cache-trace
   * runtime emits an inline `cache_trace.write_failures` sentinel at
   * first rejection and a summary sentinel at session `flushAndClose`.
   * Default 50 MB matches `trajectory.maxFileBytes`.
   */
  maxFileBytes: z.number().int().positive().default(50 * 1024 * 1024),
  includeMessages: z.boolean().default(false),
  includePrompt: z.boolean().default(true),
  includeSystem: z.boolean().default(true),
});

const CacheTraceConfigSchema = CacheTraceConfigSchemaInner.default(() =>
  CacheTraceConfigSchemaInner.parse({}),
);

/**
 * `diagnostics.configAudit.*` schema.
 *
 * Configures the daemon-wide `~/.comis/logs/config-audit.jsonl`
 * append-only log written by the three config-write hook sites
 * (`last-known-good.ts`, `config-handlers/config-write.ts`,
 * `cli/commands/config.ts`). All fields carry defaults so an empty
 * `diagnostics.configAudit: {}` block in YAML produces a valid
 * configuration.
 *
 *   - `enabled: true` — the audit log is on by default. Operators
 *     who want to disable it (e.g., a privacy-sensitive deployment)
 *     can set `false`; the three hook sites SHOULD honor this flag,
 *     though they presently always write.
 *   - `rotateAtBytes: 10 MB` — file-size cap that triggers rotation.
 *     The append helper does NOT use the size-cap rejection path
 *     from `appendRegularFile`; rotation is what bounds total disk
 *     use.
 *   - `keepRotated: 5` — number of historical rotations to retain
 *     (`.1` through `.5`). The oldest is discarded when rotation
 *     fires at the cap.
 */
const ConfigAuditConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    rotateAtBytes: z
      .number()
      .int()
      .positive()
      .default(10 * 1024 * 1024),
    keepRotated: z.number().int().nonnegative().default(5),
  })
  .default({
    enabled: true,
    rotateAtBytes: 10 * 1024 * 1024,
    keepRotated: 5,
  });

/**
 * Root diagnostics configuration schema.
 *
 * Has sensible defaults so an empty object produces a valid
 * DiagnosticsConfig.
 *
 * `.default(() => ...parse({}))` is the canonical Comis pattern (mirror
 * of ObservabilityConfigSchema in schema-observability.ts) — Zod 4
 * inference requires a function that returns a fully-built default
 * shape (not just `{}`).
 */
const DiagnosticsConfigSchemaInner = z.object({
  trajectory: TrajectoryConfigSchema,
  cacheTrace: CacheTraceConfigSchema,
  configAudit: ConfigAuditConfigSchema,
});

export const DiagnosticsConfigSchema = DiagnosticsConfigSchemaInner.default(() =>
  DiagnosticsConfigSchemaInner.parse({}),
);

export type DiagnosticsConfig = z.infer<typeof DiagnosticsConfigSchema>;
