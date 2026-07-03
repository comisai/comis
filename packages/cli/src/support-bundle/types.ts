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
 * sections that can fail; `code` is the section-failure identifier; `rows`
 * carries offending indices when applicable.
 */
export const SupportBundleWarningSchema = z.strictObject({
  source: z.enum(["doctor", "host", "writer"]),
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
  privacy: z.strictObject({
    redaction: z.literal("platform-aware-v1"),
    excludes: z.array(z.string()),
  }),
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
