// SPDX-License-Identifier: Apache-2.0
/**
 * Generic per-tier benchmark suite report builder -- the single manifest shape
 * every Comis-unique, external-benchmark, and BEAM harness writes to disk via `writeRegularFile`,
 * so a Comis suite number is reproducible across changes and comparable
 * per-ability.
 *
 * WHY A SIBLING OF qa-report.ts: the shipped
 * `BenchmarkReport.benchmark` is a CLOSED union (`"longmemeval" | "locomo" |
 * "combined"`), frozen by the J1 secret-omission tests. The new tiers
 * (`poisoning`, `redaction`, `trust-contradiction`, `recall-learning`, `beam`,
 * `longmemeval-v2`, `memoryagentbench`, `pref`, `halumem`, …) need an OPEN tier
 * name, so this is a separate GENERIC `{ tier: string, ... }` manifest rather
 * than a union-widening of the frozen `qa-report.ts`.
 *
 * BUILD-THEN-WRITE split (analog qa-report.ts): this module builds the report
 * object PURELY (no I/O, fully unit-testable); the `writeRegularFile` call lives
 * in the gated `.bench.test.ts`.
 *
 * SECURITY -- structural secret omission (ASVS V7, the qa-report.ts
 * doctrine copied VERBATIM in style): the report is persisted via
 * writeRegularFile, OUTSIDE Pino's redaction safety-net, so the builder itself
 * must guarantee no credential ever reaches the file. It does so STRUCTURALLY:
 * the input `config` is NEVER spread; each ability is rebuilt as a fresh
 * `{ ability, result }` whose `result` is rebuilt field-by-field via
 * {@link pickAccuracy} -- only the numeric + `perCategory` fields are copied, so
 * any extra secret-bearing field hung off the input (`apiKey`, a credential-bearing
 * `base_url`, an `authorization: Bearer …`) has NO path to the output object.
 * Even when the operator config carries a secret, it cannot appear in
 * `JSON.stringify(report)` because there is no path from the input secret to the
 * output. (RED gate: suite-report.test.ts Test 3 asserts the serialized report
 * contains none of `/apiKey|sk-|Bearer|base_url/` with a secret-bearing config.)
 *
 * SECURITY -- prototype-pollution discipline (copied from
 * qa-accuracy.ts): the `perCategory` keys originate from the UNTRUSTED dataset
 * `category` strings. The rebuilt map is a null-prototype object
 * (`Object.create(null)`) with literal-keyed `{ correct, total, invalid,
 * accuracy }` writes, so a `__proto__`/`constructor` category key becomes an
 * ordinary own data property and can NEVER mutate `Object.prototype`.
 *
 * GLOBALS: `timestamp` is `systemDateFrom(nowMs).toISOString()` with `nowMs`
 * INJECTED by the caller -- never a wall-clock read (no raw `Date` constructor or
 * `Date.now()` in src; the sanctioned `systemDateFrom` indirection only, exactly
 * qa-report.ts / filesystem-baseline.ts).
 *
 * ARCHITECTURE CUT (architecture-graph.test.ts:133): a PURE module; the agent
 * package may not import the memory package. Imports are limited to
 * `systemDateFrom` from `@comis/core` (the ONLY value import) and the
 * `AccuracyResult` / `CategoryAccuracy` TYPES from the in-package `qa-accuracy.ts`.
 *
 * @module
 */

import { systemDateFrom } from "@comis/core";
import type { AccuracyResult, CategoryAccuracy } from "./qa-accuracy.js";

/**
 * One ability's score within a tier: a stable ability label + its per-category
 * {@link AccuracyResult}. The `ability` is a fixed identifier string (e.g.
 * `"answer-hijack"`, `"single-hop"`); `result` is the corrected-denominator
 * accuracy fold from `aggregateAccuracy`.
 */
export interface AbilityScore {
  /** The ability label (a fixed identifier; the comparability anchor). */
  ability: string;
  /** The per-ability accuracy result (overall + per-category, corrected denominator). */
  result: AccuracyResult;
}

/**
 * The builder INPUT: a tier's label + harness version + its per-ability scores.
 * The harness assembles this; abilities MAY carry extra (secret-bearing) fields
 * on `result` -- {@link buildSuiteReport} reads ONLY the contract fields and never
 * the rest, so excess fields are structurally dropped.
 */
export interface SuiteTierResult {
  /** The tier name (OPEN string -- e.g. "poisoning", "beam", "longmemeval-v2"). */
  tier: string;
  /** The harness version tag (e.g. "phase-99-v1"). */
  harnessVersion: string;
  /** The per-ability scores for this tier (may be empty -- a tier with no abilities). */
  abilities: AbilityScore[];
}

/**
 * The OUTPUT manifest: the input tier result plus an injected-clock timestamp.
 * Structurally secret-free (see the module doc). Written to disk via
 * `writeRegularFile` in the gated harness.
 */
export type SuiteReport = SuiteTierResult & {
  /** ISO timestamp derived from the injected `nowMs` (never a wall-clock read). */
  timestamp: string;
};

/**
 * Rebuild a {@link CategoryAccuracy} bucket as a fresh numeric-only record
 * (drops any extra fields hung off the input). Pure numbers in -> pure numbers
 * out; no path from a config secret to the output.
 */
function pickCategory(c: CategoryAccuracy): CategoryAccuracy {
  return { correct: c.correct, total: c.total, invalid: c.invalid, accuracy: c.accuracy };
}

/**
 * Rebuild an {@link AccuracyResult} field-by-field (never spreads the input).
 * Copies only the numeric scalars + a freshly-materialized null-prototype
 * `perCategory` map with literal-keyed numeric buckets -- so neither an off-contract
 * secret-bearing field on the input result NOR a `__proto__`/`constructor` category
 * key can reach the output (the qa-report.ts + qa-accuracy.ts
 * doctrine). Mirrors qa-report.ts's `pickCost`/`pickLatency` style.
 */
function pickAccuracy(r: AccuracyResult): AccuracyResult {
  // Null-prototype map: a `__proto__`/`constructor` category key is an ordinary
  // own data property here, never a prototype mutation (qa-accuracy.ts:135).
  const perCategory: Record<string, CategoryAccuracy> = Object.create(null) as Record<
    string,
    CategoryAccuracy
  >;
  for (const key of Object.keys(r.perCategory)) {
    // `Object.keys` yields only present keys and the project does not set
    // `noUncheckedIndexedAccess`, so the indexed access is a defined
    // `CategoryAccuracy` (no defensive `undefined` guard needed -- that branch
    // would be unreachable). Literal-keyed write of a freshly-rebuilt numeric
    // bucket (no input spread), so a `__proto__`/`constructor` key stays an
    // ordinary own data property.
    perCategory[key] = pickCategory(r.perCategory[key]);
  }
  return {
    overall: r.overall,
    correct: r.correct,
    total: r.total,
    invalid: r.invalid,
    validTotal: r.validTotal,
    perCategory,
  };
}

/**
 * Rebuild an {@link AbilityScore} as a fresh `{ ability, result }` (never spreads
 * the input). The `ability` label is copied as a primitive; the `result` is
 * structurally rebuilt via {@link pickAccuracy}, so any extra secret-bearing field
 * hung off the input ability or its result is dropped.
 */
function pickAbility(a: AbilityScore): AbilityScore {
  return { ability: a.ability, result: pickAccuracy(a.result) };
}

/**
 * Build the reproducible {@link SuiteReport} from a tier result + an injected
 * `nowMs`.
 *
 * SECURITY: structurally rebuilds the tier label, harness version, and every
 * ability (field-by-field via {@link pickAbility}/{@link pickAccuracy}) -- the
 * input `config` is never spread, so no extra credential/base-url field on
 * `config`, `config.abilities[i]`, or `config.abilities[i].result` can reach the
 * output (and thus the persisted file). The timestamp uses the injected clock.
 * TOTAL: an empty `abilities` yields `abilities: []` (never throws).
 */
export function buildSuiteReport(config: SuiteTierResult, nowMs: number): SuiteReport {
  return {
    tier: config.tier,
    harnessVersion: config.harnessVersion,
    timestamp: systemDateFrom(nowMs).toISOString(),
    abilities: config.abilities.map(pickAbility),
  };
}
