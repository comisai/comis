// SPDX-License-Identifier: Apache-2.0
/**
 * Recurring wake-dispatch FSM (OPS-08/OPS-09) — the daemon-side module that
 * turns a `terminal:input_needed` event into AT MOST ONE woken agent turn.
 *
 * Modeled on `packages/agent/src/background/completion-dispatcher.ts`, but
 * RECURRING/mid-session: the completion-dispatcher fires once per task
 * completion; this FSM fires repeatedly across a session's lifetime, so its
 * dedupe key is `(sessionId, requestId)` (not `taskId`) and it RESETS its
 * pending flag after each answered frame. Every sub-problem the completion-
 * dispatcher already solves maps over:
 *
 *   | completion-dispatcher                | wake-FSM (here)                          |
 *   |--------------------------------------|------------------------------------------|
 *   | at-most-once dispatchState gate      | DEDUPE — N input_needed → 1 woken turn   |
 *   | transitionDispatchState→persistTask  | PERSIST — survives daemon restart        |
 *   | sessionStore.loadByFormattedKey      | ACTIVE-CHECK — drop dead-session wakes    |
 *   | maxBackgroundHops → fireFallback     | HOP-LIMIT → forced ESCALATION             |
 *   | (n/a — one-shot)                     | BOUNDED RE-ENTRY (maxConcurrentAttentionTurns) |
 *   | suppressError failure isolation      | suppressError on the woken turn           |
 *   | shutdown() = off + await inflight    | shutdown() = off + await inflight (drain) |
 *
 * **Daemon-side placement (binding — RESEARCH Open Q1 + Pitfall 3):** the FSM
 * persists via `@comis/observability` (terminal-wake-persistence.ts), which
 * `@comis/skills` must NOT value-import — so the recurring FSM + its
 * persistence live in the daemon layer (spec §4.4 "@comis/core/daemon"), not
 * in the skills worker.
 *
 * **Separability (124-09 is the keystone):** this module is the FSM UNIT. The
 * daemon SUBSCRIBE wiring — binding the fd3 hook → this FSM → a woken turn
 * that runs the auto-answer / loop-guard, and binding `escalate` to emit the
 * `terminal:escalated` event + the subagent→parent→human chain — lands in
 * 124-09. Here, `escalate` is an injected NotifyFn-shaped callback and
 * `wakeOneTurn` is the injected woken-turn driver.
 *
 * Injected clock (`nowMs`), closure-local state ONLY (no module-global),
 * never-throw isolation (a wake handler error must not crash the dispatcher).
 *
 * @module
 */
import { suppressError } from "@comis/shared";
import type { ComisLogger } from "@comis/core";
import {
  persistWakeStateSync,
  recoverWakeStates,
  type PersistedWakeOwner,
  type PersistedWakeState,
} from "./terminal-wake-persistence.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The escalation reasons this FSM raises (a subset of the `terminal:escalated` union). */
export type WakeEscalationReason = "hop_limit";

/**
 * The escalation callback (NotifyFn-shaped, the completion-dispatcher
 * `fireFallback` precedent). 124-09 binds this to emit `terminal:escalated`
 * + drive the subagent→parent→human chain (spec §4.7). Returns a promise so
 * the FSM can await it inside its in-flight tracking.
 */
export type WakeEscalateFn = (opts: {
  sessionId: string;
  owner: PersistedWakeOwner;
  reason: WakeEscalationReason;
}) => Promise<unknown>;

/**
 * The narrow structural event the FSM consumes. It carries `requestId` (the
 * `(sessionId, requestId)` dedupe correlation, reusing the P0 framer key
 * shape) — the daemon hook in 124-09 maps the fd3 frame's requestId in. The
 * core `terminal:input_needed` bus payload omits requestId (it is a
 * redaction-safe summary); the FSM's correlation needs it, so the daemon
 * threads it from the frame.
 */
export interface TerminalInputNeededWake {
  sessionId: string;
  requestId: string;
  owner: PersistedWakeOwner;
  state: "awaiting-input" | "stuck";
  reason: string;
}

/**
 * The minimal structural event-bus surface the FSM subscribes. A `Pick`-style
 * narrow contract (the `terminal-send-guards.ts:79` precedent) so the daemon's
 * `TypedEventBus` is structurally assignable and tests pass a capturing fake.
 */
export interface WakeDispatcherBus {
  on(event: "terminal:input_needed", handler: (data: TerminalInputNeededWake) => void): void;
  off(event: "terminal:input_needed", handler: (data: TerminalInputNeededWake) => void): void;
}

/** Public-facing handle on the wake dispatcher. */
export interface TerminalWakeDispatcher {
  /**
   * Drop the in-memory FSM state for a session that has ended (killed/evicted/exited)
   * — IN-03/WR-02. The `states` map is otherwise only pruned when a NEW wake arrives
   * for an already-dead session (the active-check), so a session that goes quiet then
   * dies would leak its `WakeState` for the daemon's lifetime. The end-of-life hook in
   * `setupTerminalWake` calls this (alongside the loop-guard + wake-file cleanup). Total
   * / never-throws; a no-op for an unknown id.
   */
  forgetSession(sessionId: string): void;
  /** Unsubscribe from the bus + drain in-flight woken turns. Idempotent, awaitable. */
  shutdown(): Promise<void>;
}

/** Wake-dispatcher dependencies (all injected — no module-global, no raw clock). */
export interface TerminalWakeDispatcherDeps {
  /** The typed bus (structurally a `WakeDispatcherBus`). */
  eventBus: WakeDispatcherBus;
  /** Active-session check — owner-scoped (the P4 registry). A wake for a session
   *  this reports false (killed/evicted/cross-owner) is dropped + audited. */
  isSessionActive: (sessionId: string, owner: PersistedWakeOwner) => boolean;
  /**
   * Is the drive BACKGROUNDED (promoted via DRIVE-02)? — the foreground-drive guard
   * (LIVE-03 / #4). The fd3 woken turn is the BACKGROUND attention mechanism (it runs the
   * deterministic auto-answer/escalate when NO agent turn is processing the session). While
   * the OWNING FOREGROUND turn is still driving — the drive has not yet been promoted — that
   * turn handles every settle itself via its own `terminal_session_wait`, so a woken turn here
   * is REDUNDANT and RACES it (at launch claude's welcome screen fires input_needed a beat
   * before the foreground turn sends its first keystroke → a spurious "waiting for input"
   * escalation). When this returns false the wake is SKIPPED (deferred to the foreground turn).
   * Optional: an isolated FSM/test omits it ⇒ NO gate (the unit's default — every wake dispatches).
   */
  isDriveBackgrounded?: (sessionId: string) => boolean;
  /** The woken-turn driver (124-09 wires it to the agent turn). */
  wakeOneTurn: (sessionId: string, owner: PersistedWakeOwner) => Promise<void>;
  /** Hop-limit / drop escalation (124-09 binds it to terminal:escalated). */
  escalate: WakeEscalateFn;
  /** Data dir for the durable wake-state. */
  dataDir: string;
  /** Consecutive woken-turn cap; at this count the next wake escalates. */
  maxHops: number;
  /** Bound on simultaneous woken turns across sessions (schema worker.maxConcurrentAttentionTurns). */
  maxConcurrentAttentionTurns: number;
  /** Injected monotonic clock (no raw global time reads — house rule §2.5). */
  nowMs: () => number;
  logger: ComisLogger;
}

// ---------------------------------------------------------------------------
// Closure-local FSM state
// ---------------------------------------------------------------------------

/** In-memory per-session wake-state (the persisted shape minus the redundant sessionId). */
interface WakeState {
  owner: PersistedWakeOwner;
  dispatchState: PersistedWakeState["dispatchState"];
  hopCount: number;
  pendingFrame?: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Wire the recurring wake-dispatch FSM against an event bus. Subscriptions are
 * installed synchronously; call `shutdown()` to remove them + drain.
 *
 * Recovers persisted dispatch state on construction (OPS-09) so a session
 * mid-wake before a daemon restart is not re-woken spuriously.
 */
export function createTerminalWakeDispatcher(
  deps: TerminalWakeDispatcherDeps,
): TerminalWakeDispatcher {
  const log = deps.logger.child({ submodule: "terminal-wake-dispatch" });

  // --- closure-local state ONLY (no module-global; two instances never share) ---
  const states = new Map<string, WakeState>();
  const pendingQueue: TerminalInputNeededWake[] = [];
  let inFlightWokenTurns = 0;
  let stopped = false;
  let inflight: Promise<void> = Promise.resolve();

  // Recover persisted dispatch state on boot (OPS-09).
  for (const persisted of recoverWakeStates(deps.dataDir)) {
    states.set(persisted.sessionId, {
      owner: persisted.owner,
      dispatchState: persisted.dispatchState,
      hopCount: persisted.hopCount,
      pendingFrame: persisted.pendingFrame,
    });
    // A session recovered mid-wake (woken with a pendingFrame) counts toward
    // the concurrency bound until its turn settles — but its turn died with
    // the daemon, so we do NOT re-occupy a slot. The dedupe gate (pendingFrame)
    // is what prevents a spurious re-wake of the same unanswered frame.
  }

  function ensureState(sessionId: string, owner: PersistedWakeOwner): WakeState {
    let st = states.get(sessionId);
    if (!st) {
      st = { owner, dispatchState: "idle", hopCount: 0 };
      states.set(sessionId, st);
    }
    return st;
  }

  function persist(sessionId: string, st: WakeState): void {
    persistWakeStateSync(deps.dataDir, {
      sessionId,
      owner: st.owner,
      dispatchState: st.dispatchState,
      hopCount: st.hopCount,
      ...(st.pendingFrame !== undefined && { pendingFrame: st.pendingFrame }),
    });
  }

  /** Track a promise in the drain chain + isolate its failure (AGENTS §2.1). */
  function trackInflight(promise: Promise<void>, reason: string): void {
    inflight = inflight.then(() => promise).catch(() => undefined);
    suppressError(promise, reason);
  }

  const onInputNeeded = (data: TerminalInputNeededWake): void => {
    if (stopped) return;
    handleWake(data);
  };

  deps.eventBus.on("terminal:input_needed", onInputNeeded);

  function handleWake(ev: TerminalInputNeededWake): void {
    const st = ensureState(ev.sessionId, ev.owner);

    // (1) DEDUPE — coalesce duplicate input_needed for one unanswered frame.
    if (st.pendingFrame === ev.requestId) {
      log.debug(
        { sessionId: ev.sessionId, requestId: ev.requestId, step: "wake_dedupe" },
        "Wake dispatch: duplicate input_needed coalesced",
      );
      return;
    }

    // (2) ACTIVE-CHECK — drop wakes for genuinely-gone sessions. ISSUE-3: isSessionActive now
    // recovers the STAMPED owner (registry.getOwner), so a LIVE channel/API session is NOT dropped
    // cross-owner; a drop here means the session is truly absent (killed/evicted/never-registered).
    if (!deps.isSessionActive(ev.sessionId, ev.owner)) {
      log.warn(
        {
          sessionId: ev.sessionId,
          requestId: ev.requestId,
          agentId: ev.owner.agentId,
          hint: "Session not found in the registry (killed/evicted/gone); wake dropped — no re-entry into a dead PTY",
          errorKind: "precondition" as const,
        },
        "Wake dispatch: dropped wake for inactive session",
      );
      // The session is gone; forget any stale in-memory state for it.
      states.delete(ev.sessionId);
      return;
    }

    // (3) HOP-LIMIT — at the cap, force escalation instead of another turn.
    if (st.hopCount >= deps.maxHops) {
      log.warn(
        {
          sessionId: ev.sessionId,
          requestId: ev.requestId,
          agentId: ev.owner.agentId,
          hopCount: st.hopCount,
          hint: "Hop limit reached; escalating to a human instead of waking another turn",
          errorKind: "precondition" as const,
        },
        "Wake dispatch: hop limit → escalation",
      );
      fireEscalation(ev, "hop_limit");
      return;
    }

    // (4) BOUNDED RE-ENTRY — beyond the bound, leave pending (re-evaluated on slot free).
    if (inFlightWokenTurns >= deps.maxConcurrentAttentionTurns) {
      st.dispatchState = "pending";
      pendingQueue.push(ev);
      persist(ev.sessionId, st);
      log.debug(
        {
          sessionId: ev.sessionId,
          requestId: ev.requestId,
          inFlight: inFlightWokenTurns,
          step: "wake_deferred",
        },
        "Wake dispatch: over-bound wake parked pending",
      );
      return;
    }

    // (5) WAKE — transition (persist woken + pendingFrame + hopCount+1), then drive.
    runWake(ev, st);
  }

  function runWake(ev: TerminalInputNeededWake, st: WakeState): void {
    const startMs = deps.nowMs();
    st.dispatchState = "woken";
    st.pendingFrame = ev.requestId;
    st.hopCount += 1;
    persist(ev.sessionId, st);
    inFlightWokenTurns += 1;

    log.info(
      {
        sessionId: ev.sessionId,
        requestId: ev.requestId,
        agentId: ev.owner.agentId,
        hopCount: st.hopCount,
        inFlight: inFlightWokenTurns,
        step: "wake_one_turn",
      },
      "Wake dispatch: waking one turn",
    );

    const turn = deps
      .wakeOneTurn(ev.sessionId, ev.owner)
      .then(() => onWakeSettled(ev.sessionId, startMs, undefined))
      .catch((err: unknown) => onWakeSettled(ev.sessionId, startMs, err));
    trackInflight(turn, `terminal wake dispatch (${ev.sessionId})`);
  }

  function onWakeSettled(sessionId: string, startMs: number, err: unknown): void {
    inFlightWokenTurns = Math.max(0, inFlightWokenTurns - 1);
    const st = states.get(sessionId);
    if (st) {
      // Clear the pending flag so a FRESH frame can wake again; back to idle.
      st.pendingFrame = undefined;
      st.dispatchState = "idle";
      // WR-01: a turn that settled SUCCESSFULLY ends the consecutive wake run, so
      // reset hopCount. `maxHops` is the CONSECUTIVE-wakes-without-progress cap (the
      // loop/recursion guard the "consecutive" docstrings promise) — NOT a lifetime
      // budget (that is the P4 maxInteractions cap). A long-lived session driven
      // through many safe answered prompts must never permanently over-escalate;
      // only an unbroken run of un-settled wakes climbs to the cap. A REJECTED turn
      // (err !== undefined) is NOT progress — leave hopCount climbing so a wedged
      // session still escalates after maxHops consecutive failures.
      if (err === undefined) st.hopCount = 0;
      persist(sessionId, st);
    }
    if (err !== undefined) {
      log.warn(
        {
          sessionId,
          err,
          durationMs: deps.nowMs() - startMs,
          hint: "Woken turn rejected; the frame stays unanswered — a fresh input_needed will re-wake",
          errorKind: "internal" as const,
        },
        "Wake dispatch: woken turn rejected",
      );
    } else {
      log.debug(
        { sessionId, durationMs: deps.nowMs() - startMs, step: "wake_settled" },
        "Wake dispatch: woken turn settled",
      );
    }
    drainPending();
  }

  /** A slot freed — re-evaluate one parked over-bound wake through the full gate. */
  function drainPending(): void {
    if (stopped) return;
    while (
      pendingQueue.length > 0 &&
      inFlightWokenTurns < deps.maxConcurrentAttentionTurns
    ) {
      const next = pendingQueue.shift();
      if (!next) break;
      const before = inFlightWokenTurns;
      handleWake(next);
      // If handleWake did not consume a slot (deduped / dropped / escalated /
      // re-queued), stop to avoid a tight loop re-pushing the same item.
      if (inFlightWokenTurns === before) break;
    }
  }

  function fireEscalation(ev: TerminalInputNeededWake, reason: WakeEscalationReason): void {
    const promise = (async () => {
      try {
        await deps.escalate({ sessionId: ev.sessionId, owner: ev.owner, reason });
      } catch (err) {
        log.warn(
          {
            sessionId: ev.sessionId,
            agentId: ev.owner.agentId,
            err,
            reason,
            hint: "escalate() rejected; the escalation may not reach a human — check the notify chain",
            errorKind: "internal" as const,
          },
          "Wake dispatch: escalate rejected",
        );
      }
    })();
    trackInflight(promise, `terminal wake escalation (${ev.sessionId})`);
  }

  return {
    forgetSession(sessionId: string): void {
      // IN-03/WR-02: reclaim the in-memory FSM state for an ended session. Total +
      // never-throws (Map.delete is a no-op for an unknown id). The durable wake-file
      // + loop-guard ring are reclaimed by the setupTerminalWake end-of-life hook.
      states.delete(sessionId);
    },
    async shutdown(): Promise<void> {
      if (stopped) return;
      stopped = true;
      deps.eventBus.off("terminal:input_needed", onInputNeeded);
      // Wait for any in-flight woken turn / escalation to settle before returning.
      await inflight;
    },
  };
}
