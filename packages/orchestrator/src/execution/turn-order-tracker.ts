// SPDX-License-Identifier: Apache-2.0
/**
 * Per-session turn ordering, so an out-of-order reply can say what it answers.
 *
 * A reply is anchored to its originating message only in group chats: in a 1:1 chat every reply
 * obviously answers the last message, and anchoring would be noise. That premise holds only while
 * replies arrive in request order — and a turn held at an approval gate breaks it. Such a turn can
 * sit for the whole approval timeout and then deliver its outcome AFTER a later turn has already
 * answered, so the user reads a terminal notice about an earlier attempt as though it described
 * the work they are currently looking at.
 *
 * This module answers one question — has a newer turn started in this session? — which is exactly
 * the missing fact. A monotonic counter is used rather than a clock: it needs no time source, is
 * immune to clock adjustment, and makes the ordering deterministic in tests.
 *
 * State is in-memory and per-process on purpose. It describes turns currently in flight; a restart
 * has no in-flight blocked turns to reason about, so there is nothing to persist. The map is capped
 * and evicts least-recently-used sessions, because a long-lived daemon must not accumulate an entry
 * per conversation forever.
 *
 * @module
 */

/** Sessions retained before least-recently-used eviction. */
const DEFAULT_MAX_SESSIONS = 2048;

export interface TurnOrderTracker {
  /**
   * Record that a turn has started for this session.
   *
   * @param sessionKey - the formatted session key.
   * @returns this turn's sequence number, to be passed back to {@link isSuperseded}.
   */
  noteTurnStarted(sessionKey: string): number;
  /**
   * Has a turn newer than `seq` started in this session?
   *
   * Fail-open: an unknown or evicted session reports `false`. Without positive evidence that a
   * newer turn ran, treat the reply as in order — anchoring an in-order reply would put quoting on
   * ordinary DM traffic, which is the noise the group-only rule exists to avoid.
   */
  isSuperseded(sessionKey: string, seq: number): boolean;
  /** Sessions currently tracked. Exposed so the eviction bound is assertable. */
  trackedSessionCount(): number;
}

export interface TurnOrderTrackerOptions {
  /** Sessions retained before LRU eviction (default {@link DEFAULT_MAX_SESSIONS}). */
  readonly maxSessions?: number;
}

export function createTurnOrderTracker(options?: TurnOrderTrackerOptions): TurnOrderTracker {
  const maxSessions = options?.maxSessions ?? DEFAULT_MAX_SESSIONS;
  // A Map preserves insertion order, so re-inserting on touch makes the first key the LRU one.
  const latestSeqBySession = new Map<string, number>();

  function touch(sessionKey: string, seq: number): void {
    latestSeqBySession.delete(sessionKey);
    latestSeqBySession.set(sessionKey, seq);
    while (latestSeqBySession.size > maxSessions) {
      const oldest = latestSeqBySession.keys().next();
      if (oldest.done === true) break;
      latestSeqBySession.delete(oldest.value);
    }
  }

  return {
    noteTurnStarted(sessionKey) {
      const next = (latestSeqBySession.get(sessionKey) ?? 0) + 1;
      touch(sessionKey, next);
      return next;
    },
    isSuperseded(sessionKey, seq) {
      const latest = latestSeqBySession.get(sessionKey);
      return latest !== undefined && latest > seq;
    },
    trackedSessionCount() {
      return latestSeqBySession.size;
    },
  };
}

/**
 * The process-wide tracker the execution pipeline uses.
 *
 * A singleton because turn ordering is a property of a live session shared by every turn running
 * against it, and threading an instance through the delivery path would add a dependency to a hot
 * signature for a fact that is inherently process-global. Tests construct their own via
 * {@link createTurnOrderTracker}.
 */
export const turnOrderTracker: TurnOrderTracker = createTurnOrderTracker();
