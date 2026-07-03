// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";
import type { MemorySearchResult } from "./memory.js";
import type { LearningScope } from "./outcome-signal-port.js";

/**
 * TripleStorePort: the SEGREGATED hexagonal boundary for the trust-first
 * bi-temporal knowledge graph. A triple is an
 * S/P/O assertion carrying four bi-temporal timestamps + an occurred range + a
 * trust level; the store keeps a non-destructive history (many superseded
 * versions of a (subject, predicate) coexist) and a single CURRENT truth per
 * (tenant, agent, subject, predicate).
 *
 * Like MemoryCausalStore / MemoryEntityStore /
 * MemoryTemporalStore, this port deliberately does NOT widen the security-reviewed
 * `MemoryPort` (store/search/delete). New capabilities arrive as their own
 * segregated port. The sole adapter is in @comis/memory (it owns the `db` handle
 * and runs all SQL over the additive `memory_triples` table); the agent-side
 * write path (the offline triple-extraction job) and read path (memory-recall's
 * graph-spread lane + the temporal-guidance consumer) consume this port TYPE
 * from @comis/core — they cannot import @comis/memory (the agent↛memory build
 * cut). No new authority is granted beyond write/read within the caller's own
 * (tenant, agent) scope.
 *
 * It carries the WRITE (`upsertTriple`), the as-of READ (`asOf`), and the
 * graph-spread lane READ (`spreadLane`) — the dual write+read shape of
 * MemoryCausalStore / MemoryEntityStore (NOT a split read/write port).
 *
 * This file is type-only (mirrors memory-causal-store.ts / memory-temporal-store.ts):
 * no zod, no @comis/memory import.
 */

/**
 * The isolation boundary for every triple operation (the entity-scoping
 * pattern). Every adapter statement — INSERT, UPDATE, SELECT, AND the
 * recursive-CTE walk's JOIN — filters on `(tenantId, agentId)`. This is a
 * load-bearing SECURITY scope in a multi-agent DB, not a nicety: a triple
 * written under one (tenant, agent) must NEVER be returned for another scope by
 * subject/object-string coincidence.
 *
 * UNIFIED onto the canonical {@link LearningScope} — the isolation
 * fields are NOT re-declared (avoiding a per-port repetition of the same pair).
 * A thin alias that DERIVES `tenantId`/`agentId` from `LearningScope` and
 * re-narrows the injected clock `now` to REQUIRED (the `upsertTriple` write
 * path). The KG recall lane (`spreadLane`, the live graphSpread consumer) reads
 * via `Omit<TripleScope, "now">` — unaffected by the narrowing.
 */
export type TripleScope = LearningScope & {
  /**
   * Injected wall-clock epoch milliseconds for the write's bookkeeping
   * (`t_ingested`, and the soft-close `t_valid_end`/`expired_at` stamps when an
   * incumbent is invalidated). REQUIRED on the triple write path. NEVER
   * `Date.now()` — the caller supplies it from an injected clock so the write
   * path stays deterministic/testable. The row's VALID-time start comes from
   * `TripleInput.tValidStart`, not this clock.
   */
  now: number;
};

/**
 * The Comis trust ladder, reused verbatim (the `memories.trust_level` CHECK set
 * and the `score.ts` trustWeight order: system 1.0 > learned 0.5 > external
 * 0.0). The invalidation comparison ranks on exactly this ladder — trust
 * is a HARD boundary there, never a soft weight.
 */
export type TripleTrust = "system" | "learned" | "external";

/**
 * A bi-temporal S/P/O assertion to write. Subject/predicate/object are
 * conversation-derived (untrusted) text — DATA, never SQL; the adapter binds
 * every value as a `?` parameter.
 */
export interface TripleInput {
  /** The triple subject (an entity / topic key). */
  subject: string;
  /** The triple predicate (the relation). */
  predicate: string;
  /** The triple object (the value / counterpart). */
  object: string;
  /** Trust on the Comis ladder — drives the trust-first invalidation. */
  trust: TripleTrust;
  /** Valid-time start: epoch ms when the fact became true in the world. */
  tValidStart: number;
  /** Occurred range start: epoch ms when it happened in the world (optional). */
  tOccurred?: number;
  /** Occurred range end: epoch ms (optional; absent = point/unknown). */
  tOccurredEnd?: number;
  /** Provenance: the originating memory id (ON DELETE CASCADE in the table). */
  sourceMemoryId?: string;
  /** Optional corroboration confidence in 0..1. */
  confidence?: number;
}

export interface TripleStorePort {
  /**
   * WRITE PATH. Upsert an S/P/O assertion with trust-first
   * single-current-truth invalidation: a contradiction (same tenant+agent+
   * subject+predicate, DIFFERENT object, incumbent current-truth) soft-closes the
   * LOWER-trust row (`t_valid_end`/`expired_at` set); equal-trust ties break by
   * recency (newer current-truth, older soft-closed); a newer LOWER-trust claim
   * NEVER supersedes an older higher-trust fact (it is recorded-but-not-believed
   * and surfaced as a conflict). NEVER deletes — raw facts are retained for as-of
   * history. Deterministic, one synchronous transaction.
   *
   * NOTE (skeleton): this first cut is INSERT-ONLY (always writes a
   * current-truth row, no contradiction handling). The trust-first invalidation
   * transaction is implemented in a later cut.
   */
  upsertTriple(triple: TripleInput, scope: TripleScope): Promise<Result<void, Error>>;

  /**
   * READ PATH. As-of time-travel in TWO temporal axes (the
   * bi-temporal pair). `mode` selects which clock the instant `t` indexes; both
   * are scoped to (tenant, agent) and hydrate the rows back as `TripleInput`:
   *
   * - `"valid"` (DEFAULT) — VALID-TIME: "what was BELIEVED true at instant `t`":
   *   `t_valid_start <= t AND (t_valid_end IS NULL OR t_valid_end > t)`. (A 2-arg
   *   call is byte-identical to the original valid-time behaviour — the valid-time
   *   callers are unbroken.)
   * - `"txn"` — TXN/RECORD-TIME: "what the system had RECORDED as of `t`":
   *   `t_ingested <= t AND (expired_at IS NULL OR expired_at > t)`. Answers a
   *   different question than valid-time whenever a fact's valid-time start
   *   diverges from when it was ingested (e.g. a back-dated fact, or one whose
   *   validity begins in the future) — the two clauses query DIFFERENT column
   *   pairs (`t_valid_start`/`t_valid_end` vs `t_ingested`/`expired_at`).
   *
   * The default CURRENT-TRUTH recall read is {@link currentTruth} (`t_valid_end
   * IS NULL`), NOT an `asOf` of "now"; an explicit `asOf(t)` time-travels.
   */
  asOf(
    t: number,
    scope: Omit<TripleScope, "now">,
    mode?: "valid" | "txn",
  ): Promise<Result<TripleInput[], Error>>;

  /**
   * READ PATH. The DEFAULT-RECALL current-truth read: only the rows
   * believed NOW — `t_valid_end IS NULL` — scoped to (tenant, agent), capped by
   * `cap` (a sane default bound). This DEFAULT-FILTERS expired/invalidated edges
   * (superseded losers AND recorded-but-not-believed rows, which the write
   * path soft-closes / records already-closed) OUT of normal recall — the fix for
   * Graphiti's opt-in-filter stale-fact leak, where the default search path
   * leaks expired edges unless a filter is explicitly requested. As-of history is
   * reachable ONLY via an explicit {@link asOf} call. Returns the rows hydrated
   * as `TripleInput`.
   */
  currentTruth(
    scope: Omit<TripleScope, "now">,
    cap?: number,
  ): Promise<Result<TripleInput[], Error>>;

  /**
   * READ PATH. Bounded recursive-CTE neighbourhood spread from the seed
   * subjects over current-truth forward edges (subject → object,
   * `t_valid_end IS NULL`), scoped to (tenant, agent), hydrated as
   * `MemorySearchResult[]` so it fuses directly into the existing weighted RRF.
   * `maxDepth` caps the hop count, `fanOut` caps per-node expansion, `cap` bounds
   * the returned row count — together keeping it O(bounded) on-device, LLM-free.
   * Returns an empty array when there are no seeds or no edges (the no-op that
   * leaves RRF ranking byte-identical).
   *
   * NOTE (skeleton): this first cut returns `[]`. The bounded
   * recursive-CTE spread is implemented in a later cut.
   */
  spreadLane(
    seedSubjects: string[],
    scope: Omit<TripleScope, "now">,
    maxDepth: number,
    fanOut: number,
    cap: number,
  ): Promise<Result<MemorySearchResult[], Error>>;
}
