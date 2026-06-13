// SPDX-License-Identifier: Apache-2.0
/**
 * EMB-01 name heuristic (advisory-only, I4). Pure: no I/O/clock/env (I9).
 *
 * Classifies an embedder / reranker model id as `true | false | "unknown"` for
 * the `comis fleet` model-health line, so a degraded non-Latin semantic-recall
 * stack (an English-leaning embedder/reranker) is named in one fleet look. The
 * result NEVER gates search/recall behavior — the FTS trigram floor (Phase 180)
 * carries recall regardless. Imported by the daemon boot wiring (daemon.ts:1581).
 *
 * @module
 */

/**
 * Embedder multilingual name pattern (the genuinely-multilingual embedder
 * family: `bge-m3`, `multilingual-e5` — matched via the `multilingual` token —
 * `m3e`, `LaBSE`).
 *
 * WR-01 FIX: the design's bare `e5` alternation was unanchored and matched as a
 * substring anywhere, so English-only E5 ids (`intfloat/e5-large-v2`) and
 * incidental `type5`/`base5` slugs FALSE-POSITIVED to `true`. A false positive
 * SUPPRESSES the `model_health:embedder_not_multilingual` advisory — the harmful
 * direction, hiding the exact non-Latin degradation EMB-01 exists to surface. We
 * drop the bare `e5` token and rely on `multilingual` (which already matches the
 * `multilingual-e5-*` family); a false NEGATIVE degrades safely to `"unknown"`,
 * which still fires the advisory.
 */
export const EMBED_MULTILINGUAL = /multilingual|bge-m3|m3e|labse/i;

/**
 * Reranker multilingual name pattern. FIX for Pitfall 2: the shipped default
 * reranker slug is `bge-reranker-v2-m3` (schema-memory.ts:64-66), NOT `bge-m3`,
 * so the embedder literal above FALSE-NEGATIVES it. This pattern matches the
 * `bge-reranker-…m3` family (and the generic multilingual/bge-m3 hints).
 */
export const RERANK_MULTILINGUAL = /multilingual|bge-reranker-v2-m3|reranker.*m3|bge-m3/i;

/**
 * Resolve the advisory multilingual flag for a model id.
 *
 * @param declared - an explicit `embedding.multilingual` config boolean, or
 *                   `undefined` when undeclared (only the embedder has a config
 *                   flag today; the reranker always passes `undefined`).
 * @param modelId  - the resolved model id string (config-sourced; only `.test()`'d
 *                   against the fixed regex — never executed/interpolated, T-182-05).
 * @param re       - EMBED_MULTILINGUAL or RERANK_MULTILINGUAL.
 * @returns `declared` when it is a boolean (explicit config WINS, both directions);
 *          else `true` on a regex hit; else `"unknown"` (honest — `false` is
 *          reserved for an explicit `multilingual: false`, A2 / Open Question 3).
 */
export function resolveMultilingual(
  declared: boolean | undefined,
  modelId: string,
  re: RegExp,
): boolean | "unknown" {
  if (typeof declared === "boolean") return declared; // explicit config wins
  if (re.test(modelId)) return true;
  return "unknown"; // no declaration + no name hit -> honest unknown
}
