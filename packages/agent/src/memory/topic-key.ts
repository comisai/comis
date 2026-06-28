// SPDX-License-Identifier: Apache-2.0
/**
 * `normalizeOpeningRequest` (Phase 223, D-01 / REFLECT-02) — the deterministic,
 * keyless, **content-light** `topicKey` that REPLACES embedding-cosine clustering.
 *
 * This is the milestone's concentrated risk (the failure mode the dead embedding-cosine
 * clustering had, re-lived from the other direction): the reflection job groups successful
 * outcomes by this key, so two genuinely same-topic sessions worded DIFFERENTLY MUST collide
 * on one key — else corroboration never reaches the >=2 distinct (session,sender) gate and
 * `admitted:0` persists forever. The collision-maximizing decision is the order-insensitive
 * token SET (see below).
 *
 * The pipeline:
 *  1. STRIP the volatile per-turn envelope FIRST — the executor wraps every inbound
 *     turn as `[System context]\n<preamble incl. a VOLATILE timestamp>\n[End system
 *     context]\n\n[<channel>] <id> (<time>): <message>`; both the preamble AND the
 *     channel header carry a per-turn timestamp, so two IDENTICAL requests differ in
 *     raw form (raw-text clustering failed live 2026-06-25). {@link stripUserSystemContext}
 *     recovers the stable request.
 *  2. LOWERCASE, collapse every non-alphanumeric run to a single space, trim.
 *  3. TOKENIZE on whitespace; drop {@link STOPWORDS} and tokens of length <= 1.
 *  4. DE-DUPLICATE into a Set, then SORT — order-insensitive. "deploy the app" and
 *     "app deploy please" carry the same {app,deploy} token set and collide; a
 *     token-SEQUENCE/string hash would NOT (RESEARCH Alternative + Pitfall 3 + A1).
 *  5. HASH the sorted-unique join with sha256 (the repo's deterministic-id convention,
 *     mirroring `sqlite-mental-model-store.ts:mentalModelId`) and return the hex —
 *     content-light, NEVER the raw transcript (INV-6). An empty token list returns ""
 *     (the reflection job treats "" as ungroupable — a singleton that never corroborates).
 *
 * Pure: no IO, no embedder, no clock/random. The sole consumer is the reflection job
 * in THIS package (`./topic-key.js` relative import) — no public-barrel export needed.
 *
 * @module
 */

import { createHash } from "node:crypto";

/**
 * A small, deliberately conservative English stopword set. Kept tight on purpose:
 * over-stripping content words would over-merge unrelated topics, while these
 * function words (articles, fillers, pronouns, copulas) carry no topic signal and
 * vary freely between two phrasings of the same request. Includes the polite
 * fillers ("please", "can", "could", "would") that pad chat-channel requests.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "the",
  "a",
  "an",
  "to",
  "of",
  "for",
  "and",
  "or",
  "please",
  "can",
  "could",
  "would",
  "you",
  "i",
  "my",
  "our",
  "this",
  "that",
  "is",
  "are",
  "be",
  "do",
  // Generic function/filler words that carry NO topic signal but leak into the lexical
  // intersection when corroborating sources share framing — they DILUTE the behavioral
  // core and depress reuse-coverage (a real threat-hunting TTP core was observed ~50% such
  // filler). Dropping them sharpens the topicKey for BOTH corroboration-grouping and the
  // reuse topic-match without over-merging (function words, not content — same rationale as above).
  "it",
  "with",
  "then",
  "them",
  "these",
  "those",
  "on",
  "not",
  "will",
]);

/**
 * Recover the RAW user request from a stored inbound message by stripping the
 * executor's injected envelope. LIFTED verbatim (Phase 223 D-07) from
 * `setup-channels-skill-synthesis-deps.ts` (`stripUserSystemContext`) — that deps
 * file's embedding wiring is deleted in Plan 05, but this envelope-strip is the
 * correct PRE-STEP for the topicKey (Pitfall 3), so it is copied here as a private
 * helper. The executor wraps every inbound turn as
 * `[System context]\n<preamble incl. a VOLATILE timestamp>\n[End system context]\n\n[<channel>] <id> (<time>):\n<actual message>`
 * (envelope-wrapper.ts). Both the system-context preamble AND the channel header
 * carry a per-turn timestamp, so the stored "user message" of two IDENTICAL requests
 * DIFFERS — which is why raw user-message clustering failed live (2026-06-25). If the
 * envelope format in envelope-wrapper.ts changes, update this copy.
 */
function stripUserSystemContext(text: string): string {
  if (!text.includes("[System context]") && !text.includes("[End system context]")) return text;
  const endMarker = "[End system context]";
  const endIdx = text.lastIndexOf(endMarker);
  if (endIdx === -1) return text;
  const afterContext = text.slice(endIdx + endMarker.length);
  // Strip the channel header `[telegram] 678314278 (9:34 AM):` — its time is volatile.
  const channelHeaderMatch = afterContext.match(/\s*\[[\w-]+\]\s+\S+\s+\([^)]*\):\s*/);
  if (channelHeaderMatch) {
    const msgStart = afterContext.indexOf(channelHeaderMatch[0]) + channelHeaderMatch[0].length;
    return afterContext.slice(msgStart).trim();
  }
  return afterContext.trim();
}

/**
 * Compute the deterministic, content-light `topicKey` for a session's opening
 * request signature. See the module docblock for the full pipeline + rationale.
 *
 * @param signature - the session's opening user-role request text (may still carry
 *   the executor envelope; it is stripped here).
 * @returns a 64-char lowercase sha256 hex of the sorted, de-duplicated content
 *   tokens, or `""` when no content tokens survive (ungroupable).
 */
export function normalizeOpeningRequest(signature: string): string {
  // The sorted-unique content tokens (steps 1-4) — shared with `openingRequestTokens`.
  const uniqueSorted = openingRequestTokens(signature);
  // An empty token list is ungroupable — return "" (the reflection job treats it as a never-corroborating singleton).
  if (uniqueSorted.length === 0) return "";
  // 5. Hash the canonical join (content-light — never the raw text; INV-6).
  return createHash("sha256").update(uniqueSorted.join(" ")).digest("hex");
}

/**
 * The PRE-HASH content-token SET of an opening request: the sorted, de-duplicated,
 * stopword-stripped, envelope-stripped tokens that {@link normalizeOpeningRequest}
 * hashes. Exposed for the reflection job's token-overlap MERGE pass: the exact-token-SET
 * hash collides only on IDENTICAL token sets, so two genuinely-same-task successes worded
 * DIFFERENTLY (e.g. a "fire" vs a "medical" dispatch on the same evening-rush cross-river
 * route) land on SEPARATE topicKeys and never reach the ≥2 corroboration gate. The
 * reflection job merges groups whose token sets are highly similar ({@link jaccardSimilarity}
 * ≥ threshold) — keyless, deterministic, NO embeddings (the v2.31 collapse deleted those on purpose).
 *
 * Pure: same pipeline as `normalizeOpeningRequest` steps 1-4, minus the hash.
 *
 * @param signature - the session's opening user-role request text (envelope stripped here).
 * @returns the sorted, de-duplicated content tokens (possibly empty).
 */
export function openingRequestTokens(signature: string): string[] {
  // 1. Strip the volatile per-turn envelope FIRST (Pitfall 3).
  const stripped = stripUserSystemContext(signature);
  // 2. Lowercase; collapse non-alphanumeric runs to a single space; trim.
  const cleaned = stripped
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  // 3. Tokenize; drop stopwords and tokens of length <= 1.
  const tokens = cleaned.length === 0 ? [] : cleaned.split(/\s+/).filter((t) => t.length > 1 && !STOPWORDS.has(t));
  // 4. De-duplicate into a Set, then SORT — order-insensitive (the collision-maximizing decision, A1).
  return [...new Set(tokens)].sort();
}

/**
 * Jaccard similarity of two token sets — `|A ∩ B| / |A ∪ B|` ∈ [0, 1]. The
 * order-insensitive, length-normalized overlap the reflection job uses to MERGE
 * differently-worded analogues into one corroboration cluster. Two empty sets return 0
 * (ungroupable, never corroborates — consistent with the empty-topicKey rule). Pure.
 */
export function jaccardSimilarity(a: readonly string[], b: readonly string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Asymmetric CONTAINMENT of a skill's core token-set by a turn's token-set —
 * `|core ∩ turn| / |core|` ∈ [0, 1]. Unlike Jaccard (symmetric "are these the SAME
 * task?", used by the corroboration merge), attribution asks "does this TURN instantiate
 * the skill's procedure?" — i.e. how much of the skill's CORE the turn contains, robust to
 * the turn being longer/more specific than the stored core. An empty core returns 0
 * (an un-grounded skill never auto-credits). Pure.
 */
export function tokenSetCoverage(core: readonly string[], turn: readonly string[]): number {
  const coreSet = new Set(core);
  if (coreSet.size === 0) return 0;
  const turnSet = new Set(turn);
  let present = 0;
  for (const t of coreSet) if (turnSet.has(t)) present += 1;
  return present / coreSet.size;
}

/** The core-coverage floor at/above which a surfaced learned skill is credited as USED on a
 *  turn that instantiates it. A turn containing ≥`threshold` of the skill's CORE procedure
 *  tokens is treated as a reuse of that skill. **0.5, data-driven from live runs**: a genuine
 *  behavioral reuse worded with SYNONYM + FRAMING variation (the same TTP described differently —
 *  "lateral movement" for "pivot", no shared boilerplate) lands ~0.5 coverage, while an unrelated
 *  turn lands ~0.0-0.1 and a similar-but-DIFFERENT task lands ~0.2-0.3 — a wide separating gap, so
 *  0.5 credits real reuse without false-crediting an unrelated/adjacent turn. An earlier 0.6 (set
 *  without data) MISSED genuine reuse → the learned skill never promoted on a real behavioral
 *  instance. (HEAVY synonym variation below ~0.4 is the lexical-match ceiling — a semantic /
 *  LLM-topic-tag grouping would be the escalation, deliberately out of the keyless v2.31 scope.) */
export const DEFAULT_TOPIC_MATCH_THRESHOLD = 0.5;

/** Absolute floor: a turn that shares at least this many of a skill's CORE tokens is credited
 *  as a reuse EVEN IF the coverage FRACTION is below {@link DEFAULT_TOPIC_MATCH_THRESHOLD}. This
 *  rescues a SHORT, on-topic turn (e.g. a one-line triage query) against a LARGE core distilled
 *  from verbose corroborating sources: it may share ~14 distinctive behavioral tokens yet only
 *  ~0.28 of a ~50-token core (observed live: a short verdict turn that failed to credit → its
 *  later correction then had no skill to demote). 8 is data-driven: a genuine short reuse shares
 *  ≥8 distinctive domain tokens; an adjacent-but-different task shares ~5; unrelated ~0 — a clear
 *  gap. Only ever HELPS a big core (a core ≤8 can't reach it except at coverage 1.0). */
export const MIN_ABSOLUTE_CORE_MATCH = 8;

/**
 * The deterministic, keyless TOPIC-MATCH reuse attribution. Skill attribution otherwise
 * requires the agent to explicitly `read` the SKILL.md file (ATTR-01 in pi-event-bridge.ts) —
 * a skill the agent APPLIED from the surfaced `<available_skills>` summary / from recall,
 * without opening the file, was never credited, so its `proof_count` never bumped and it
 * never promoted (the reuse leg of the learning loop was LLM-fragile). This credits a SURFACED skill whose
 * stored topic token-set is similar enough (Jaccard ≥ threshold) to the CURRENT turn's
 * opening-request token-set — i.e. the turn IS the skill's task — so a successful turn
 * on the skill's topic promotes it whether or not the model happened to open the file.
 * (The promote/demote SUCCESS/FAILURE gating, the corroboration belt, and the trust
 * ceiling are UNCHANGED — this only widens which surfaced skills enter `usedSkillIds`.)
 *
 * Pure. Returns the matched skill NAMES (the carrier the bridge merges into the turn's
 * `usedSkillIds`). Uses {@link tokenSetCoverage} (does the turn CONTAIN the skill's core
 * procedure?), NOT Jaccard — robust to the turn being more specific than the stored core.
 * A surfaced skill with no stored `topicTokens` (a legacy/seeded doc) is skipped (no false
 * credit). De-duplicated, deterministic order (input order).
 *
 * @param turnSignature - the current turn's opening user-request text.
 * @param surfaced - the skills surfaced this turn, each with its stored core topic token-set.
 * @param threshold - the coverage floor (default {@link DEFAULT_TOPIC_MATCH_THRESHOLD}).
 */
export function topicMatchedSkillNames(
  turnSignature: string,
  surfaced: ReadonlyArray<{ name: string; topicTokens: readonly string[] | undefined }>,
  threshold: number = DEFAULT_TOPIC_MATCH_THRESHOLD,
): string[] {
  const turnTokens = openingRequestTokens(turnSignature);
  if (turnTokens.length === 0) return [];
  const turnSet = new Set(turnTokens);
  const matched = new Set<string>();
  for (const s of surfaced) {
    if (!s.topicTokens || s.topicTokens.length === 0) continue; // legacy/seeded doc with no topic set — never false-credit
    const coreSet = new Set(s.topicTokens);
    let shared = 0;
    for (const t of coreSet) if (turnSet.has(t)) shared += 1;
    const coverage = coreSet.size === 0 ? 0 : shared / coreSet.size;
    // Credit on a strong FRACTION (the turn contains most of the core) OR a strong ABSOLUTE count
    // (a short on-topic turn shares many distinctive core tokens against a large/verbose core) —
    // the latter rescues a one-line triage reuse a fraction-only bar would miss (otherwise that
    // uncredited turn's later correction would have no skill to demote).
    if (coverage >= threshold || shared >= MIN_ABSOLUTE_CORE_MATCH) matched.add(s.name);
  }
  return [...matched];
}

/** The common-CORE token-set of a corroboration cluster — the INTERSECTION of its members'
 *  opening-request token-sets (the shared procedure, with per-instance specifics dropped).
 *  Stored as a skill's `topicTokens` so reuse attribution ({@link topicMatchedSkillNames})
 *  matches a differently-worded instance of the SAME procedure. Empty when the members
 *  share no content token (degrades to "no auto-credit", never a false one). Pure. */
export function commonCoreTokens(signatures: readonly string[]): string[] {
  const sets = signatures.map((s) => new Set(openingRequestTokens(s)));
  if (sets.length === 0) return [];
  const [first, ...rest] = sets;
  const core: string[] = [];
  for (const t of first) if (rest.every((s) => s.has(t))) core.push(t);
  return core.sort();
}
