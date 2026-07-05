// SPDX-License-Identifier: Apache-2.0
/**
 * Bundle-size measurement for `packages/web/src/api/contracts.generated.ts`.
 *
 * Budget:
 *   - 138 KB minified  (`BUDGET_MINIFIED_BYTES`)
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
 * Budget: 138 KB minified.
 *
 * This cap tracks legitimate additive contract growth — new admin RPCs and
 * bounded, content-free optional sections on the IncidentReport /
 * FleetHealthReport (one request/response pair each) — rather than loosening the
 * wire constraint. The real wire cost is the gzipped total, which stays far under
 * the 38 KB gzipped budget; only the minified cap needs to move as contracts are
 * added. Raise it only when a bounded, additive addition overflows it, after
 * confirming the gzipped total still has ample headroom.
 *
 * Last raised for two additive, content-free report additions that landed
 * together: the `IncidentReport.orchestrate` per-run section, and the cron
 * wake-gate sections — the `cronWakeGate` efficiency block on `FleetHealthReport`
 * (per-agent skip-rate / turns-saved / net-cost) and the `cronWakeGate` fact on
 * `IncidentReport`, plus the cron authoring-contract fields. Gzipped stays
 * ~13.7 KB (far under the 38 KB gzipped budget).
 */
export const BUDGET_MINIFIED_BYTES = 138_000;

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
