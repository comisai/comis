// SPDX-License-Identifier: Apache-2.0
/**
 * `normalizeOpeningRequest` (Phase 223, D-01 / REFLECT-02) — the deterministic,
 * keyless, **content-light** `topicKey` that REPLACES embedding-cosine clustering.
 *
 * This is the milestone's concentrated risk (SYNTH-EMBED-DEAD re-lived from the
 * other direction): the reflection job groups successful outcomes by this key, so
 * two genuinely same-topic sessions worded DIFFERENTLY MUST collide on one key —
 * else corroboration never reaches the >=2 distinct (session,sender) gate and
 * `admitted:0` persists forever (the exact symptom embedding clustering had). The
 * collision-maximizing decision is the order-insensitive token SET (see below).
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
  const uniqueSorted = [...new Set(tokens)].sort();
  // An empty token list is ungroupable — return "" (the reflection job treats it as a never-corroborating singleton).
  if (uniqueSorted.length === 0) return "";
  // 5. Hash the canonical join (content-light — never the raw text; INV-6).
  return createHash("sha256").update(uniqueSorted.join(" ")).digest("hex");
}
