// SPDX-License-Identifier: Apache-2.0
/**
 * Session-scoped trajectory-recorder registry.
 *
 * Lifts recorder lifecycle out of `pi-executor.runSessionLocked` (which
 * runs per-turn) into a session-scoped handle (one recorder per session,
 * spanning every turn). Ensures:
 *
 *   - `seq` is monotonic across all turns in a session (per-session
 *     monotonic, NOT per-turn).
 *   - Exactly one `session.started` and one `session.ended` event appear
 *     in the trajectory file.
 *   - The bridge subscription matches the recorder's lifetime, so events
 *     emitted between turns also reach the trajectory.
 *
 * The registry is the **only** owner of the EventBus bridge subscription
 * — callers receive a recorder reference but the unsubscribe lives on
 * the registry's internal map. `close(formattedKey)` is the single path
 * to flush + unsubscribe; `closeAll()` is the daemon-shutdown drain.
 *
 * Production wiring: the daemon composition root creates one registry
 * via `createSessionTrajectoryHandleRegistry()`, threads it through
 * `PiExecutorDeps.trajectoryRegistry`, and registers `closeAll()` in the
 * shutdown chain. `pi-executor` calls `getOrCreate(formattedKey, init,
 * eventBus)` once per `execute()` — on the second + subsequent turns
 * the existing recorder is returned (the `init` from the first call
 * wins for the session's lifetime).
 *
 * @module
 */

import type { TypedEventBus } from "@comis/core";

import {
  attachTrajectoryToEventBus,
  type TrajectoryBridgedEventName,
} from "./event-bus-bridge.js";
import { createTrajectoryRecorder } from "./runtime.js";
import type {
  TrajectoryRecorder,
  TrajectoryRecorderInit,
} from "./types.js";

/** Internal per-session entry. Holds the recorder + its unsubscribe. */
interface SessionEntry {
  readonly recorder: TrajectoryRecorder | null;
  /** Unsubscribe is `undefined` when `recorder === null` (env disable). */
  readonly unsubscribe: (() => void) | undefined;
  /**
   * Latch consulted by the pi-event-bridge `agent_start` case to suppress
   * per-turn `session:started` re-emits (mapping table —
   * `session.started` fires once per session, NOT once per pi-mono turn).
   * The bridge is created per turn, but the registry survives every turn,
   * so the latch lives here. Defaults to `false`; flipped to `true` by
   * `markSessionStarted(formattedKey)`. Reset implicitly by `close()`
   * dropping the entry — a fresh `getOrCreate` on the same key starts
   * with `false` again.
   */
  sessionStartedEmitted: boolean;
}

/**
 * Optional bridge filter forwarded to `attachTrajectoryToEventBus`.
 * Production callers (pi-executor) thread the
 * `diagnostics.trajectory.eventTypes` allowlist through here.
 */
export type SessionTrajectoryFilter = (
  eventName: TrajectoryBridgedEventName,
) => boolean;

/**
 * Public registry surface. The shape mirrors the lifecycle:
 *   - `getOrCreate` (called per-turn; first call materializes the
 *      recorder + bridge subscription, later calls reuse the same
 *      recorder),
 *   - `close` (single-session drain — called by the agent/orchestrator
 *      when the session is destroyed; flushes + unsubscribes + drops
 *      the entry),
 *   - `closeAll` (daemon-shutdown drain — called in the shutdown chain).
 */
export interface SessionTrajectoryHandleRegistry {
  /**
   * Return the recorder for `formattedKey`. If no entry exists yet,
   * construct one from `init` and subscribe the bridge to `eventBus`
   * with the optional `filter`. The `init` from the first call wins;
   * later calls IGNORE the passed `init` (subsequent turns can't
   * change provider/modelId mid-session without an explicit reset).
   *
   * Returns `{ recorder: null }` when the recorder factory short-circuits
   * (env-disabled or `init.enabled === false`); the registry remembers
   * the null entry so subsequent calls don't re-attempt construction.
   */
  getOrCreate(
    formattedKey: string,
    init: TrajectoryRecorderInit,
    eventBus: TypedEventBus,
    filter?: SessionTrajectoryFilter,
  ): { recorder: TrajectoryRecorder | null };

  /**
   * Drain one session. Unsubscribe + flushAndClose + drop the map
   * entry. Best-effort — errors are swallowed (a partial sidecar must
   * NOT block the agent's main shutdown path). Safe to call when no
   * entry exists (no-op).
   */
  close(formattedKey: string): Promise<void>;

  /**
   * Drain every open session. Used by the daemon's shutdown chain
   * after RPC servers stop accepting connections. Errors are swallowed
   * per-entry; the iteration completes even when one entry's
   * `flushAndClose` throws.
   */
  closeAll(): Promise<void>;

  /**
   * Return the recorder for `formattedKey` if it exists, `undefined`
   * otherwise. Pure-read accessor — no creation side-effects. Returns
   * `null` when the entry was created with env-disabled / `enabled:false`
   * init (i.e., the entry exists but the recorder itself is null). Returns
   * `undefined` when no entry exists at all.
   *
   * Used by direct-emit sites to call
   * `recorder.recordEvent(...)` without going through the bus bridge.
   */
  getRecorder(formattedKey: string): TrajectoryRecorder | null | undefined;

  /**
   * Returns `true` once `markSessionStarted(formattedKey)` has been
   * called for this session's registry lifetime, `false` otherwise.
   *
   * Used by the pi-event-bridge `agent_start` case to suppress per-turn
   * `session:started` re-emits — the mapping table makes
   * `session.started` a once-per-session event (not once-per-turn).
   * Per-turn bridges consult this latch so the second + subsequent
   * turns short-circuit the emit.
   *
   * Defaults to `false` for unknown keys (the bridge may consult this
   * for a session whose entry hasn't been materialized yet via
   * `getOrCreate`; the safe behavior is "no emit recorded → let the
   * caller emit"). When the entry is later created and the emit fires,
   * `markSessionStarted` flips the latch on the entry.
   */
  hasSessionStartedBeenEmitted(formattedKey: string): boolean;

  /**
   * Mark that `session:started` has been emitted for this session.
   * Idempotent. Safe to call on unknown keys (no-op — the bridge
   * always calls this immediately after `eventBus.emit("session:started", …)`
   * and the entry materializes on the same turn via `getOrCreate`,
   * but the API tolerates ordering surprises).
   */
  markSessionStarted(formattedKey: string): void;
}

/**
 * Construct an empty registry. The factory is the sanctioned entry
 * point — callers MUST NOT instantiate the internal map shape directly.
 */
export function createSessionTrajectoryHandleRegistry(): SessionTrajectoryHandleRegistry {
  const entries = new Map<string, SessionEntry>();

  return {
    getOrCreate(formattedKey, init, eventBus, filter) {
      const existing = entries.get(formattedKey);
      if (existing !== undefined) {
        return { recorder: existing.recorder };
      }
      const recorder = createTrajectoryRecorder(init);
      let unsubscribe: (() => void) | undefined;
      if (recorder !== null) {
        unsubscribe = attachTrajectoryToEventBus({
          eventBus,
          recorder,
          // Session-scope the subscription to THIS session — every open
          // recorder shares one bus, and an unscoped bridge ingests every
          // other session's events (stamped with this session's id).
          ownerSessionKey: formattedKey,
          ...(filter !== undefined ? { filter } : {}),
        });
      }
      // sessionStartedEmitted intentionally starts as `false`. Bridge
      // flips it via markSessionStarted on the first emit; close()
      // drops the entry so a future getOrCreate re-starts at `false`.
      const entry: SessionEntry = {
        recorder,
        unsubscribe,
        sessionStartedEmitted: false,
      };
      entries.set(formattedKey, entry);
      return { recorder };
    },

    async close(formattedKey) {
      const entry = entries.get(formattedKey);
      if (entry === undefined) return;
      entries.delete(formattedKey);
      // Unsubscribe before flush — once unsubscribed, no new events can
      // land between the flush and close. EventEmitter.off is sync.
      try {
        entry.unsubscribe?.();
      } catch {
        // Unsubscribe failure is unreachable in practice (EventEmitter.off
        // is sync); swallow defensively so this never aborts cleanup.
      }
      if (entry.recorder !== null) {
        try {
          await entry.recorder.flushAndClose();
        } catch {
          // Best-effort — a partial sidecar must NOT block agent shutdown.
        }
      }
    },

    async closeAll() {
      // Snapshot keys first so per-entry close calls can safely mutate
      // the internal map.
      const keys = Array.from(entries.keys());
      for (const k of keys) {
        // close() swallows per-entry errors; the iteration always
        // completes.
        await this.close(k);
      }
    },

    getRecorder(formattedKey: string): TrajectoryRecorder | null | undefined {
      const entry = entries.get(formattedKey);
      if (entry === undefined) return undefined;
      // Return null when env-disabled (recorder is null but entry exists),
      // or the recorder itself when it was constructed successfully.
      return entry.recorder;
    },

    hasSessionStartedBeenEmitted(formattedKey: string): boolean {
      // Unknown key → false (lets the bridge emit on the very first
      // turn before the recorder is materialized; getOrCreate fires
      // on the same call path so by the time markSessionStarted runs
      // the entry exists).
      return entries.get(formattedKey)?.sessionStartedEmitted ?? false;
    },

    markSessionStarted(formattedKey: string): void {
      const entry = entries.get(formattedKey);
      if (entry === undefined) return; // silent no-op for unknown keys
      entry.sessionStartedEmitted = true;
    },
  };
}
