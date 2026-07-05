// SPDX-License-Identifier: Apache-2.0
/**
 * Report-level bounding caps for `obs.explain` (the numeric constants behind
 * {@link boundIncidentReport}). Extracted from `obs-explain-bound.ts` to keep
 * that module under the obs-handlers per-subdirectory file-size cap (the
 * cacheBreaks cap pushed it over) — a pure constants module, no behavior change
 * (the file-size-cap-driven extraction precedent: obs-orchestration-rows.ts,
 * obs-audit-sink.ts).
 *
 * These are DISTINCT from `limitPayloadValue`'s structural `PAYLOAD_BOUNDS` (the
 * 32 KB / 64-item / depth-6 backstop): these are the report-level, depth-aware
 * caps whose drops are recorded in the `truncations[]` ledger.
 *
 * @module
 */

/** summary depth: keep at most this many failures (newest-first; drop oldest). */
export const SUMMARY_MAX_FAILURES = 20;
/**
 * summary depth: keep at most this many breaker-timeline entries (newest-first).
 * A flapping circuit breaker (open/reset/open/reset…) pushes one event per
 * transition with NO upstream dedup in the EVENT shape, so this array is
 * reachable at scale (up to MAX_RECORDS). Capped at the same scale as failures
 * so a worst-case summary report stays comfortably under SUMMARY_MAX_BYTES.
 */
export const SUMMARY_MAX_BREAKER = 20;
/**
 * summary depth: keep at most this many large-result offloads (newest-first).
 * A session that offloads many large bodies pushes one entry per offload (the
 * log shape does NOT dedup), so this array is also reachable at scale.
 */
export const SUMMARY_MAX_OFFLOADS = 20;
/** Per-failure `errorPreview` hard cap (both depths — digest-only is depth-independent). */
export const SUMMARY_MAX_ERROR_PREVIEW_CHARS = 200;
/**
 * The summary hard gate: 6 KB. At the ~4 bytes/token rule of thumb this is the
 * ~1,500-token proxy. There is no `estimateTokens` util, so the serialized byte
 * length of the report is the conservative budget.
 */
export const SUMMARY_MAX_BYTES = 6 * 1024;
/** full depth relaxes the array cap (still digest-only, still per-string-capped). */
export const FULL_MAX_FAILURES = 200;
/**
 * full depth relaxes the breaker-timeline cap (lossless-by-design at full, no
 * byte gate). Still bounded — a pathological multi-thousand-element timeline is
 * trimmed even at full so the report never becomes truly unbounded.
 */
export const FULL_MAX_BREAKER = 200;
/** full depth relaxes the offload cap (analogue of FULL_MAX_FAILURES). */
export const FULL_MAX_OFFLOADS = 200;
/**
 * Any string field longer than this is collapsed to a `fingerprint` digest by
 * the defensive sweep — guarantees no 50 KB tool body survives regardless of
 * upstream. Kept comfortably above the 200-char preview cap so a normal
 * already-capped preview is never re-digested.
 */
export const MAX_INLINE_STRING = 256;
/**
 * cacheBreaks cap: the section is keyed by the closed
 * CacheBreakReason set (~15), so this rarely fires — but it keeps the byte budget
 * airtight and records the drop in `truncations[]`. Relaxed at full depth (the
 * whole closed reason set fits).
 */
export const SUMMARY_MAX_CACHE_BREAKS = 10;
export const FULL_MAX_CACHE_BREAKS = 20;
/**
 * spawnTree cap: an autonomous run mints one lease per
 * spawned child, so `spawnTree` (one node per leaseId) is reachable at scale —
 * a deep fan-out exceeds the structural backstop's 64-item cap and would
 * otherwise be replaced WHOLESALE with a `{__bounded__}` sentinel (schema-invalid
 * → `comis explain` parse throws on exactly the unattended run the tree exists to
 * diagnose). First-N (NOT newest-first): the fold materializes first-seen order,
 * so slicing the HEAD preserves the topology head (root + earliest children).
 * Relaxed at full depth (the whole tree fits, no byte gate).
 */
export const SUMMARY_MAX_SPAWN_NODES = 40;
export const FULL_MAX_SPAWN_NODES = 200;
/**
 * orchestrate cap: a session may run many orchestrate PTC
 * scripts, so `orchestrate` (one entry per run) is reachable at scale — a heavy
 * fan-out exceeds the structural backstop's 64-item cap and would otherwise be
 * replaced WHOLESALE with a `{__bounded__}` sentinel (schema-invalid → the typed
 * `OrchestrateRun[]` slot fails `comis explain` parse on exactly the run-heavy
 * session the section exists to diagnose). First-N (NOT newest-first): the fold
 * materializes first-seen order, so slicing the HEAD preserves the earliest runs.
 * Relaxed at full depth (the whole run set fits, no byte gate). The spawnTree cap
 * precedent (SUMMARY/FULL_MAX_SPAWN_NODES).
 */
export const SUMMARY_MAX_ORCHESTRATE_RUNS = 40;
export const FULL_MAX_ORCHESTRATE_RUNS = 200;
/**
 * toolStats cap. UNLIKE spawnTree/failures (arrays exempt
 * from the structural backstop via REPORT_ARRAY_FIELDS), `toolStats` is a RECORD —
 * so the backstop's plain-object KEY cap applies, and a >64-tool session (a long
 * session touching many tools, or an accumulated multi-workload trajectory) would have its
 * WHOLE toolStats replaced with a `{__bounded__, originalKeyCount}` sentinel whose
 * values are NOT `{ok,failed}` objects → schema-invalid → `comis explain` parse
 * throws/degrades on exactly the heavy session it exists to diagnose. The
 * report-level sweep keeps the top-N tools (failures-first, the diagnostic priority)
 * as proper objects. Both caps stay STRICTLY UNDER `PAYLOAD_BOUNDS.maxObjectKeys`
 * (64) so the backstop never touches toolStats. Relaxed at full depth.
 */
export const SUMMARY_MAX_TOOLSTATS = 30;
export const FULL_MAX_TOOLSTATS = 50;
/** Bound on the progressive-shed loop — never spin forever. */
export const MAX_SHED_ITERATIONS = 8;
/** Short form the shed loop collapses the summary prose to (chars, + ellipsis). */
export const SHED_SUMMARY_CHARS = 80;
