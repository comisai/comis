// SPDX-License-Identifier: Apache-2.0
/**
 * Recall-usage attribution. PURE function — no I/O, no Result, no
 * throws, no clock (AGENTS.md §2.1 pure-fn carve-out; mirrors score.ts /
 * recall-eval.ts). Imports @comis/core types only — the agent↛memory build cut
 * (architecture.test.ts "agent -> memory cut", MEMORY_ALLOWLIST = []).
 *
 * Overlap heuristic: a recalled memory is "used" when its CONTENT shares enough
 * significant overlap with the agent RESPONSE. "Significant" = content-word
 * unigrams (stopwords stripped) PLUS adjacent bigrams carrying at least one
 * non-stopword token — the bigram term cuts the "happens to share a common
 * word" false positive a raw bag-of-words produces, and dropping pure-stopword
 * bigrams ("of and") keeps that noise from sneaking back in.
 * Deterministic: the same (recalled, response) pair
 * always yields the same partition; the fn takes no time/random input.
 *
 * Privacy: this fn reads memory content IN-PROCESS only. It NEVER logs, emits,
 * or returns content — its output is opaque memory IDS partitioned into
 * {used, ignored}. The caller (executor-post-execution.ts) puts ids+counts on
 * the bus; content never leaves the agent boundary.
 *
 * Scoring (per recalled memory):
 *   overlap = |memSignificantUnigrams ∩ respTokens| + |memSignificantBigrams ∩ respBigrams|
 *   denom   = |memSignificantUnigrams| + |memSignificantBigrams|
 *   score   = denom === 0 ? 0 : overlap / denom        // guard zero denominator
 *   score >= minOverlap (default 0.15) → used, else ignored.
 *
 * Edge cases (pinned in recall-attribution.test.ts):
 *   - empty recalled            → { usedIds: [], ignoredIds: [] }
 *   - empty/whitespace response → every id ignored (overlap 0)
 *   - content fully echoed      → used
 *   - stopword-only overlap     → ignored (significant terms absent from response)
 *
 * @module
 */

/** The partition produced by {@link attributeRecallUsage}: opaque ids only. */
export interface RecallAttribution {
  /** Memory ids attributed as USED in the agent's response. */
  usedIds: string[];
  /** Memory ids recalled but NOT used. */
  ignoredIds: string[];
}

/**
 * Small inline stopword set. Kept deliberately tiny (the most frequent English
 * function words) — the goal is to drop terms that carry no attribution signal,
 * not to do full linguistic stemming. This follows the heuristic-design
 * principle of dropping a small stopword set and preferring content-word +
 * bigram overlap over raw bag-of-words.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "the", "a", "an", "of", "and", "to", "in", "is", "it", "for", "on", "with",
  "that", "this", "as", "at", "by", "be", "or", "are",
]);

/** Default overlap fraction at/above which a memory counts as "used". */
const DEFAULT_MIN_OVERLAP = 0.15;

/**
 * A token written entirely in Latin letters/digits. The STOPWORDS set is an
 * English (Latin-script) function-word list; it must only ever drop Latin
 * tokens. A non-Latin token whose lowercased form happens to transliterate near
 * an English stopword — or any Hebrew/Arabic/Cyrillic/CJK token — is NEVER a
 * stopword. Verbatim from `@comis/memory` buildFtsQuery (the proven in-repo
 * Latin-gating pattern), kept inline so this file stays pure (no @comis/memory
 * import; the agent↛memory build cut, architecture.test.ts "agent -> memory cut").
 */
const LATIN_TOKEN = /^[\p{Script=Latin}\p{N}]+$/u;

/** True iff `t` is a Latin-script token that is in the English STOPWORDS set. */
function isStopword(t: string): boolean {
  return LATIN_TOKEN.test(t) && STOPWORDS.has(t);
}

/**
 * Lowercase, split on any run of non-(letter|number) codepoints, and keep
 * non-empty tokens. Unicode-aware: `\p{L}` matches Hebrew/Arabic/Cyrillic/CJK
 * letters (not just `a-z`), so a non-Latin memory and an overlapping non-Latin
 * response tokenize to real terms instead of collapsing to nothing (OBS-01
 * de-Anglicization — the prior ASCII-only character class stripped every
 * non-ASCII letter, forcing non-Latin attribution permanently to 0). Diacritic-Latin
 * tokens (`café`) now survive whole — intentional; the I1 byte-identity pin is
 * pure-ASCII, which this split leaves unchanged. Deterministic and
 * allocation-bounded by the input length; a single split on a fixed char-class
 * with the `u` flag — no nested quantifiers, no backtracking surface (no ReDoS).
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

/**
 * Adjacent-token bigrams ("a b" form) that carry at least one SIGNIFICANT
 * (non-stopword) token. Pure-stopword bigrams (e.g. "of and") are dropped —
 * they carry no attribution signal and would reintroduce the very
 * "shared common word" false positive the bigram axis exists to cut. Empty for
 * <2 tokens or when every adjacent pair is stopword-only. The stopword test is
 * Latin-gated (`isStopword`) so a non-Latin bigram is never dropped as
 * "pure-stopword" — a two-word Hebrew/Arabic/Cyrillic phrase always yields a
 * bigram (OBS-01).
 */
function significantBigrams(tokens: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < tokens.length; i++) {
    const a = tokens[i]!;
    const b = tokens[i + 1]!;
    if (isStopword(a) && isStopword(b)) continue;
    out.push(`${a} ${b}`);
  }
  return out;
}

/**
 * Partition recalled memories into {used, ignored} via the overlap heuristic.
 *
 * @param recalled - the recalled memories (id + content), in-process only.
 * @param response - the agent's final response text for this turn.
 * @param opts.minOverlap - fraction (0..1) at/above which a memory is "used"
 *   (default 0.15). Higher = stricter (fewer used).
 */
export function attributeRecallUsage(
  recalled: ReadonlyArray<{ id: string; content: string }>,
  response: string,
  opts?: { minOverlap?: number },
): RecallAttribution {
  const usedIds: string[] = [];
  const ignoredIds: string[] = [];
  if (recalled.length === 0) return { usedIds, ignoredIds };

  const minOverlap = opts?.minOverlap ?? DEFAULT_MIN_OVERLAP;

  // Build the response token + bigram sets ONCE (shared across all memories).
  const respTokens = tokenize(response);
  const respTokenSet = new Set(respTokens);
  const respBigramSet = new Set(significantBigrams(respTokens));

  for (const mem of recalled) {
    const memTokens = tokenize(mem.content);
    // Significant unigrams: content words not in the stopword set. The stopword
    // filter is Latin-gated (isStopword) — a non-Latin token is always
    // significant (OBS-01: never dropped by the English STOPWORDS set).
    const memSignificant = memTokens.filter((t) => !isStopword(t));
    const memSignificantSet = new Set(memSignificant);
    // Bigrams preserve phrase structure but drop pure-stopword pairs (so a
    // phrase like "of and" cannot manufacture a false "used"); a bigram with at
    // least one significant token is kept.
    const memBigramSet = new Set(significantBigrams(memTokens));

    const denom = memSignificantSet.size + memBigramSet.size;
    if (denom === 0) {
      // No significant terms (e.g. content is all stopwords/punctuation) — no
      // attribution signal possible → ignored (never a false "used").
      ignoredIds.push(mem.id);
      continue;
    }

    let overlap = 0;
    for (const t of memSignificantSet) if (respTokenSet.has(t)) overlap++;
    for (const b of memBigramSet) if (respBigramSet.has(b)) overlap++;

    const scoreFrac = overlap / denom;
    if (scoreFrac >= minOverlap) usedIds.push(mem.id);
    else ignoredIds.push(mem.id);
  }

  return { usedIds, ignoredIds };
}
