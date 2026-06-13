// SPDX-License-Identifier: Apache-2.0
/**
 * GENQ-01: the pure, single-source (I7) generation-quality classifier.
 *
 * Generalizes the v2.22 OBS-01 `dominantScript(source) vs dominantScript(output)`
 * check — which the context-engine summary path already runs to emit
 * `context:summary_language_mismatch` — into one shared classifier consumed by
 * EVERY memory-generation pass (consolidation, reasoning, user-representation).
 * A weak local model that silently translates non-Latin source memories into a
 * Latin output (F-ML1: the user-representation pass translated Hebrew facts into
 * an English profile, found offline not via obs) becomes a counted fleet signal.
 *
 * VISIBILITY ONLY — pure function, NO gating, no rejection (the v2.22 §8 REJECT:
 * a mixed code-heavy chunk legitimately skews Latin via the 0.3 dominance
 * threshold in `dominantScript`, so a rejection rule over-fires). NO imports from
 * any @comis package beyond the pure `dominantScript` data table; no I/O, clock,
 * or env (I9). Reads the text locally and returns enums/booleans — nothing leaks.
 * @module
 */
import { dominantScript, type ScriptClass } from "./script-classes.js";

/** The closed set of memory-generation passes a quality signal can describe. */
export type GenerationPass = "summary" | "consolidation" | "reasoning" | "user_representation";

/** The pure classification of one (source → output) generation pair. */
export interface GenerationQualityClassification {
  /** Dominant script of the generation INPUT (the source memories/chunk). */
  readonly sourceScript: ScriptClass;
  /** Dominant script of the generated OUTPUT. */
  readonly outputScript: ScriptClass;
  /** A non-Latin source whose output came back Latin (the F-ML1 regression class).
   *  False whenever the output is empty — `emptyOutput` owns that case. */
  readonly languageMismatch: boolean;
  /** The output is empty / whitespace-only (the pass produced nothing usable). */
  readonly emptyOutput: boolean;
}

/**
 * Classify one generation pass's (source, output) text pair. Two O(n)
 * `dominantScript` passes (SCRIPT-01) plus a trim. Pure and deterministic:
 * the same pair always yields the same result.
 *
 * `languageMismatch` mirrors the summary detector's predictable small-model
 * failure: it fires ONLY when a non-Latin source produced a Latin output, and
 * never on an empty output (that is `emptyOutput`'s signal — the two are
 * disjoint so a caller can count them independently).
 */
export function classifyGenerationQuality(source: string, output: string): GenerationQualityClassification {
  const emptyOutput = output.trim().length === 0;
  const sourceScript = dominantScript(source);
  const outputScript = dominantScript(output);
  const languageMismatch = !emptyOutput && sourceScript !== "latin" && outputScript === "latin";
  return { sourceScript, outputScript, languageMismatch, emptyOutput };
}
