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

/**
 * How far the computed boundary must drift past the held one before the held one gives way.
 *
 * Holding WITHIN a turn stops the boundary marching on every tool cycle, but the boundary still
 * advanced once per TURN — a one-message slide that re-wrote the message zone on every turn, so
 * `cache_read` never grew past the stable system prefix (pinned at exactly 80,865 live, across
 * every variant tried). Advancing in one step every N turns instead of by one every turn keeps the
 * prefix byte-identical for the turns in between, which is the whole precondition for a hit.
 *
 * The cost of holding is bounded: at most this many extra messages stay verbatim in the tail, and
 * the per-turn token bound downstream still trims them.
 */
const ADVANCE_STEP = 8;

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
  // Hold only while the boundary message is STILL THE SAME MESSAGE. An anchor that outlives the
  // prefix it protects would pin a boundary into unrelated content — silently keeping messages
  // verbatim that belong in history. Verifying the message at the held index is the direct check,
  // not a proxy for it, and it is what releases the anchor after a compaction replaces the head.
  const boundaryIntact = prev !== undefined && digestAt(prev.tailStart) === prev.boundaryDigest;

  if (boundaryIntact) {
    const sameTurn = prev.turnKey === turnKey;
    // Within a turn the boundary never advances: the array grows on every tool cycle and moving
    // with it drops already-sent messages off the head mid-turn. Across turns it advances only once
    // the drift is worth paying for, so the prefix stays byte-identical for the turns in between.
    const mustAdvance = !sameTurn && computedTailStart - prev.tailStart >= ADVANCE_STEP;
    if (!mustAdvance) {
      // Still allow the boundary to move EARLIER — the in-flight coverage clamp widens the tail to
      // carry unpersisted messages, and suppressing that loses a turn's own originating request.
      const held = Math.min(prev.tailStart, computedTailStart);
      anchors.delete(sessionKey);
      anchors.set(sessionKey, { turnKey, tailStart: held, boundaryDigest: digestAt(held) });
      return held;
    }
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

/**
 * Which SIDE of the history/fresh-tail seam each synthesized tool-result placeholder landed on.
 *
 * `sanitizeToolUseResultPairing` inserts a placeholder for any `tool_use` left without its result,
 * and live the assembled array gained two of them on roughly every third assembly — an insertion
 * that shifts every index after it and re-writes the cached prefix. Two seams could orphan a call:
 * the fresh-tail slice and the eviction boundary. Measuring which one produces them is the check
 * that separates them; asserting it from the code shape got it wrong once already.
 *
 * `historyCount` is the pre-repair `budgeted.length`. Placeholders are counted against it, so an
 * index below it belongs to the evicted-history side and an index at or above it to the tail side.
 */
export function classifySynthesizedPlaceholders(
  repaired: ReadonlyArray<Record<string, unknown>>,
  historyCount: number,
  marker: string,
): { inHistory: number; inFreshTail: number; indices: number[] } {
  const indices: number[] = [];
  let inHistory = 0;
  let inFreshTail = 0;
  for (let i = 0; i < repaired.length; i++) {
    const content = repaired[i]!.content;
    if (!Array.isArray(content)) continue;
    const isPlaceholder = (content as Array<Record<string, unknown>>).some(
      b => typeof b.text === "string" && (b.text as string).includes(marker),
    );
    if (!isPlaceholder) continue;
    if (indices.length < 8) indices.push(i);
    if (i < historyCount) inHistory++;
    else inFreshTail++;
  }
  return { inHistory, inFreshTail, indices };
}

/**
 * Identity + body digest of the message sitting at index 0 of the assembled array.
 *
 * Index 0 is the history head — normally the single LCD summary — and on Bedrock it was rewritten
 * at turn boundaries (`content-cleared,block-count-changed` at idx 0), costing the WHOLE prefix on
 * ~30% of calls because a cachePoint matches from the array start. Two causes need opposite fixes
 * and look identical in the churn log: the summary ROW was replaced (re-summarization), or the same
 * row RENDERED differently. The header carries the row's own identity (depth, descendant_count,
 * time range), so comparing it against a digest of the body separates them: same head + different
 * digest is a rendering instability; a changed head is re-summarization.
 */
export function describeAssemblyHead(
  head: Record<string, unknown> | undefined,
): { headId: string; headDigest: string } | undefined {
  if (!head) return undefined;
  const content = head.content;
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? (content as Array<Record<string, unknown>>)
          .map(b => (typeof b.text === "string" ? b.text : ""))
          .join("")
      : "";
  if (text === "") return undefined;
  const newline = text.indexOf("\n");
  // The bracketed header is a closed set of structural markers — no summary body, no user content.
  const firstLine = newline === -1 ? text.slice(0, 200) : text.slice(0, Math.min(newline, 200));
  const headId = firstLine.startsWith("[") ? firstLine : `${String(head.role)}:non-summary`;
  return { headId, headDigest: digestOf(text) };
}
