// SPDX-License-Identifier: Apache-2.0
/**
 * LLM-free query understanding (IQ-02 + IQ-03) — pure, deterministic helpers over the query
 * STRING. All exports are PURE (no `Result`, no throw, no I/O, no clock, no globals — the
 * rag/score.ts pure-ranking carve-out): a malformed input returns a safe value (the default
 * intent / a 1.0 multiplier / the unchanged string / `undefined`), NEVER an exception.
 *
 * NO LLM, NO network: intent is keyword/shape heuristics, synonym expansion is a bounded static
 * map, and the temporal grammar is a hand-rolled regex + epoch arithmetic (no date library —
 * `@comis/agent` has none, and adding one violates the CLAUDE.md exact-pin supply-chain invariant).
 *
 * @module
 */

/**
 * The CLOSED set of query intents. Default / unmatched = `"factual"` (a plain lookup). A new
 * member fails the build at the {@link intentMultiplier} switch's exhaustive default until it is
 * handled explicitly (the score.ts `trustWeight` closed-union precedent, AGENTS.md §2.8).
 */
export type Intent = "factual" | "temporal" | "preference" | "enumeration";

/** The CLOSED set of reweightable recall lanes (the IQ-02 reweight surface). */
export type ReweightLane = "fts" | "vector" | "entity" | "temporal" | "causal" | "graphSpread";

/**
 * Lowercase + Unicode-aware tokenize (the buildFtsQuery shape, hybrid-search.ts:81-106:
 * strip double-quotes, split on non-letter/non-number). Replicated agent-side — this is
 * pure string work and MUST NOT import from `@comis/memory` (the agent↛memory cut).
 */
function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/"/g, "") // FTS5-injection-safe shape (no special chars carried)
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

// Single-token marker sets per family (matched against the tokenized query).
const TEMPORAL_TOKENS = new Set([
  "when",
  "yesterday",
  "today",
  "tonight",
  "since",
  "ago",
  "recently",
  "earlier",
  "before",
  "after",
]);
const PREFERENCE_TOKENS = new Set([
  "prefer",
  "prefers",
  "preferred",
  "preference",
  "like",
  "likes",
  "liked",
  "favorite",
  "favourite",
  "favorites",
  "favourites",
]);
const ENUMERATION_TOKENS = new Set(["list", "all", "every", "everything", "each", "count"]);

// Multi-word / pattern markers matched against the lowercased raw string.
const TEMPORAL_PHRASE_RE = /\b(last|this|next|past)\s+(week|month|year|day|night|quarter|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/;
const TEMPORAL_LAST_N_RE = /\blast\s+\d+\s+(day|days|week|weeks|month|months|year|years)\b/;
const YEAR_TOKEN_RE = /\b(19|20)\d{2}\b/; // a 4-digit year token like 2023 → a temporal signal
const ENUMERATION_PHRASE_RE = /\bhow\s+many\b/;

/**
 * Classify a query into the closed {@link Intent} union by DETERMINISTIC keyword/shape
 * heuristics — NO LLM. Marker families are checked in a DOCUMENTED precedence so a query that
 * matches several is classified once, always the same:
 *
 *   temporal  >  enumeration  >  preference  >  factual (default)
 *
 * Temporal wins first (the NL range parse it enables — 102-04 — is the most specific signal);
 * enumeration next (it widens recall + favors MMR diversity); preference next (entity up-weight);
 * a plain lookup with no marker falls through to `"factual"`. Pure + total — an empty/garbage
 * query simply matches nothing → `"factual"` (never throws).
 */
export function classifyIntent(query: string): Intent {
  const lower = query.toLowerCase();
  const tokens = tokenize(query);

  const hasTemporal =
    tokens.some((t) => TEMPORAL_TOKENS.has(t)) ||
    YEAR_TOKEN_RE.test(lower) ||
    TEMPORAL_PHRASE_RE.test(lower) ||
    TEMPORAL_LAST_N_RE.test(lower);
  if (hasTemporal) return "temporal";

  const hasEnumeration =
    tokens.some((t) => ENUMERATION_TOKENS.has(t)) || ENUMERATION_PHRASE_RE.test(lower);
  if (hasEnumeration) return "enumeration";

  const hasPreference = tokens.some((t) => PREFERENCE_TOKENS.has(t));
  if (hasPreference) return "preference";

  return "factual";
}

/**
 * The modest per-(intent, lane) up-weight. Kept small (1.5 ≤ 2.0) so the reweight COMPOSES with
 * the existing lane weights without overpowering trust-first ordering (a lane boost can lift a
 * lane's contribution but never overturn the trust ladder, which is a hard filter upstream).
 */
const TARGETED_BOOST = 1.5;

/**
 * Per-intent lane reweight multiplier (IQ-02). Returns exactly `1.0` (byte-identity) for the
 * `"factual"` intent on every lane AND for any (intent, lane) pair with no documented boost;
 * a documented `TARGETED_BOOST` (>1.0) on the targeted lane(s):
 *
 *   - `temporal`    → up-weights the `temporal` lane (recency/event-time evidence matters most).
 *   - `preference`  → up-weights the `entity` lane (preferences are entity-associative — the
 *                     person↔preference links the entity lane surfaces).
 *   - `enumeration` → NEUTRAL on every lane: enumeration's payoff is DIVERSITY, which is handled
 *                     by the MMR-λ knob in 102-04, NOT a lane weight (documented design fork).
 *   - `factual`     → NEUTRAL everywhere (the default-lookup byte-identity case).
 *
 * The switch over the closed {@link Intent} union carries an exhaustive `const _exhaustive: never`
 * default (score.ts `trustWeight` precedent, AGENTS.md §2.8) so a NEW intent fails the build here
 * until its reweight is decided explicitly — it can never silently fall through to 1.0.
 */
export function intentMultiplier(intent: Intent, lane: ReweightLane): number {
  switch (intent) {
    case "temporal":
      return lane === "temporal" ? TARGETED_BOOST : 1.0;
    case "preference":
      return lane === "entity" ? TARGETED_BOOST : 1.0;
    case "enumeration":
      return 1.0; // diversity via MMR-λ (102-04), not a lane weight
    case "factual":
      return 1.0; // default lookup → byte-identity on every lane
    default: {
      const _exhaustive: never = intent;
      return _exhaustive;
    }
  }
}

/**
 * RED stub (102-02 Task 3). Replaced in the GREEN commit. Returns the query unchanged so the
 * mapped-term expansion assertions fail on the unimplemented function.
 */
export function expandSynonyms(query: string): string {
  return query;
}

/**
 * RED stub (102-02 Task 3). Replaced in the GREEN commit. Returns `undefined` for ALL inputs so
 * the positive-range assertions fail on the unimplemented function.
 */
export function parseTemporalRange(
  _query: string,
  _nowMs: number,
): { start: number; end: number } | undefined {
  return undefined;
}
