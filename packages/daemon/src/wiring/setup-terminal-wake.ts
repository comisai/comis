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

import { systemNowMs, type TypedEventBus, type ComisLogger, type TimerPort, type TimerHandle } from "@comis/core";
import { createLoopGuard, busyOrHung, type TerminalSessionRegistry, type DriveJournal, type BusySignal } from "@comis/skills/tools";

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
  /**
   * DUR-02 (165-07): the daemon-bound durable journal store — the single persistence
   * point for a PROMOTED drive's rolling journal. The holder persists on every
   * `journal.set` (so a 40h drive's progress survives a daemon restart) and seeds the
   * resumed journal from `load` on a `terminal:drive_reattached` (so a re-attached drive
   * resumes its objective + answered prompts rather than starting over, I10). Optional:
   * ABSENT ⇒ no durable persistence (the Phase-164 in-memory-only behavior, byte-identical
   * I1). The store wraps the `@comis/observability` fs-safe `persistDriveJournal` /
   * `loadDriveJournal` / `removeDriveJournal` bound to `dataDir` (165-07 Task 4); a fake
   * is injected in unit tests. ALL methods best-effort (never throw — the in-memory holder
   * is the runtime source of truth). `remove` is the DISTINCT explicit delete called ONLY
   * on a clean exit/evict, NEVER on a lost/crash (I10 preserve-on-failure).
   */
  driveJournalStore?: DriveJournalStorePort;
  /**
   * LIVE-01 (165-07): the injected TimerPort the coarse liveness BACKSTOP arms its
   * `setInterval(...).unref()` on (mirroring the reaper). The daemon passes
   * `createSystemTimers()` (165-07 Task 4); a test passes a fake. ABSENT (or absent
   * `checkLiveness`) ⇒ NO backstop (the pre-165 event-only behavior, byte-identical I1).
   */
  timers?: TimerPort;
  /**
   * LIVE-01 (165-07): the backstop cadence in ms (`drive.heartbeatMs`, default 90_000). The
   * timer fires this often; on a tick it acts ONLY for a promoted session that has had NO
   * wake within this window (I2 — fires only in the ABSENCE of a wake). Default 90_000.
   */
  heartbeatMs?: number;
  /**
   * LIVE-01 (165-07): the injected SINGLE liveness check the backstop performs on a tick —
   * the worker's `has-session` + `noProgressMs` + the `stuckMs` window (the {@link BusySignal}
   * the pure `busyOrHung` predicate consumes), with NO per-tick SCREEN read (I2 — the
   * signature carries no grid/cursor; the daemon binds it to the registry's `status`
   * round-trip, which returns the worker's CLASSIFIER perception — `working`/`stuck`/`exited` —
   * never the screen bytes). Async: the single check is a worker round-trip, awaited inside the
   * fire-and-forget tick. Receives the owning `agentId` (the backstop resolves it from the
   * per-session bridge) so the daemon binding scopes the registry `status` round-trip. Returns
   * `undefined` for a session that is already gone (the backstop skips it). The daemon (165-07
   * Task 4) binds it; a test injects a fake. ABSENT ⇒ no backstop (I1).
   */
  checkLiveness?: (sessionId: string, agentId: string) => Promise<BusySignal | undefined> | BusySignal | undefined;
  /**
   * LIVE-01 / ENDURE-01 unify (165-07 / I9): the hook the backstop calls on a `"busy"`
   * verdict to advance the session's reaper `lastActivity` — the load-bearing fix for the
   * documented pitfall that `lastActivity` does NOT advance for a quiet-but-busy compile (no
   * tool round-trip lands), so a naive idle reaper would evict a healthy 2h build. The daemon
   * (165-07 Task 4) binds it to the registry handle's `lastActivity`; a test injects a spy.
   * Optional; absent ⇒ the busy verdict is still not-stuck but the reaper unify is inert (I1).
   */
  refreshLastActivity?: (sessionId: string) => void;
  /** Injected clock (no raw global). Default `systemNowMs`. */
  nowMs?: () => number;
  logger: ComisLogger;
}

/**
 * The daemon-bound durable journal store the wake-holder consumes (DUR-02). A thin
 * per-`dataDir` wrapper over the 165-04 `terminal-drive-journal-persistence.ts` module
 * functions, agent-keyed (the holder is daemon-wide; the store is confined per-agent). The
 * daemon (165-07 Task 4) binds the real fs impl; unit tests inject a fake. Every method is
 * best-effort + total (a fault is swallowed inside the impl — the in-memory holder already
 * updated). `remove` is the I10 explicit-only delete (persist/recover/load NEVER delete).
 */
export interface DriveJournalStorePort {
  /** Persist (or overwrite) the journal for a promoted session — the single DUR-02 persistence point. */
  persist(agentId: string, sessionId: string, journal: DriveJournal): void;
  /** Recover all of an agent's persisted journals on boot (keyed by sessionId). */
  recover(agentId: string): Map<string, DriveJournal>;
  /** Load ONE persisted journal (the resume read on a re-attach); undefined when none. */
  load(agentId: string, sessionId: string): DriveJournal | undefined;
  /** Remove a journal file — the DISTINCT explicit delete (clean exit only, NEVER on crash, I10). */
  remove(agentId: string, sessionId: string): void;
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

  // DRIVE-01 (164-06): the closure-local per-session journal holder — a PROMOTED drive's
  // bounded content-free cross-wake memory. Mirrors the loopGuard lifecycle EXACTLY:
  // closure-local, keyed by the bare sessionId, reclaimed in onSessionGone (so a recycled
  // sessionId never inherits a stale journal), bounded over a milestone-length daemon (the
  // journal itself is per-session capped, terminal-drive-journal.ts). The journal SHAPE +
  // pure (de)serialize/cap is the skills sibling (164-01); the daemon owns this holder. This
  // is Phase 165 DUR-02's single durable-persistence point.
  const driveJournals = new Map<string, DriveJournal>();

  // MR-01 (DRIVE-01 / §7.1.6): the closure-local per-session drive-START timestamp — the
  // wall-clock ms a session was PROMOTED (the "drive started" moment, stamped in
  // onDrivePromoted). The woken-turn driver derives the journal's cumulative `elapsedMs` as
  // `now - driveStartedAtMs[sessionId]` (NOT a per-turn delta). Mirrors the driveJournals
  // lifecycle EXACTLY: closure-local, keyed by the bare sessionId, reclaimed in onSessionGone
  // (so a recycled sessionId never inherits a stale start), bounded over a milestone-length
  // daemon. Phase 165 DUR-02 persists it beside the journal so a resumed drive's elapsedMs
  // survives a restart.
  const driveStartedAtMs = new Map<string, number>();

  // DUR-02 (165-07): the per-session owning agentId — the durable journal store is confined
  // PER-AGENT (`<dataDir>/terminal-drive/<agentId>/journals`), but the journal holder + the
  // woken-turn driver key by the BARE sessionId (the worker is owner-agnostic). This map is
  // the bridge: stamped on promotion (onDrivePromoted) + on a re-attach
  // (terminal:drive_reattached), read by the journal.set persist wrapper so each journal
  // lands under its agent's confined dir. Mirrors the driveJournals lifecycle EXACTLY:
  // closure-local, reclaimed in onSessionGone, bounded over a milestone-length daemon.
  const sessionAgent = new Map<string, string>();

  // LIVE-01 (165-07): the per-session wall-clock ms of the LAST wake/transition — the I2 gate
  // the backstop reads. Stamped on EVERY inbound terminal:input_needed (a real fd3 wake AND
  // the backstop's own synthesized stuck — which makes the synth at-most-once per silent
  // stretch). The backstop fires its single liveness check ONLY when `now - lastTransitionMs
  // >= heartbeatMs` (i.e. ONLY in the absence of a wake), so a normally-progressing drive
  // never triggers it. Reclaimed in onSessionGone; bounded over a milestone-length daemon.
  const lastTransitionMs = new Map<string, number>();

  // The §4.4 woken-turn driver the FSM calls.
  const wakeOneTurn = buildWokenTurnDriver({
    registries: deps.registries,
    getTerminalAttentionConfig: deps.getTerminalAttentionConfig,
    loopGuard,
    eventBus: deps.eventBus,
    ...(deps.notify ? { notify: deps.notify } : {}),
    // DRIVE-01: a thin store wrapper over the closure-local Map (the driver engages it ONLY
    // for a promoted, drive-scoped wake; an unpromoted turn touches nothing — I1).
    journal: {
      get: (sessionId: string): DriveJournal | undefined => driveJournals.get(sessionId),
      set: (sessionId: string, j: DriveJournal): void => {
        driveJournals.set(sessionId, j);
        // DUR-02 (165-07): the SINGLE durable persistence point — persist on EVERY set so a
        // 40h drive's rolling journal survives a daemon restart. Gated on a present store +
        // a known owning agent (a promoted session always has one, stamped in onDrivePromoted
        // / on re-attach). Best-effort: the store swallows any fs fault (the in-memory holder
        // already updated — never blocks the woken turn). NEVER deletes (I10).
        const agentId = sessionAgent.get(sessionId);
        if (deps.driveJournalStore && agentId !== undefined) {
          deps.driveJournalStore.persist(agentId, sessionId, j);
        }
      },
    },
    // MR-01: the drive-start accessor (the journal's elapsedMs base). Undefined until the
    // session is promoted — the driver falls back to the turn's own start then (a sane ≥0
    // elapsedMs), so an unpromoted/pre-stamp turn never throws.
    driveStartMs: (sessionId: string): number | undefined => driveStartedAtMs.get(sessionId),
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
    // DUR-02 (165-07): stamp the owning agent so the journal.set persist wrapper can route
    // this session's journal to the agent's confined durable dir (reclaimed in onSessionGone).
    sessionAgent.set(sessionId, agentId);
    // LIVE-01 (165-07): the promotion instant IS a transition — seed lastTransitionMs so a
    // freshly-promoted, not-yet-woken drive is NOT immediately treated as silent-past-heartbeat
    // (the backstop's first tick within heartbeatMs of promotion skips it, I2). A real wake
    // re-stamps it on the next fd3 frame.
    lastTransitionMs.set(sessionId, nowMs());
    // MR-01: stamp the drive-start at the promotion instant — the journal's cumulative
    // elapsedMs measures from here. Stamped once (promote-once gate above), reclaimed in
    // onSessionGone, so a recycled sessionId re-stamps fresh.
    driveStartedAtMs.set(sessionId, nowMs());
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

  // DUR-02 (165-07): RESUME on a re-attach. The registry's recover-on-boot (165-06)
  // re-attached a surviving detached tmux session and emitted the content-free
  // terminal:drive_reattached. The holder consumes it to SEED the resumed drive's journal
  // (objective + last classification + answered prompts + steps tried) from the durable
  // store into the in-memory cache, so the very next woken turn resumes from it rather than
  // starting over or re-answering an already-answered prompt (I10). It also re-stamps the
  // owning agent (so the journal.set persist routes correctly) + the drive-start (so the
  // resumed elapsedMs survives — derived from the journal when present). A genuinely-gone
  // session never reaches here (it is flipped lost, not re-attached). Defensive: validate the
  // structural ids before keying state (T-164-12 parity); a missing store / missing journal
  // is a no-op (a re-attach with nothing persisted simply resumes empty, never a throw).
  const onDriveReattached = (e: { sessionId?: unknown; agentId?: unknown }): void => {
    if (typeof e.sessionId !== "string" || typeof e.agentId !== "string") {
      log.warn(
        { hint: "malformed terminal:drive_reattached payload (missing sessionId/agentId); resume skipped", errorKind: "validation" as const, step: "drive_reattached_dropped" },
        "terminal drive-reattach resume dropped a malformed frame",
      );
      return;
    }
    const { sessionId, agentId } = e;
    sessionAgent.set(sessionId, agentId);
    const resumed = deps.driveJournalStore?.load(agentId, sessionId);
    if (resumed !== undefined) {
      driveJournals.set(sessionId, resumed);
      // The resumed elapsedMs base: re-derive the drive-start from the journal's cumulative
      // elapsedMs so `now - driveStartedAtMs` reconstructs the SAME running total post-restart.
      const elapsed = typeof resumed.elapsedMs === "number" && Number.isFinite(resumed.elapsedMs) && resumed.elapsedMs >= 0 ? resumed.elapsedMs : 0;
      driveStartedAtMs.set(sessionId, nowMs() - elapsed);
    }
    log.info(
      { sessionId, agentId, resumed: resumed !== undefined, step: "drive_reattached" },
      "terminal drive re-attached; journal resumed from durable store",
    );
  };
  deps.eventBus.on("terminal:drive_reattached", onDriveReattached);

  // LIVE-01 (165-07): stamp the per-session last-transition on EVERY inbound wake — the I2
  // gate the backstop reads. A defensive structural-field check (a malformed frame is dropped
  // by the wake adapter anyway; this listener simply ignores it). This includes the backstop's
  // OWN synthesized terminal:input_needed{state:"stuck"}, so a synthesized stuck re-stamps the
  // transition → the backstop fires at most once per silent stretch (never per tick).
  const onWakeTransition = (e: { sessionId?: unknown }): void => {
    if (typeof e.sessionId === "string") lastTransitionMs.set(e.sessionId, nowMs());
  };
  deps.eventBus.on("terminal:input_needed", onWakeTransition);

  // LIVE-01 (165-07): the coarse liveness BACKSTOP timer — a safety net UNDER the event-driven
  // wake (I2: it fires only in the ABSENCE of a wake + resolves to ONE check; NO per-tick
  // screen read). Armed off the injected TimerPort exactly like the reaper
  // (setInterval(...).unref()), gated on BOTH timers + checkLiveness being present (absent ⇒
  // no backstop, the pre-165 event-only behavior, I1). On each tick, for each PROMOTED session
  // (the backstop guards drives, not plain sessions): if a wake landed within heartbeatMs SKIP
  // (a normally-progressing drive never triggers it, Pitfall 7); else run the SINGLE injected
  // checkLiveness (has-session + noProgressMs — NO screen) → busyOrHung:
  //   - "busy" → refreshLastActivity (the ENDURE-01 reaper unify — a quiet-but-busy compile's
  //     lastActivity is refreshed so the idle sweep never evicts it, I9) + NOT stuck.
  //   - "hung" → synthesize a state:"stuck" wake through the EXISTING terminal:input_needed
  //     seam (NOT a new event) + a §2.7 WARN; the stamp above makes this at-most-once per stretch.
  let backstopHandle: TimerHandle | undefined;
  // Process one promoted session's backstop check (async — the liveness check is a worker
  // round-trip). Separated from the loop so a per-session fault is isolated + awaited cleanly.
  const backstopCheckSession = async (sessionId: string, now: number, heartbeatMs: number): Promise<void> => {
    if (!deps.checkLiveness) return;
    // I2: a wake landed within the heartbeat window → a normally-progressing drive; SKIP
    // (no liveness check, no screen read). The backstop fires ONLY in the absence of a wake.
    const lastWake = lastTransitionMs.get(sessionId);
    if (lastWake !== undefined && now - lastWake < heartbeatMs) return;
    // ONE liveness check — has-session + noProgressMs (NO screen, I2). A gone session → skip.
    const agentId = sessionAgent.get(sessionId) ?? "";
    const signal = await deps.checkLiveness(sessionId, agentId);
    if (signal === undefined) return;
    if (busyOrHung(signal) === "busy") {
      // The ENDURE-01 unify (I9): a quiet-but-busy compile is NOT stuck, and its busy verdict
      // refreshes lastActivity so the idle reaper never evicts it for its quietness alone.
      deps.refreshLastActivity?.(sessionId);
      return;
    }
    // "hung": synthesize a stuck wake through the EXISTING seam (the wake adapter translates
    // terminal:input_needed{state:"stuck"} → a stuck-classified woken turn). NOT a new event.
    // The onWakeTransition listener re-stamps lastTransitionMs off this emit → the synth fires
    // at most once per silent stretch (never per tick). `agentId` resolved above.
    deps.eventBus.emit("terminal:input_needed", {
      sessionId,
      agentId,
      state: "stuck",
      reason: "liveness_backstop",
      confidence: "high",
      timestamp: now,
    });
    log.warn(
      { sessionId, agentId, noProgressMs: signal.noProgressMs, hint: "liveness backstop found a promoted drive hung (alive-but-no-progress past the stuck window, or a dead backend); synthesized a stuck for escalation", errorKind: "timeout" as const, step: "liveness_backstop" },
      "terminal liveness backstop synthesized a stuck",
    );
  };
  const runBackstopTick = (): void => {
    if (!deps.checkLiveness) return;
    const now = nowMs();
    const heartbeatMs = deps.heartbeatMs ?? 90_000;
    // Snapshot the promoted set (a synth-stuck-triggered woken turn could mutate it mid-tick).
    for (const sessionId of [...promotedSessions]) {
      // Fire-and-forget per session; isolate a per-session fault so one bad check never throws
      // out of the interval callback (which would be an unhandled rejection). The backstop is a
      // best-effort safety net — a faulting liveness probe degrades to "no check this tick".
      void backstopCheckSession(sessionId, now, heartbeatMs).catch((err: unknown) => {
        log.warn(
          { sessionId, err, hint: "liveness backstop check faulted; skipped this tick (the next tick retries)", errorKind: "resource" as const, step: "liveness_backstop_failed" },
          "terminal liveness backstop check faulted",
        );
      });
    }
  };
  if (deps.timers && deps.checkLiveness) {
    backstopHandle = deps.timers.setInterval(() => runBackstopTick(), deps.heartbeatMs ?? 90_000);
    // .unref() so a pending tick never holds the event loop open on SIGTERM (TimerHandle contract).
    backstopHandle.unref();
  }

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
  //
  // DUR-02 / I10 (165-07): the `durableJournal` disposition gates whether the DURABLE
  // journal file is removed. The IN-MEMORY caches are ALWAYS reclaimed (no leak), but the
  // on-disk journal is removed ONLY on a CLEAN exit/evict (`"remove"`) and PRESERVED on a
  // crash/lost (`"preserve"`) so a genuinely-gone-but-recoverable durable drive keeps its
  // journal for a fresh drive to resume (preserve-on-failure — the whole point of DUR-02).
  const onSessionGone = (sessionId: string, durableJournal: "remove" | "preserve"): void => {
    // Both total/never-throw.
    loopGuard.forget(sessionId);
    dispatcher.forgetSession(sessionId);
    // DRIVE-02 (164-04): reclaim the promoted-state so a recycled sessionId never inherits a
    // stale promotion (mirrors loopGuard.forget — wired to the SAME end-of-life signals below).
    promotedSessions.delete(sessionId);
    // DUR-02 (165-07): reclaim the DURABLE journal file FIRST (while the owning agent is still
    // known) — but ONLY on a clean exit/evict. On a lost/crash it is PRESERVED (I10).
    const agentId = sessionAgent.get(sessionId);
    if (durableJournal === "remove" && deps.driveJournalStore && agentId !== undefined) {
      deps.driveJournalStore.remove(agentId, sessionId); // best-effort (the store swallows faults)
    }
    // DUR-02 (165-07): reclaim the per-session owning-agent bridge (no leak; same lifecycle).
    sessionAgent.delete(sessionId);
    // DRIVE-01 (164-06): reclaim the per-session in-memory journal cache (no per-session memory
    // leak over a milestone-length daemon; a recycled sessionId starts with a fresh journal).
    // NOTE: this drops the in-memory copy only — the DURABLE file is governed above (I10).
    driveJournals.delete(sessionId);
    // MR-01: reclaim the per-session drive-start timestamp alongside the journal (same
    // lifecycle — no leak; a recycled sessionId re-stamps on its next promotion).
    driveStartedAtMs.delete(sessionId);
    // LIVE-01 (165-07): reclaim the per-session last-transition stamp (same lifecycle — no
    // leak; a recycled sessionId starts unstamped so its first wake re-arms the I2 gate).
    lastTransitionMs.delete(sessionId);
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
  // A reaper/operator eviction is a CLEAN end-of-life → remove the durable journal.
  const onEvicted = (e: { sessionId: string }): void => onSessionGone(e.sessionId, "remove");
  const onStateChange = (e: { sessionId: string; state: string }): void => {
    // A clean PTY `exited` removes the durable journal; a `lost` (crash / unrecoverable) is a
    // genuine death whose journal is PRESERVED for a fresh drive to resume (DUR-02 / I10).
    if (e.state === "exited") onSessionGone(e.sessionId, "remove");
    else if (e.state === "lost") onSessionGone(e.sessionId, "preserve");
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
      // DUR-02 (165-07): unsubscribe the re-attach resume consumer too (no leaked listener).
      deps.eventBus.off("terminal:drive_reattached", onDriveReattached);
      // LIVE-01 (165-07): unsubscribe the transition stamp + CANCEL the backstop interval (no
      // leaked listener / timer; a post-shutdown tick never fires).
      deps.eventBus.off("terminal:input_needed", onWakeTransition);
      backstopHandle?.cancel();
      backstopHandle = undefined;
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
