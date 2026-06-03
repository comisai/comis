// SPDX-License-Identifier: Apache-2.0
/**
 * Pure gold-map builder (the gold-mapping half).
 *
 * Resolves the loader's dataset gold-evidence refs (LongMemEval session ids,
 * LoCoMo dia_ids) through the ingested-id side-map into the
 * `questionId -> Set<MemoryEntry.id>` shape the recall scorer needs as an
 * EvalQuery's `relevantIds`.
 *
 * THE KEY INSIGHT: the harness assigns a `randomUUID()` per
 * ingested document and records `datasetRef -> uuid` in `ingestedIdByRef` at
 * `store()` time. `buildGoldMap` is the pure resolver that turns the loader's
 * `datasetRef`-keyed gold into the `MemoryEntry.id`-keyed gold. The dataset ref
 * is the side-map KEY only — it is NEVER used as an id
 * (`MemoryEntry.id = z.guid()`, memory-entry.ts:33 — a ref like "D1:5" or "s1"
 * is not a valid id).
 *
 * PURE, types-only. Imports NOTHING (no package imports, no runtime deps) — the
 * agent->memory architecture cut (architecture-graph.test.ts:133) FORBIDS any
 * import of the memory package here. Mirrors the pure-reducer discipline of
 * rag/recall-record.ts. A total pure function: no I/O -> no Result needed; an
 * empty input yields an empty map and it never throws.
 *
 * @module
 */

/**
 * Build `questionId -> Set<MemoryEntry.id>` from gold refs + the ingested-id
 * side-map.
 *
 * For each question, map each gold REF through `ingestedIdByRef` and collect the
 * resolved UUIDs into a `Set<string>`. Refs absent from the side-map (e.g.
 * evidence pointing at an un-ingested session) are silently SKIPPED — no
 * `undefined` enters the set. Multiple refs resolving to the same uuid collapse
 * via the Set (no duplicates). The dataset ref is the side-map key only, never a
 * value in the result.
 *
 * @param goldRefsByQuestion questionId -> set of dataset gold-evidence refs.
 * @param ingestedIdByRef     dataset ref -> the ingested document's MemoryEntry.id (UUID).
 * @returns questionId -> set of resolved MemoryEntry.id (the scorer's relevantIds).
 */
export function buildGoldMap(
  goldRefsByQuestion: Map<string, Set<string>>,
  ingestedIdByRef: Map<string, string>,
): Map<string, Set<string>> {
  const goldMap = new Map<string, Set<string>>();
  for (const [questionId, refs] of goldRefsByQuestion) {
    const resolved = new Set<string>();
    for (const ref of refs) {
      const id = ingestedIdByRef.get(ref);
      if (id !== undefined) {
        resolved.add(id);
      }
    }
    goldMap.set(questionId, resolved);
  }
  return goldMap;
}
