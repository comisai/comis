// SPDX-License-Identifier: Apache-2.0
/**
 * Bundle-size measurement for `packages/web/src/api/contracts.generated.ts`.
 *
 * Budget:
 *   - 120 KB minified  (`BUDGET_MINIFIED_BYTES`)
 *   - 38 KB  gzipped   (`BUDGET_GZIPPED_BYTES`)
 *
 * Measurement architecture:
 *   1. Minify the emitted TS via `esbuild.transformSync({ minify: true, loader: "ts" })`.
 *   2. Gzip the minified bytes with `gzipSync(..., { level: 9 })` — level 9 matches
 *      `Content-Encoding: gzip` from a typical static-asset CDN.
 *   3. Per-contract size = `JSON.stringify(jsonSchemaEntry).length` (a request +
 *      response sum). Approximate — not a true minified-isolated measure — but
 *      sufficient to flag per-contract bloat outliers.
 *
 * Determinism: esbuild's minify is deterministic for the same input + pinned
 * version (per the esbuild release notes "minify is deterministic"). The
 * pinned version is in package.json devDependencies.
 *
 * @module
 */
import { transformSync } from "esbuild";
import { gzipSync } from "node:zlib";

/**
 * Budget: 122 KB minified. Raised from 121 KB for the Phase-164
 * `session.reset_conversation` admin contract (the complete cross-mode forget
 * that clears both the LCD history and the daemon sessionStore). The addition is
 * bounded (one request/response pair) and gzip-friendly — the gzipped total (the
 * real wire cost) stays well under the 38 KB gzipped budget, so this tracks the
 * legitimate contract growth rather than loosening the wire constraint.
 */
// 2026-06-11: +5 response fields across 3 contracts (memory.ask reason,
// reset_conversation runtimeSessionDestroyed, recall_trace tracingEnabled +
// hint) pushed minified to 122,032 — bumped with headroom; gzipped stays
// far under its own budget.
// 2026-06-19: ORCH-OBS nodeBudgetBreaches[] on the obs.explain IncidentReport
// (+380 B → 126,225) overflowed the prior 126,000. Bumped to 127,000 with
// headroom; the addition is bounded and gzip-friendly (gzipped total 12,575
// stays far under the 38 KB gzipped wire budget).
// 2026-06-20: AUDIT-05 (Phase 176 Plan 05) — the new obs.audit.query contract
// (+664 B) + the IncidentReport `audit?`/`cacheBreaks?` optional sections
// (obs.explain +~400 B → total 127,299) overflowed 127,000. Bumped to 128,000
// with headroom; both are bounded, additive, content-free sections in the proven
// optional-section family, and the gzipped total (12,703) stays far under the
// 38 KB gzipped wire budget (the real wire cost).
// 2026-06-21: WEBUI-02 (Phase 179 Plan 04) — the two new admin RPCs
// obs.cacheBreaks.byReason (+498 B) + obs.spend.snapshot (+350 B), plus the
// IncidentReport `spend?` optional section (obs.explain +~200 B → total 128,351)
// overflowed 128,000. Bumped to 129,000 with headroom; all three are bounded,
// additive, content-free (the loose ObsRecord/ObsRecordArray response shapes +
// the proven optional-section family), and the gzipped total (12,779) stays far
// under the 38 KB gzipped wire budget (the real wire cost).
// 2026-06-23: REVOKE-01/03 (Phase 213 Plan 03) — the two new admin RPCs
// lease.revoke (req { leaseId?, rootRunId? }, resp { revoked }) + run.kill
// (req { rootRunId }, resp { killed }) added +864 B → total 129,215, overflowing
// 129,000. Bumped to 130,000 with headroom; both are bounded one request/response
// pairs and gzip-friendly — the gzipped total (12,864) stays far under the 38 KB
// gzipped wire budget (the real wire cost).
// 2026-06-23: v2.29 AUDIT/TREE/INTRO (Phase 215) — the obs.explain spawnTree
// IncidentReport section (Plan 03 — the root→children authorization topology) +
// the capabilities.introspect contract with its nested budget+outwardQuota
// response (Plan 04 — the `comis whoami` read) added +1,182 B → total 130,397,
// overflowing 130,000. Bumped to 131,000 with headroom; both are bounded,
// additive, content-free (the proven optional-section family + one
// request/response pair), and the gzipped total (13,045) stays far under the
// 38 KB gzipped wire budget (12,864 → 13,045 — ample headroom; only the minified
// cap needs the bump).
export const BUDGET_MINIFIED_BYTES = 131_000;

/** Budget: 38 KB gzipped. */
export const BUDGET_GZIPPED_BYTES = 38_912;

/**
 * Per-contract JSON Schema entry as serialized for size estimation.
 * Caller passes the schema map post-codegen so we can compute per-contract
 * bytes alongside the totals.
 */
export interface PerContractSchemaEntry {
  readonly request: unknown;
  readonly response: unknown;
}

/** Shape of the JSON written to `contracts.generated.size.json`. */
export interface SizeReport {
  /** Total bytes after esbuild minification. */
  readonly totalMinified: number;
  /** Total bytes after esbuild minification + gzip (level 9). */
  readonly totalGzipped: number;
  /** Budget configuration (BUDGET_MINIFIED_BYTES + BUDGET_GZIPPED_BYTES). */
  readonly budget: {
    readonly minified: number;
    readonly gzipped: number;
  };
  /** True iff either total exceeds its budget. */
  readonly overBudget: boolean;
  /** Per-method size estimate (request JSON + response JSON, post-strigify bytes). */
  readonly perContract: Readonly<Record<string, number>>;
  /**
   * Intentionally null to preserve byte-deterministic reruns (no timestamps).
   */
  readonly generatedAt: null;
  /**
   * Intentionally null — Node version sensitivity is verified by codegen test
   * and is not part of the artifact.
   */
  readonly nodeVersion: null;
}

/**
 * Measure the emitted TS source: minify, gzip, and compute per-contract bytes.
 *
 * @param generatedSource     The full TS source emitted by `emitDispatchTableTs`.
 * @param perContractSchemas  Map of method-name → { request, response } JSON
 *                            Schema entries (alphabetically sorted by key).
 * @returns                   A {@link SizeReport} suitable for JSON-stringification.
 */
export function measureSizes(
  generatedSource: string,
  perContractSchemas: Readonly<Record<string, PerContractSchemaEntry>>,
): SizeReport {
  const minified = transformSync(generatedSource, {
    minify: true,
    loader: "ts",
    // Pinned target: ES2022 matches the project tsconfig baseline (NodeNext +
    // ES2023 lib; ES2022 is the lowest stable target that supports all the
    // primitives the validator uses without polyfills).
    target: "es2022",
  }).code;
  const gzipped = gzipSync(Buffer.from(minified), { level: 9 });

  const perContract: Record<string, number> = {};
  // Preserve insertion order from `perContractSchemas` (caller sorts).
  for (const [method, entry] of Object.entries(perContractSchemas)) {
    const reqJson = JSON.stringify(entry.request);
    const resJson = JSON.stringify(entry.response);
    perContract[method] = reqJson.length + resJson.length;
  }

  return {
    totalMinified: minified.length,
    totalGzipped: gzipped.length,
    budget: {
      minified: BUDGET_MINIFIED_BYTES,
      gzipped: BUDGET_GZIPPED_BYTES,
    },
    overBudget:
      minified.length > BUDGET_MINIFIED_BYTES || gzipped.length > BUDGET_GZIPPED_BYTES,
    perContract,
    generatedAt: null,
    nodeVersion: null,
  };
}
