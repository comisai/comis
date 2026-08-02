// SPDX-License-Identifier: Apache-2.0
/**
 * Turn-scoped anchoring for the fresh-tail start index.
 *
 * The fresh tail is a slice of the trailing N steps, so its start index is derived from the LENGTH
 * of the live message array. Inside one turn that array grows on every tool cycle, which marched the
 * start index forward on every CALL and dropped messages off the head of the prompt — rewriting the
 * cached prefix each time.
 *
 * Measured on comis-moshe 2026-08-02 (Haiku 4.5): `cache_read_input_tokens` 0 with ~101k cache
 * CREATION re-paid on every call — a 0.0% hit ratio — on Bedrock, where the earliest cachePoint sits
 * inside the sliding region so nothing survives; ~16k re-created per call on the native Anthropic
 * path, where an earlier breakpoint still matches. Same defect, different blast radius.
 *
 * The fix is to pick the boundary ONCE per turn and hold it for that turn's tool loop. Between turns
 * it advances normally, so history still folds into summaries at the same rate — the window is not
 * widened, only kept still while a turn is in flight.
 *
 * @module
 */

/** Bound on retained anchors so a long-lived daemon cannot accumulate one per session forever. */
const MAX_ANCHORS = 512;

interface FreshTailAnchor {
  /** Identity of the turn this anchor belongs to. */
  turnKey: string;
  /** The start index held for the duration of that turn. */
  tailStart: number;
  /** Digest of the message sitting AT `tailStart` when the anchor was taken. */
  boundaryDigest: string;
}

const anchors = new Map<string, FreshTailAnchor>();

/**
 * Identity of the turn currently in flight: the conversation HEAD, plus the originating user
 * message's position and a digest of its content.
 *
 * Position alone is not enough — the array is rebuilt between turns, so a later turn can land its
 * user message at the same index and would silently inherit the previous turn's anchor. The head is
 * included for the same reason at conversation scope: holding a boundary is only meaningful while
 * the prefix it protects is still the same prefix, so a rebuilt or compacted history re-derives
 * rather than inheriting. Tool-result carrier messages are skipped, so the key holds still across a
 * turn's tool cycles — exactly the interval the anchor must span.
 */
export function freshTailTurnKey(
  messages: ReadonlyArray<Record<string, unknown>>,
  isToolResultCarrier: (m: Record<string, unknown>) => boolean,
): string | undefined {
  // The turn ORDINAL — how many real user turns the array holds — not the turn's content. A user
  // can send the same text twice, so a content digest is not a turn identity: the second "ok" would
  // inherit the first one's anchor. The ordinal is constant across a turn's tool cycles (they append
  // assistant and tool-result messages, never a user turn) and increments on the next real turn.
  let ordinal = 0;
  let lastIndex = -1;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role !== "user" || isToolResultCarrier(msg)) continue;
    ordinal++;
    lastIndex = i;
  }
  if (ordinal === 0) return undefined;
  // The head is included so a compaction that replaces the prefix re-derives rather than inheriting
  // a boundary into content that is no longer there.
  const head = digestOf(messages[0]!.content);
  return `${head}|n${ordinal}@${lastIndex}`;
}

/** Cheap, allocation-light digest of a message's content — identity only, never logged. */
function digestOf(content: unknown): string {
  const s = typeof content === "string" ? content : JSON.stringify(content) ?? "";
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return `${h.toString(36)}.${s.length}`;
}

/**
 * The fresh-tail start to use for this call: the value already chosen for this turn, or the freshly
 * computed one when a new turn began.
 *
 * Takes the MINIMUM of the held and computed values so a boundary that needs to move EARLIER still
 * can — the in-flight coverage clamp widens the tail to carry unpersisted messages, and that must
 * not be suppressed. Only forward motion, the kind that drops already-sent messages off the head
 * mid-turn, is held back.
 */
export function resolveAnchoredFreshTailStart(
  sessionKey: string | undefined,
  turnKey: string | undefined,
  computedTailStart: number,
  messages: ReadonlyArray<Record<string, unknown>>,
): number {
  if (!sessionKey || !turnKey) return computedTailStart;

  const digestAt = (i: number): string =>
    i >= 0 && i < messages.length ? digestOf(messages[i]!.content) : "oob";

  const prev = anchors.get(sessionKey);
  // Hold only while the boundary message is STILL THE SAME MESSAGE. A turn key can repeat across
  // genuinely different arrays, and an anchor that outlives the prefix it protects would pin a
  // boundary into unrelated content — silently keeping messages verbatim that belong in history.
  // Verifying the message at the held index is the direct check, not a proxy for it.
  const stillTheSamePrefix = prev !== undefined
    && prev.turnKey === turnKey
    && digestAt(prev.tailStart) === prev.boundaryDigest;

  if (stillTheSamePrefix) {
    const held = Math.min(prev.tailStart, computedTailStart);
    // Re-set so this session becomes the most recently used entry.
    anchors.delete(sessionKey);
    anchors.set(sessionKey, { turnKey, tailStart: held, boundaryDigest: digestAt(held) });
    return held;
  }

  anchors.delete(sessionKey);
  anchors.set(sessionKey, {
    turnKey,
    tailStart: computedTailStart,
    boundaryDigest: digestAt(computedTailStart),
  });
  if (anchors.size > MAX_ANCHORS) {
    const oldest = anchors.keys().next();
    if (!oldest.done) anchors.delete(oldest.value);
  }
  return computedTailStart;
}

/** Drop a session's anchor (session reset / conversation replacement). */
export function clearFreshTailAnchor(sessionKey: string): void {
  anchors.delete(sessionKey);
}

/** Test seam: forget every anchor. */
export function resetFreshTailAnchors(): void {
  anchors.clear();
}
