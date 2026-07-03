// SPDX-License-Identifier: Apache-2.0
/**
 * Schema module for the support bundle — the contract every other part of the
 * bundle reads and writes against.
 *
 * `HostSnapshot`, `SupportTriage`, and `SupportBundleWarning` are declared as
 * `z.strictObject` schemas paired with `z.infer` types and a `parseX()` helper
 * returning `Result<T, z.ZodError>`. A later reader parses a possibly-corrupt
 * `triage.json` back into typed objects, so the schema is the trust boundary:
 * `strictObject` rejects any unknown key, `z.literal` pins `schemaVersion`, and
 * `z.enum` closes the `status` set — so a drifted or forged artifact fails to
 * parse rather than flowing through as a partially-typed object.
 *
 * @module
 */

import { ok, err, type Result } from "@comis/shared";
import { z } from "zod";

/**
 * Content-free host/install facts. Deliberately omits hostname, environment
 * values, and repository state so no host-enumerating field can be added
 * silently — `strictObject` forbids anything outside this set. `cliVersion`
 * and `daemonVersion` are optional: the shared version reader may return
 * undefined and the daemon build version is only known when the daemon is up.
 */
export const HostSnapshotSchema = z.strictObject({
  cliVersion: z.string().optional(),
  daemonVersion: z.string().optional(),
  nodeVersion: z.string(),
  platform: z.string(),
  arch: z.string(),
});

export type HostSnapshot = z.infer<typeof HostSnapshotSchema>;

/**
 * A recoverable, section-level failure recorded on the bundle manifest so a
 * partial bundle is still generated (the section that failed is annotated
 * rather than aborting the whole run). `source` is the closed set of bundle
 * sections that can fail (the doctor run, the host snapshot, the file writer,
 * the fleet report, or the config-posture digest); `code` is the
 * section-failure identifier; `rows` carries offending indices when applicable.
 */
export const SupportBundleWarningSchema = z.strictObject({
  source: z.enum(["doctor", "host", "writer", "fleet", "config-posture"]),
  code: z.string(),
  count: z.number(),
  rows: z.array(z.number()).optional(),
  message: z.string(),
});

export type SupportBundleWarning = z.infer<typeof SupportBundleWarningSchema>;

/**
 * The closed triage verdict set. `insufficient_evidence` exists so an empty or
 * offline read never reports `healthy` — the reducer ranks it above `healthy`.
 */
export const SupportTriageStatusSchema = z.enum([
  "healthy",
  "degraded",
  "misconfigured",
  "insufficient_evidence",
]);

export type SupportTriageStatus = z.infer<typeof SupportTriageStatusSchema>;

/**
 * The machine-readable privacy declaration shared by the triage and the
 * manifest: the redaction fingerprint plus the enumerated exclusion set that
 * every downstream render and writer honors. A single source keeps the two
 * artifacts from drifting on either the fingerprint or the exclusion contract.
 */
const PrivacyDeclarationSchema = z.strictObject({
  redaction: z.literal("platform-aware-v1"),
  excludes: z.array(z.string()),
});

/**
 * The deterministic triage verdict — the machine-readable core of the bundle.
 *
 * `schemaVersion` is the literal 1 and `status` is the closed four-value set,
 * so a version-drifted or out-of-set artifact fails `parseSupportTriage`.
 * `fleetSummary` and `explainSummary` are optional and always omitted here;
 * they are declared now so later enrichment can populate them without a
 * schema-version bump. `doctorSummary.failing` holds the distinct failing
 * check categories (the pure reducer only ever holds category labels, not
 * per-check ids).
 */
export const SupportTriageSchema = z.strictObject({
  schemaVersion: z.literal(1),
  status: SupportTriageStatusSchema,
  activeSignals: z.array(z.string()),
  host: HostSnapshotSchema,
  doctorSummary: z.strictObject({
    checksRun: z.number(),
    pass: z.number(),
    warn: z.number(),
    fail: z.number(),
    skip: z.number(),
    repairable: z.number(),
    failing: z.array(z.string()),
  }),
  fleetSummary: z
    .strictObject({
      degradedRate: z.number(),
      topErrorKinds: z.array(z.strictObject({ kind: z.string(), count: z.number() })),
      breakerTripTotal: z.number(),
      findingCodes: z.array(z.string()),
      likelyRootCause: z.string().nullable(),
    })
    .optional(),
  explainSummary: z
    .strictObject({
      degraded: z.boolean(),
      endReason: z.string(),
      likelyRootCause: z.string().nullable(),
    })
    .optional(),
  reporterNextSteps: z.array(z.string()),
  maintainerNextSteps: z.array(z.string()),
  evidenceFiles: z.array(z.strictObject({ path: z.string(), description: z.string() })),
  privacy: PrivacyDeclarationSchema,
});

export type SupportTriage = z.infer<typeof SupportTriageSchema>;

/**
 * Parse unknown input into a SupportTriage, returning `Result<T, z.ZodError>`.
 *
 * Wraps `safeParse` so call sites chain by early-return and never touch
 * `.parse()` (which throws). A malformed artifact — an unknown key, an
 * out-of-set status, or a version other than 1 — returns `err`.
 */
export function parseSupportTriage(raw: unknown): Result<SupportTriage, z.ZodError> {
  const result = SupportTriageSchema.safeParse(raw);
  if (result.success) {
    return ok(result.data);
  }
  return err(result.error);
}

/**
 * The config-posture digest written as `config-posture.json`.
 *
 * Content-free by construction. `sections` is the set of top-level config
 * section NAMES the raw config file wrote (each a member of the fixed
 * AppConfigSchema universe) — a category structurally incapable of holding a
 * config value. `configPosture` is the fleet `config_posture` finding copied
 * verbatim: its `detail` carries closed name+state labels (e.g.
 * `gateway.tls (off)`) and a stranded-secret COUNT, never a secret value, and
 * it is null when no such finding fired. `schemaVersion` is the literal 1 and
 * the object is strict, so a drifted or forged digest fails
 * `parseConfigPosture` rather than flowing through as a partially-typed object.
 */
export const ConfigPostureDigestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sections: z.array(z.string()),
  configPosture: z
    .strictObject({
      detail: z.string(),
      count: z.number(),
      hint: z.string(),
    })
    .nullable(),
});

export type ConfigPostureDigest = z.infer<typeof ConfigPostureDigestSchema>;

/**
 * Parse unknown input into a ConfigPostureDigest, returning
 * `Result<T, z.ZodError>`. An unknown key, a version other than 1, or a
 * malformed posture finding returns `err`.
 */
export function parseConfigPosture(raw: unknown): Result<ConfigPostureDigest, z.ZodError> {
  const result = ConfigPostureDigestSchema.safeParse(raw);
  if (result.success) {
    return ok(result.data);
  }
  return err(result.error);
}

/**
 * The bundle manifest — the top-level index written as `manifest.json`.
 *
 * `redaction.policy` is the platform-aware fingerprint recorded so a reader
 * can confirm which redaction pass produced the bundle; `privacy` enumerates
 * the machine-readable exclusion set every writer honors. `warnings` is
 * optional and holds recoverable, section-level failures so a partial bundle
 * still carries an honest record of what could not be produced. `generatedAt`
 * is caller-stamped (ISO 8601), keeping the reducer that builds the triage
 * pure and timestamp-free.
 */
export const SupportBundleManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  bundle: z.string(),
  generatedAt: z.string(),
  redaction: z.strictObject({ policy: z.literal("platform-aware-v1") }),
  privacy: PrivacyDeclarationSchema,
  warnings: z.array(SupportBundleWarningSchema).optional(),
});

export type SupportBundleManifest = z.infer<typeof SupportBundleManifestSchema>;

/**
 * Parse unknown input into a SupportBundleManifest, returning
 * `Result<T, z.ZodError>`. A drifted redaction policy, an unknown key, or a
 * version other than 1 returns `err`.
 */
export function parseSupportBundleManifest(
  raw: unknown,
): Result<SupportBundleManifest, z.ZodError> {
  const result = SupportBundleManifestSchema.safeParse(raw);
  if (result.success) {
    return ok(result.data);
  }
  return err(result.error);
}
