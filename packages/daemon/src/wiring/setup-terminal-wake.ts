// SPDX-License-Identifier: Apache-2.0
/**
 * The daemon-side wake-FSM SUBSCRIBE wiring (124-09 Task 2, THE KEYSTONE; TR-07 /
 * SEC-11 / SEC-12 / OPS-08 / OPS-09) — modeled on `setup-background-completion-runner.ts`.
 *
 * `setupTerminalWake(deps)` makes the attention loop LIVE end-to-end:
 *   1. Constructs the recurring wake-FSM (`createTerminalWakeDispatcher`, 124-07) against
 *      a NARROW adapter bus that translates the daemon's re-published
 *      `terminal:input_needed` (124-09 Task 1) into the FSM's `TerminalInputNeededWake`
 *      (deriving the owner-scoped `owner` + a per-frame `requestId` the redaction-safe
 *      core event omits).
 *   2. Binds `isSessionActive` to the P4 owner-scoped registry (`registries.get(agentId)?
 *      .get(sessionId, owner) !== undefined`) — a wake for a killed/evicted/cross-owner
 *      session is dropped.
 *   3. Binds `wakeOneTurn` to the §4.4 woken-turn driver (`terminal-wake-turn.ts`):
 *      status → read → decideAutoAnswer (safe-only) → send (audited) | escalate, with the
 *      loop-guard (SEC-11) escalating a re-rendered prompt.
 *   4. Binds `escalate` (the FSM's hop-limit path) to a `terminal:escalated` emit + the
 *      NotifyFn chain (§4.7).
 *
 * **Owner derivation (the keystone seam).** The fd3 attention frame is unsolicited and the
 * worker is owner-agnostic, so the re-published `terminal:input_needed` carries `agentId`
 * but neither `sessionKey` nor `requestId`. The forcing use case (spec §4.4) is a top-level
 * agent driving its own session — `sessionKey: ""` (the documented owner fallback,
 * `terminal-session-owner.ts`). We derive `owner = { agentId, sessionKey: "" }`; every
 * registry call the woken turn makes is owner-scoped, so a non-matching owner degrades to
 * the not-found view (never a cross-owner leak). The `requestId` correlation key is
 * synthesized from `(sessionId, reason)` so N re-publishes of ONE unanswered frame coalesce
 * to ONE woken turn (OPS-09), and a distinct subsequent prompt (a fresh `reason`) is a fresh
 * wake.
 *
 * **One-per-daemon** (like the completion runner): subscribes the shared `TypedEventBus`
 * ONCE at startup; `shutdown()` unsubscribes + drains in-flight turns (reverse-order vs the
 * Task-1 emit hook, which is per-agent on the registry).
 *
 * Per AGENTS §2.4: composition root + factories. This wiring lives in `@comis/daemon`; the
 * FSM body (124-07) and the policy modules (124-04) live in `@comis/daemon` / `@comis/skills`.
 *
 * @module
 */

import { systemNowMs, type TypedEventBus, type ComisLogger } from "@comis/core";
import { createLoopGuard, type TerminalSessionRegistry } from "@comis/skills/tools";

import {
  createTerminalWakeDispatcher,
  type TerminalWakeDispatcher,
  type TerminalInputNeededWake,
  type WakeDispatcherBus,
} from "./terminal-wake-dispatch.js";
import { buildWokenTurnDriver, type TerminalAttentionConfig, type WokenTurnNotify } from "./terminal-wake-turn.js";
import { removeWakeStateFile, type PersistedWakeOwner } from "./terminal-wake-persistence.js";
import { driveScopeKeyFor, registryOwnerFor } from "./terminal-drive-scope.js";

/** Dependencies for the keystone wake wiring. */
export interface SetupTerminalWakeDeps {
  /** The daemon's typed event bus (the Task-1 hook publishes `terminal:input_needed` here). */
  eventBus: TypedEventBus;
  /** The per-agent terminal registries map (closure-local in setupTools; the active-check + woken turn read it). */
  registries: ReadonlyMap<string, TerminalSessionRegistry>;
  /**
   * Resolve the per-agent attention config (operator allow-entry derived: autoAnswer /
   * hintPatterns + the wake-FSM hop / concurrency caps). Read PER agentId so a
   * `config:mutated` swap takes effect on the next wake. Absent for an agent ⇒ the woken
   * turn escalates `no_safe_match` (the SAFE default).
   */
  getTerminalAttentionConfig: (agentId: string) => TerminalAttentionConfig | undefined;
  /** The human-escalation NotifyFn (§4.7). Optional; absent ⇒ bus-only escalation audit. */
  notify?: WokenTurnNotify;
  /** Base data dir (~/.comis) — the FSM's durable wake-state lives under `terminal-wake/`. */
  dataDir: string;
  /** Injected clock (no raw global). Default `systemNowMs`. */
  nowMs?: () => number;
  logger: ComisLogger;
}

/** The handle the composition root keeps for shutdown. */
export interface TerminalWakeContext {
  /** Unsubscribe from the bus + drain in-flight woken turns. Idempotent, awaitable. */
  shutdown(): Promise<void>;
}

/**
 * Wire the wake-FSM against the daemon event bus. Call ONCE at daemon startup (after the
 * terminal registries map + the notify chain exist). Returns a `shutdown` for the
 * composition root to thread into `setupShutdown`.
 */
export function setupTerminalWake(deps: SetupTerminalWakeDeps): TerminalWakeContext {
  const nowMs = deps.nowMs ?? systemNowMs;
  const log = deps.logger.child({ submodule: "setup-terminal-wake" });

  // Default hop / concurrency caps for the FSM construction. The PER-WAKE owner-config
  // (getTerminalAttentionConfig) governs the auto-answer policy; the FSM-level caps are
  // a conservative daemon ceiling (the woken turn cannot widen them).
  const DEFAULT_MAX_HOPS = 8;
  const DEFAULT_MAX_CONCURRENT = 4;

  // The shared loop-guard (SEC-11) — closure-local per-session ring, injected clock. One
  // instance across woken turns so a re-rendered prompt is caught across frames.
  const loopGuard = createLoopGuard({ nowMs });

  // DRIVE-02 (164-04): the closure-local promoted-session set — the daemon owns the
  // promotion STATE (the skills wait tool only EMITS the content-free terminal:drive_promoted;
  // it never reaches into daemon state — the layer-inversion the arch gate forbids). Mirrors
  // the loopGuard lifecycle exactly: closure-local, reclaimed in onSessionGone (so a recycled
  // sessionId never inherits a stale promotion), bounded over a milestone-length daemon. It is
  // the promote-once dedupe: the skills tool emits per-qualifying-wait, this Set collapses
  // repeated emits for one session to ONE drive-started notify. A plain Set suffices (record
  // + notify-once); 164-06 reads promotedSessions here (via driveScopeKey below) to flip the
  // drive-scope sessionKey for a promoted session's woken turns.
  const promotedSessions = new Set<string>();

  // DRIVE-01 (164-06): the drive-scope attribution key for a session's woken turns. A
  // PROMOTED session routes to `drive:<sessionId>` (isolating its woken turns from the
  // primary `sessionKey:""` conversation); an unpromoted session stays on `""` (today's
  // inline path — byte-identical, I1). This is ONLY the FSM/journal/conversation attribution
  // key — `registryOwnerFor` strips it back to the stamped registry owner for every registry
  // call (the I5 anchor), so the drive scope never changes which jail/allow-entry resolves.
  const driveScopeKey = (sessionId: string): string => driveScopeKeyFor(sessionId, promotedSessions.has(sessionId));

  // The §4.4 woken-turn driver the FSM calls.
  const wakeOneTurn = buildWokenTurnDriver({
    registries: deps.registries,
    getTerminalAttentionConfig: deps.getTerminalAttentionConfig,
    loopGuard,
    eventBus: deps.eventBus,
    ...(deps.notify ? { notify: deps.notify } : {}),
    nowMs,
    logger: deps.logger,
  });

  // The owner-scoped active-check (the P4 registry). A wake for a session this reports
  // false (killed/evicted/cross-owner) is dropped + audited by the FSM.
  //
  // DRIVE-01 (164-06): resolve via `registryOwnerFor(owner)` — the STAMPED registry owner.
  // A promoted session's wake owner carries `drive:<id>`; passing that raw to `registry.get`
  // would mismatch the stamped owner (`sameOwner`), report the session inactive, and DROP
  // its wakes — the I9-class silent strand (T-164-23). The strip resolves the live session,
  // so a promoted drive's wakes are NOT dropped.
  const isSessionActive = (sessionId: string, owner: PersistedWakeOwner): boolean => {
    const registry = deps.registries.get(owner.agentId);
    if (!registry) return false;
    return registry.get(sessionId, registryOwnerFor(owner)) !== undefined;
  };

  // The hop-limit escalation (the FSM's forced-escalation path) → emit terminal:escalated
  // + the NotifyFn chain. (The woken-turn driver owns the per-turn auto-answer escalations;
  // this is the FSM's structural hop_limit path.)
  const escalate = async (opts: { sessionId: string; owner: PersistedWakeOwner; reason: "hop_limit" }): Promise<void> => {
    deps.eventBus.emit("terminal:escalated", { sessionId: opts.sessionId, agentId: opts.owner.agentId, reason: opts.reason, timestamp: nowMs() });
    log.warn(
      { sessionId: opts.sessionId, agentId: opts.owner.agentId, reason: opts.reason, hint: "wake hop-limit reached; escalating to a human", errorKind: "precondition" as const, step: "wake_hop_limit" },
      "terminal wake hop-limit escalation",
    );
    if (deps.notify) {
      await deps.notify({
        agentId: opts.owner.agentId,
        message: `Terminal session ${opts.sessionId} hit the wake hop-limit and needs a human.`,
        priority: "normal",
        origin: "background_task",
      });
    }
  };

  // DRIVE-02 (164-04): consume the skills wait tool's content-free terminal:drive_promoted.
  // The skills layer emits per-qualifying-wait; the daemon collapses to ONE "drive started
  // (backgrounded)" notify per session (promote-once via the promotedSessions Set). This is a
  // PROMOTION, not an escalation — it uses the WokenTurnNotify chain (origin:background_task),
  // NOT escalate(). WR-03/T-164-12: defensively validate the structural fields the Set keys on
  // (sessionId/agentId) and DROP a malformed payload with a WARN — never key state on garbage.
  const onDrivePromoted = (e: { sessionId?: unknown; agentId?: unknown; reason?: unknown }): void => {
    if (typeof e.sessionId !== "string" || typeof e.agentId !== "string") {
      log.warn(
        { hint: "malformed terminal:drive_promoted payload (missing sessionId/agentId); promotion dropped", errorKind: "validation" as const, step: "drive_promoted_dropped" },
        "terminal drive-promotion dropped a malformed frame",
      );
      return;
    }
    const { sessionId, agentId } = e;
    const reason = e.reason === "mode_detached" ? "mode_detached" : "producing";
    if (promotedSessions.has(sessionId)) return; // promote-once — the daemon dedupe.
    promotedSessions.add(sessionId);
    log.info(
      { sessionId, agentId, reason, step: "drive_promoted" },
      "terminal drive promoted to a backgrounded drive-owner",
    );
    if (deps.notify) {
      // Fire-and-forget on this synchronous bus listener; a notify fault must never become an
      // uncaughtException that crashes the daemon. The message is STRUCTURAL only (session id +
      // "background") — no screen text/secrets (I3).
      void deps
        .notify({
          agentId,
          message: `Terminal drive for session ${sessionId} is now running in the background.`,
          priority: "normal",
          origin: "background_task",
        })
        .catch((err: unknown) => {
          log.warn(
            { sessionId, agentId, err, hint: "drive-started notification failed; the drive continues (bus-only)", errorKind: "resource" as const, step: "drive_promoted_notify_failed" },
            "terminal drive-started notification failed",
          );
        });
    }
  };
  deps.eventBus.on("terminal:drive_promoted", onDrivePromoted);

  const dispatcher: TerminalWakeDispatcher = createTerminalWakeDispatcher({
    eventBus: makeWakeAdapterBus(deps.eventBus, log, driveScopeKey),
    isSessionActive,
    wakeOneTurn,
    escalate,
    dataDir: deps.dataDir,
    maxHops: DEFAULT_MAX_HOPS,
    maxConcurrentAttentionTurns: DEFAULT_MAX_CONCURRENT,
    nowMs,
    logger: deps.logger,
  });

  // WR-02 (+ IN-03/IN-04): reclaim ALL per-session attention state on end-of-life so
  // a milestone-length daemon never leaks the loop-guard ring, the durable wake-state
  // file, or the FSM in-memory state. Wired to the SAME eviction/exit signals the P4
  // reaper + the fd3 PTY-exit hook already publish (setup-terminal-tools.ts).
  const onSessionGone = (sessionId: string): void => {
    // Both total/never-throw.
    loopGuard.forget(sessionId);
    dispatcher.forgetSession(sessionId);
    // DRIVE-02 (164-04): reclaim the promoted-state so a recycled sessionId never inherits a
    // stale promotion (mirrors loopGuard.forget — wired to the SAME end-of-life signals below).
    promotedSessions.delete(sessionId);
    // removeWakeStateFile re-raises a non-ENOENT fs fault (@allow-throw) — wrap it so a
    // cleanup failure inside this bus listener can NEVER become an uncaughtException that
    // crashes the daemon (IN-04). Surface the fault to the log with an actionable hint.
    try {
      removeWakeStateFile(deps.dataDir, sessionId);
    } catch (err) {
      log.warn(
        { sessionId, err, hint: "could not remove wake-state file on session end-of-life; it will be dropped on the next boot's first wake", errorKind: "resource" as const, step: "wake_cleanup_failed" },
        "terminal wake-state cleanup failed",
      );
    }
  };
  const onEvicted = (e: { sessionId: string }): void => onSessionGone(e.sessionId);
  const onStateChange = (e: { sessionId: string; state: string }): void => {
    if (e.state === "exited" || e.state === "lost") onSessionGone(e.sessionId);
  };
  deps.eventBus.on("terminal:session_evicted", onEvicted);
  deps.eventBus.on("terminal:session_state", onStateChange);

  log.info({ step: "terminal_wake_subscribed" }, "terminal wake-dispatch FSM subscribed");

  return {
    async shutdown(): Promise<void> {
      deps.eventBus.off("terminal:session_evicted", onEvicted);
      deps.eventBus.off("terminal:session_state", onStateChange);
      // DRIVE-02 (164-04): unsubscribe the promotion consumer (no leaked listener; a
      // post-shutdown emit drives no notify).
      deps.eventBus.off("terminal:drive_promoted", onDrivePromoted);
      await dispatcher.shutdown();
    },
  };
}

/**
 * Adapt the daemon `TypedEventBus`'s redaction-safe `terminal:input_needed` event into the
 * FSM's narrow `WakeDispatcherBus` carrying `TerminalInputNeededWake`. Derives the
 * owner-scoped `owner` + a per-frame `requestId` synthesized from `(sessionId, reason)` (the
 * redaction-safe core event omits requestId; the FSM's `(sessionId,requestId)` dedupe
 * correlation needs it). N re-publishes of ONE unanswered frame share a `requestId` →
 * coalesce to ONE woken turn (OPS-09); a distinct subsequent prompt (a fresh `reason`) is a
 * fresh wake.
 *
 * DRIVE-01 (164-06): the woken-turn owner's `sessionKey` is derived via `driveScopeKey` — a
 * PROMOTED session routes to `drive:<sessionId>` (isolating its woken turns from the primary
 * `sessionKey:""` conversation), an unpromoted one stays on `""` (the forcing-use-case
 * fallback, today's path). This is ONLY the FSM/journal/conversation attribution; the
 * woken-turn driver + the active-check strip it back to the stamped registry owner
 * (`registryOwnerFor`) so the drive scope never changes which jail/allow-entry resolves (I5).
 *
 * The translating handler is wrapped 1:1 so `off` removes exactly the wrapper `on` added —
 * a per-(handler) WeakMap pairs the FSM's handler with our wrapper (no module-global state).
 *
 * WR-03: this is the one inbound seam that previously trusted the bus payload's shape
 * blindly. Every other untrusted-boundary reader in this phase is defensively coded, so
 * this one VALIDATES the structural fields the FSM keys on (`sessionId`/`agentId`) BEFORE
 * the cast and DROPS a malformed frame with a WARN — never keying FSM state on
 * `"undefined:undefined"` or masking a future-emit-site bug as a silently-dropped wake.
 */
function makeWakeAdapterBus(
  bus: TypedEventBus,
  log: ComisLogger,
  driveScopeKey: (sessionId: string) => string,
): WakeDispatcherBus {
  const wrappers = new WeakMap<(data: TerminalInputNeededWake) => void, (data: unknown) => void>();
  return {
    on(_event: "terminal:input_needed", handler: (data: TerminalInputNeededWake) => void): void {
      const wrapped = (data: unknown): void => {
        const ev = data as Partial<{ sessionId: string; agentId: string; state: "awaiting-input" | "stuck"; reason: string }>;
        // WR-03: validate the shape before trusting it. A frame missing the structural
        // correlation keys is dropped (defense-in-depth) — not forwarded with garbage.
        if (typeof ev.sessionId !== "string" || typeof ev.agentId !== "string") {
          log.warn(
            { hint: "malformed terminal:input_needed payload (missing sessionId/agentId); wake dropped", errorKind: "validation" as const, step: "wake_adapter_dropped" },
            "terminal wake adapter dropped a malformed frame",
          );
          return;
        }
        const reason = typeof ev.reason === "string" ? ev.reason : "input_needed";
        handler({
          sessionId: ev.sessionId,
          // The redaction-safe core event omits requestId; correlate by (sessionId, reason)
          // so duplicate re-publishes of one frame coalesce, a fresh prompt re-wakes.
          requestId: `${ev.sessionId}:${reason}`,
          // DRIVE-01: drive:<id> for a promoted session (isolated woken-turn attribution),
          // "" otherwise (the forcing-use-case fallback). The registry owner is stripped
          // back to the stamped owner downstream (registryOwnerFor) — I5 by construction.
          owner: { agentId: ev.agentId, sessionKey: driveScopeKey(ev.sessionId) },
          state: ev.state === "stuck" ? "stuck" : "awaiting-input",
          reason,
        });
      };
      wrappers.set(handler, wrapped);
      bus.on("terminal:input_needed", wrapped);
    },
    off(_event: "terminal:input_needed", handler: (data: TerminalInputNeededWake) => void): void {
      const wrapped = wrappers.get(handler);
      if (wrapped) {
        bus.off("terminal:input_needed", wrapped);
        wrappers.delete(handler);
      }
    },
  };
}
