// SPDX-License-Identifier: Apache-2.0
/**
 * The PURE dialectic synthesis helpers.
 *
 * The genuinely-new synthesis logic, isolated as side-effect-free functions so the
 * trust-first contradiction ordering, the mandatory abstention, and the
 * citation→recalled-id→sourceId mapping are RED-provable at $0 (no daemon, no DB, no
 * model). The query-time LLM lives ONLY in `memory-dialectic-seam.ts`; these helpers
 * never call it.
 *
 * Three invariants, each a trust-boundary mitigation:
 * - TRUST-FIRST is a HARD boundary ({@link orderByTrust}). The `system>learned>external`
 *   ladder (the same `TRUST_RANK` reused verbatim from `memory-triple-extraction-job.ts:58`
 *   / `triple-store.ts:55-61`) orders the recall survivors; the higher-trust claim is
 *   presented first and a lower-trust contradiction never blends into the answer. Trust is
 *   read from `entry.trustLevel` in CODE — NEVER from anything the model emitted.
 * - ABSTENTION is decided in CODE ({@link abstainIfInsufficient}), not left to
 *   the prompt: an empty recall set, a parser that abstained, or a parsed result whose
 *   citations do not intersect the recalled ids ⇒ abstain. The function is a pure predicate
 *   over the recall set + the parsed result — it does NOT call the seam.
 * - CITATIONS are validated ⊆ recalled ids ({@link mapCitationsToSourceIds}): a
 *   hallucinated/forged id the model emits is DROPPED; each surviving citation is traversed
 *   to its `sourceIds` (the reasoning-tree provenance chain).
 *
 * Architecture: agent-side, `@comis/core` port TYPES only (`MemorySearchResult`,
 * `TrustLevel`). No memory-package import, no clock, no IO, no model (the agent↛memory cut
 * holds — the synthesis files depend on core port types alone).
 *
 * @module
 */

import type { MemorySearchResult, TrustLevel } from "@comis/core";

// ---------------------------------------------------------------------------
// The trust ladder (reused VERBATIM — not a per-feature reinvention)
// ---------------------------------------------------------------------------

/**
 * The trust ladder rank, reused verbatim from the extraction job / `triple-store.ts:55-61`
 * (`system` 2 > `learned` 1 > `external` 0). Trust is a HARD boundary: higher-trust wins,
 * the lower-trust contradiction is NOT blended.
 */
const TRUST_RANK: Record<TrustLevel, number> = { system: 2, learned: 1, external: 0 } as const;

// ---------------------------------------------------------------------------
// The parsed-synthesis shape these helpers reason over
// ---------------------------------------------------------------------------

/**
 * The parsed synthesis result the abstention predicate + the assembler consume — the
 * `parseDialecticOutput` output (a discriminated union: an explicit abstain, or a grounded
 * answer + the cited ids). Re-declared here as the helpers' input contract so this module
 * stays dependency-free of the prompt/parser at the type level (the prompt module exports
 * the canonical `DialecticParsed`; this is structurally identical).
 */
export type ParsedSynthesis =
  | { abstain: true }
  | { abstain: false; answer: string; citedIds: string[] };

/** The reasoning-tree chain: a validated citation id and the sourceIds it traverses to. */
export interface CitationChain {
  /** The recalled memory id the model cited (validated ⊆ the recalled ids). */
  citationId: string;
  /** The cited entry's `sourceIds` — the reasoning-tree provenance (empty when absent). */
  sourceIds: string[];
}

/** The assembled synthesis result (the `memory.ask` RPC response shape, minus the trace). */
export interface AssembledSynthesis {
  answer: string;
  citations: string[];
  abstained: boolean;
}

// ---------------------------------------------------------------------------
// 1. Trust-first contradiction ordering
// ---------------------------------------------------------------------------

/**
 * STABLE-sort recall items by `TRUST_RANK[entry.trustLevel]` DESC (ties preserving the
 * input / recall order). Trust is read from `entry.trustLevel` ONLY — never from any other
 * field — so a model-asserted or smuggled top-level trust can never change the order.
 *
 * Trust is a HARD boundary (`triple-store.ts:55-61`): the higher-trust claim is presented
 * first and the lower-trust contradiction is NOT blended. The recall pipeline already
 * trust-FILTERED the survivors (`memory-recall.ts:521-523`); this ORDERS them — it does not
 * re-filter.
 */
export function orderByTrust(items: MemorySearchResult[]): MemorySearchResult[] {
  // Decorate-sort-undecorate keeps the sort STABLE across engines: ties break on the
  // original recall index, so same-trust items preserve their recall order.
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const byTrust = TRUST_RANK[b.item.entry.trustLevel] - TRUST_RANK[a.item.entry.trustLevel];
      return byTrust !== 0 ? byTrust : a.index - b.index;
    })
    .map(({ item }) => item);
}

// ---------------------------------------------------------------------------
// 2. Mandatory abstention, decided in CODE (never left to the prompt)
// ---------------------------------------------------------------------------

/** The set of recalled ids — the citation-validation domain. */
function recalledIdSet(recalled: MemorySearchResult[]): Set<string> {
  return new Set(recalled.map((r) => r.entry.id));
}

/**
 * Decide abstention in CODE (never left to the prompt). Returns `{ abstain: true }`
 * when ANY of:
 * - the recall set is empty (no grounding at all), OR
 * - the parser itself abstained, OR
 * - after intersecting the parsed `citedIds` with the recalled id set, NO citation survives
 *   (the answer is not grounded in anything the recall actually returned).
 *
 * A pure predicate over the recall set + the parsed result — it does NOT call the seam.
 */
export function abstainIfInsufficient(
  recalled: MemorySearchResult[],
  parsed: ParsedSynthesis,
): { abstain: boolean } {
  if (recalled.length === 0) return { abstain: true };
  if (parsed.abstain) return { abstain: true };
  const ids = recalledIdSet(recalled);
  const hasValidatedCitation = parsed.citedIds.some((id) => ids.has(id));
  return { abstain: !hasValidatedCitation };
}

// ---------------------------------------------------------------------------
// 3. Citation → recalled-id → sourceId mapping (citations-are-ids)
// ---------------------------------------------------------------------------

/**
 * Validate citations ⊆ recalled ids, then traverse each survivor to its `sourceIds` (the
 * reasoning-tree chain). A model-emitted id that is NOT in the recalled set is
 * DROPPED (a hallucinated/forged citation can never enter the answer). An entry
 * with no `sourceIds` yields an empty chain.
 */
export function mapCitationsToSourceIds(
  recalled: MemorySearchResult[],
  citedIds: string[],
): CitationChain[] {
  const byId = new Map(recalled.map((r) => [r.entry.id, r.entry] as const));
  const chains: CitationChain[] = [];
  for (const citationId of citedIds) {
    const entry = byId.get(citationId);
    if (entry === undefined) continue; // bogus id — drop (never enters the answer)
    chains.push({ citationId, sourceIds: entry.sourceIds ?? [] });
  }
  return chains;
}

/**
 * The full validated citation→sourceId chain for the recall-trace. A thin alias
 * over {@link mapCitationsToSourceIds} so the daemon can surface the reasoning tree in the
 * recall-trace without re-deriving it from the assembled answer.
 */
export function citationChains(
  recalled: MemorySearchResult[],
  citedIds: string[],
): CitationChain[] {
  return mapCitationsToSourceIds(recalled, citedIds);
}

// ---------------------------------------------------------------------------
// Composed assembler (consumed by the `memory.ask` RPC handler)
// ---------------------------------------------------------------------------

/**
 * Tie the three helpers together into the `memory.ask` response. If
 * {@link abstainIfInsufficient} fires ⇒ the abstain sentinel `{ answer: "", citations: [],
 * abstained: true }` (the synthesis seam is NOT consulted here — that decision was already
 * made before any LLM call when the recall set was empty, and is re-checked here against the
 * parsed result). Otherwise the recalled set is ordered trust-first and the citations are the
 * VALIDATED recalled ids (the bogus ones dropped). The full sourceId CHAIN is returned
 * separately via {@link citationChains} for the recall-trace.
 */
export function assembleSynthesis(
  recalled: MemorySearchResult[],
  parsed: ParsedSynthesis,
): AssembledSynthesis {
  if (abstainIfInsufficient(recalled, parsed).abstain) {
    return { answer: "", citations: [], abstained: true };
  }
  // parsed is the grounded variant here (abstain:false) — the predicate above already
  // returned for every abstain case.
  const grounded = parsed as { abstain: false; answer: string; citedIds: string[] };
  const ordered = orderByTrust(recalled);
  const citations = mapCitationsToSourceIds(ordered, grounded.citedIds).map((c) => c.citationId);
  return { answer: grounded.answer, citations, abstained: false };
}
