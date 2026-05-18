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

// Owned by 45-03 (filled with trajectory.{enabled,dir,maxFileBytes,eventTypes} in that plan).
const TrajectoryConfigSchema = z.object({}).default({});

// Owned by Phase 46 (cache-trace subsection, out of Phase 45 scope).
const CacheTraceConfigSchema = z.object({}).default({});

// Owned by 45-05 (filled with configAudit.{enabled,rotateAtBytes,keepRotated} in that plan).
const ConfigAuditConfigSchema = z.object({}).default({});

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
