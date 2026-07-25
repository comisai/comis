// SPDX-License-Identifier: Apache-2.0
/**
 * Turn-flight tracker: an in-memory registry of sessions with a turn
 * CURRENTLY EXECUTING, fed purely by existing event-bus lifecycle events.
 *
 * Exists as the live-turn oracle for the background completion
 * dispatcher/runner (`isTurnInFlight`): a tool auto-backgrounded mid-turn is
 * consumed by its own still-running turn through one blocking
 * `background_tasks read_output` call, so its completion must fire no
 * user-visible fallback and no re-entry while that turn runs. The persistent
 * daemon session store is not an execution-flight oracle for JSONL-backed
 * conversations, so this registry is authoritative for that decision.
 *
 * Lifecycle signals (all pre-existing bus events; no emitter changes):
 *   - `queue:dequeued`   → a channel turn started for `sessionKey` (SessionKey
 *     object — formatted here).
 *   - `session:summary`  → the turn finalized (formatted key string).
 *   - `execution:aborted`→ the turn aborted (SessionKey object — formatted here).
 *
 * Crash-safety: an entry older than `staleMs` (default 30 min) is treated as
 * NOT in flight — a turn that died without a summary must not suppress
 * notifications forever. State is ephemeral (daemon restart clears it), which
 * is correct: after a restart no turn is executing.
 *
 * @module
 */

import type { TypedEventBus, SessionKey } from "@comis/core";
import { formatSessionKey, systemNowMs } from "@comis/core";

/** Default staleness ceiling for an in-flight mark (30 minutes). */
const DEFAULT_STALE_MS = 30 * 60 * 1000;

export interface TurnFlightTracker {
  /** True while `formattedSessionKey` has a turn currently executing (and the
   *  mark is fresher than `staleMs`). */
  isTurnInFlight(formattedSessionKey: string): boolean;
  /** Unsubscribe from the event bus. Idempotent. */
  shutdown(): void;
}

export interface TurnFlightTrackerDeps {
  eventBus: TypedEventBus;
  /** Staleness ceiling override (tests). Default 30 min. */
  staleMs?: number;
  /** Clock override (tests). Default systemNowMs. */
  nowMs?: () => number;
}

/**
 * Subscribe the tracker to the bus. Call `shutdown()` in the daemon's
 * shutdown chain (setup-background-completion-runner.ts wires it).
 */
export function createTurnFlightTracker(deps: TurnFlightTrackerDeps): TurnFlightTracker {
  const staleMs = deps.staleMs ?? DEFAULT_STALE_MS;
  const now = deps.nowMs ?? systemNowMs;
  // formattedSessionKey → mark time (ms). One turn per session at a time
  // (the command queue serializes per-session lanes), so a plain overwrite
  // on start + delete on end is sufficient.
  const inFlight = new Map<string, number>();

  const onDequeued = (data: { sessionKey: SessionKey }) => {
    try {
      inFlight.set(formatSessionKey(data.sessionKey), now());
    } catch {
      // A malformed key must never tear down the subscription.
    }
  };
  const onSummary = (data: { sessionKey: string }) => {
    if (typeof data?.sessionKey === "string") inFlight.delete(data.sessionKey);
  };
  const onAborted = (data: { sessionKey: SessionKey }) => {
    try {
      inFlight.delete(formatSessionKey(data.sessionKey));
    } catch {
      // A malformed key must never tear down the subscription.
    }
  };

  deps.eventBus.on("queue:dequeued", onDequeued);
  deps.eventBus.on("session:summary", onSummary);
  deps.eventBus.on("execution:aborted", onAborted);

  return {
    isTurnInFlight(formattedSessionKey: string): boolean {
      const markedAt = inFlight.get(formattedSessionKey);
      if (markedAt === undefined) return false;
      if (now() - markedAt > staleMs) {
        // A turn that never finalized (crash/kill) must not suppress
        // notifications forever — drop the stale mark.
        inFlight.delete(formattedSessionKey);
        return false;
      }
      return true;
    },
    shutdown(): void {
      deps.eventBus.off("queue:dequeued", onDequeued);
      deps.eventBus.off("session:summary", onSummary);
      deps.eventBus.off("execution:aborted", onAborted);
      inFlight.clear();
    },
  };
}
