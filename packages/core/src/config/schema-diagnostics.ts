// SPDX-License-Identifier: Apache-2.0
/**
 * Diagnostics configuration scaffold.
 *
 * Top-level `diagnostics` section with four placeholder subschemas.
 * Each subsection is owned by a later plan and filled in that plan
 * only — this file is created here once and never re-created
 * downstream:
 *
 *   - `diagnostics.trajectory`  — owned by Plan 45-03
 *     (filled with `{enabled, dir, maxFileBytes, eventTypes}` then).
 *
 *   - `diagnostics.cacheTrace`  — owned by Phase 46 (out of Phase 45
 *     scope).
 *
 *   - `diagnostics.configAudit` — owned by Plan 45-05
 *     (filled with `{enabled, rotateAtBytes, keepRotated}` then).
 *
 *   - `diagnostics.redact`      — placeholder slot.
 *     Per checker Finding #3, Plan 45-02 lands the redact knobs inside
 *     the existing `daemon.logging` section (schema-daemon.ts), NOT
 *     here. This subschema remains empty for forward-compat (Phase 46+
 *     may move redact knobs here).
 *
 * Defaults are sticky: `.default({})` on each empty subschema so a
 * minimal AppConfig parse populates the whole tree without explicit
 * `diagnostics: {}` in YAML. This is the standard Comis schema pattern
 * (see schema-observability.ts ObservabilityConfigSchema for the same
 * shape).
 *
 * The section-registry parity snapshot is regenerated ONCE on this
 * file's introduction. Later plans add fields *within* existing
 * subschemas, which does not trip the snapshot.
 *
 * @module
 */

import { z } from "zod";

/**
 * `diagnostics.trajectory.*` schema (Plan 45-03 task 11).
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
 *     event (the default mode). Consumer-side filtering is deferred
 *     to a Phase 45 follow-up if needed.
 *
 * Per the 45-01 sequencing decision the section-registry parity
 * snapshot is NOT touched here — the `diagnostics` section was already
 * registered in 45-01 task 12. Only the field-metadata snapshot for
 * `diagnostics.trajectory` (which previously showed an empty object)
 * is regenerated when the schema below lands.
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
 * `diagnostics.cacheTrace.*` schema (Plan 46-01).
 *
 * Configures the per-session cache-trace JSONL artifact written by
 * `packages/observability/src/cache-trace/runtime.ts`. All fields carry
 * defaults so an empty `diagnostics.cacheTrace: {}` block in YAML
 * produces a valid configuration:
 *
 *   - `enabled: false` — the writer is OFF by default (opt-in, contrary
 *     to trajectory which is on-by-default). Operators set this true to
 *     start gathering cache-hit / cache-write digests for diagnostics.
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
  enabled: z.boolean().default(false),
  filePath: z.string().optional(),
  includeMessages: z.boolean().default(false),
  includePrompt: z.boolean().default(true),
  includeSystem: z.boolean().default(true),
});

const CacheTraceConfigSchema = CacheTraceConfigSchemaInner.default(() =>
  CacheTraceConfigSchemaInner.parse({}),
);

/**
 * `diagnostics.configAudit.*` schema (Plan 45-05 task 14).
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
 *     though they presently always write (a downstream plan may
 *     wire the gate at the hook).
 *   - `rotateAtBytes: 10 MB` — file-size cap that triggers rotation.
 *     The append helper does NOT use the size-cap rejection path
 *     from `appendRegularFile`; rotation is what bounds total disk
 *     use.
 *   - `keepRotated: 5` — number of historical rotations to retain
 *     (`.1` through `.5`). The oldest is discarded when rotation
 *     fires at the cap.
 *
 * Per the 45-01 sequencing decision the section-registry parity
 * snapshot is NOT touched here — the `diagnostics` section was
 * already registered in 45-01 task 12. This task only fills an
 * empty subschema (a field-level change, not section-level).
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

// Placeholder slot — per checker Finding #3, 45-02 lands redact knobs inside the
// existing daemon.logging section (schema-daemon.ts), NOT here. This subschema
// remains empty for forward-compat (Phase 46+ may move redact knobs here).
const DiagnosticsRedactConfigSchema = z.object({}).default({});

/**
 * Root diagnostics configuration schema.
 *
 * Has sensible defaults so an empty object produces a valid
 * DiagnosticsConfig. The four subsections are placeholders owned by
 * later plans (see file header).
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
  redact: DiagnosticsRedactConfigSchema,
});

export const DiagnosticsConfigSchema = DiagnosticsConfigSchemaInner.default(() =>
  DiagnosticsConfigSchemaInner.parse({}),
);

export type DiagnosticsConfig = z.infer<typeof DiagnosticsConfigSchema>;
