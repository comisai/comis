// SPDX-License-Identifier: Apache-2.0
/**
 * The ablation-sweep registry (each new factor has an ablation toggle).
 * Maps every shipped recall/reasoning factor to its EXACT config knob leaf
 * so each factor's contribution to a benchmark number is independently measurable
 * (turn it OFF, re-run, read the delta). The keyless head-to-head harness drives
 * `sweepCells` at $0.
 *
 * THE VERIFIED KNOB LEAVES (verified against recall-types.ts:142-182 +
 * schema-memory-reasoning.ts:41 -- three of them have plausible-but-wrong spellings):
 *   - kg-graph-spread    -> `lanes.graphSpread.enabled`        (recall-types.ts:157)
 *   - iq-mmr             -> `mmr.enabled`         (recall-types.ts:178; NOT `rag.mmr.enabled`)
 *   - iq-intent          -> `queryUnderstanding.intentReweight` (recall-types.ts:182; the leaf
 *                           is `intentReweight`, NOT `intent`)
 *   - iq-temporal-parse  -> `queryUnderstanding.temporalParse`  (recall-types.ts:182)
 *   - reason-observations-> `memoryReasoning.enabled`  (schema-memory-reasoning.ts:41) -- the
 *                           WRITE-side offline reasoning job, NOT a MemoryRecallConfig recall
 *                           lane; represented as a sweep cell the harness threads separately.
 *
 * THE off=byte-identity SAFETY NET: a MISTYPED leaf is a silent
 * no-op toggle -- a false "no contribution" reading. {@link applyFactor} sets the
 * leaf via the EXACT path; the ablation-sweep.test.ts Test-3 proves
 * `applyFactor(baseline, factor, false)` is byte-identical to a baseline with that
 * leaf explicitly off (a wrong leaf would set a phantom key and diverge -> fail
 * loudly). Every shipped lane is "Default-OFF (`enabled:false`) -> RRF unchanged",
 * so OFF === the shipping-default posture.
 *
 * NO-MUTATION: {@link applyFactor} returns a NEW config -- it
 * rebuilds only the touched branch via structural object literals and NEVER
 * mutates the input (so a sweep can reuse one baseline across all cells without
 * cross-cell contamination).
 *
 * ARCHITECTURE CUT (architecture-graph.test.ts:133): a PURE registry; the agent
 * package may NOT import the memory package. The only cross-module import is the
 * `MemoryRecallConfig` TYPE from the in-package `../../rag/recall-types.js`
 * (type-only). No `@comis/memory`. No value imports, no I/O, no clock, no env.
 *
 * @module
 */

import type { MemoryRecallConfig } from "../../rag/recall-types.js";

/**
 * One ablation factor: a stable factor id, its EXACT config knob leaf path, the
 * on/off boolean values, and whether it is a WRITE-side toggle (the reasoning
 * job, not a recall lane -- the harness threads it separately from the recall
 * config).
 */
export interface AblationFactor {
  /** The stable factor id (the comparability anchor, e.g. "iq-mmr"). */
  readonly factor: string;
  /** The EXACT dotted config knob leaf (verified against recall-types.ts / schema-memory-reasoning.ts). */
  readonly knobPath: string;
  /** The "on" value (always `true` for these boolean enable flags). */
  readonly on: boolean;
  /** The "off" value (always `false` -- the shipping default = the no-op posture). */
  readonly off: boolean;
  /**
   * `true` for the WRITE-side reasoning job (`memoryReasoning.enabled`), which is
   * NOT a {@link MemoryRecallConfig} leaf and is threaded by the harness
   * separately; absent/false for the four recall-side lanes.
   */
  readonly writeSide?: boolean;
}

/**
 * The factor id for the write-side reasoning job -- exported so the harness (and
 * the tests) can branch on it without re-encoding the string. It is the one
 * factor whose `knobPath` (`memoryReasoning.enabled`) does NOT live on
 * {@link MemoryRecallConfig}; {@link applyFactor} therefore leaves the recall
 * config byte-identical for it.
 */
export const REASON_WRITE_SIDE_FACTOR = "reason-observations" as const;

/**
 * The shipped ablation factors, each pinned to its VERIFIED knob leaf. The
 * off=byte-identity test guards these paths against the plausible-but-wrong
 * `rag.`-prefixed / `.intent` spellings (which are not real config leaves).
 */
export const V28_ABLATION_FACTORS: readonly AblationFactor[] = [
  { factor: "kg-graph-spread", knobPath: "lanes.graphSpread.enabled", on: true, off: false },
  { factor: "iq-mmr", knobPath: "mmr.enabled", on: true, off: false },
  { factor: "iq-intent", knobPath: "queryUnderstanding.intentReweight", on: true, off: false },
  { factor: "iq-temporal-parse", knobPath: "queryUnderstanding.temporalParse", on: true, off: false },
  // WRITE-side: the offline reasoning job (schema-memory-reasoning.ts:41), NOT a recall lane.
  { factor: REASON_WRITE_SIDE_FACTOR, knobPath: "memoryReasoning.enabled", on: true, off: false, writeSide: true },
] as const;

/**
 * Apply a single ablation factor to a recall config, returning a NEW config (the
 * input is never mutated). Only the named leaf's branch is rebuilt via structural
 * object literals; sibling fields are carried through by reference (a no-mutation
 * sweep never writes them).
 *
 * The three recall-config shapes handled (the verified leaves):
 *   - `lanes.graphSpread.enabled`        -> rebuild `lanes` + `lanes.graphSpread`
 *   - `mmr.enabled`                      -> rebuild `mmr`
 *   - `queryUnderstanding.intentReweight`/`queryUnderstanding.temporalParse` -> rebuild `queryUnderstanding`
 *
 * The WRITE-side `reason-observations` factor (and any unknown factor) is a no-op
 * on the recall config -- it returns the input unchanged (byte-identical), since
 * `memoryReasoning.enabled` is not a {@link MemoryRecallConfig} leaf (it gates the
 * offline job the harness threads separately). This is deliberate: applyFactor
 * must NEVER invent a phantom recall-config key for the write-side factor.
 *
 * @param config the baseline recall config (never mutated)
 * @param factor the factor id to toggle
 * @param value the boolean to set the leaf to
 * @returns a NEW config with the factor's leaf set (or the input unchanged for a
 *   write-side/unknown factor)
 */
export function applyFactor(
  config: MemoryRecallConfig,
  factor: string,
  value: boolean,
): MemoryRecallConfig {
  switch (factor) {
    case "kg-graph-spread": {
      // Rebuild lanes + graphSpread. Spread the EXISTING branch first so its key
      // ORDER is preserved (off=byte-identity to the baseline -- a present branch
      // is byte-stable), then overwrite only `enabled`. When the lane branch is
      // entirely absent (a caller predating the lane), synthesize the full shape
      // so the toggle is meaningful rather than a silent no-op.
      const lanes = config.lanes;
      const graphSpread = lanes?.graphSpread;
      return {
        ...config,
        lanes: {
          fts: lanes?.fts ?? { weight: 1.0 },
          vector: lanes?.vector ?? { weight: 1.5 },
          ...(lanes ?? {}),
          graphSpread:
            graphSpread === undefined
              ? { enabled: value, weight: 1.0, maxDepth: 2, fanOut: 8 }
              : { ...graphSpread, enabled: value },
        },
      };
    }
    case "iq-mmr": {
      const mmr = config.mmr;
      return {
        ...config,
        mmr: mmr === undefined ? { enabled: value, lambda: 0.5 } : { ...mmr, enabled: value },
      };
    }
    case "iq-intent": {
      const qu = config.queryUnderstanding;
      return {
        ...config,
        queryUnderstanding:
          qu === undefined
            ? { intentReweight: value, synonyms: false, temporalParse: false }
            : { ...qu, intentReweight: value },
      };
    }
    case "iq-temporal-parse": {
      const qu = config.queryUnderstanding;
      return {
        ...config,
        queryUnderstanding:
          qu === undefined
            ? { intentReweight: false, synonyms: false, temporalParse: value }
            : { ...qu, temporalParse: value },
      };
    }
    default:
      // The write-side reason-observations factor (memoryReasoning.enabled is not
      // a recall-config leaf) and any unknown factor: a no-op on the recall config.
      return config;
  }
}

/** One enumerated sweep cell: a factor toggled to a value, carrying its knob leaf. */
export interface SweepCell {
  /** The factor id. */
  factor: string;
  /** The value this cell sets the leaf to. */
  value: boolean;
  /** The factor's EXACT knob leaf path (for the manifest cell->knob trace). */
  knobPath: string;
}

/**
 * Enumerate the `{factor x {on, off}}` grid for the requested factors. Each
 * KNOWN factor yields an on cell and an off cell; an unknown factor id is SKIPPED
 * (never given a fabricated knobPath -- a phantom cell would be a false reading).
 *
 * @param factors the factor ids to sweep (subset of {@link V28_ABLATION_FACTORS})
 * @returns the flat list of {@link SweepCell}s (2 per known factor, on then off)
 */
export function sweepCells(factors: readonly string[]): SweepCell[] {
  const byFactor = new Map(V28_ABLATION_FACTORS.map((f) => [f.factor, f]));
  const cells: SweepCell[] = [];
  for (const factor of factors) {
    const def = byFactor.get(factor);
    if (def === undefined) continue; // skip unknown -- no phantom cell
    cells.push({ factor: def.factor, value: def.on, knobPath: def.knobPath });
    cells.push({ factor: def.factor, value: def.off, knobPath: def.knobPath });
  }
  return cells;
}
