// SPDX-License-Identifier: Apache-2.0
/**
 * The daemon-side wake-FSM subscribe wiring — modeled on `setup-background-completion-runner.ts`.
 *
 * `setupTerminalWake(deps)` makes the attention loop live end-to-end:
 *   1. Constructs the recurring wake-FSM (`createTerminalWakeDispatcher`) against
 *      a narrow adapter bus that translates the daemon's re-published
 *      `terminal:input_needed` into the FSM's `TerminalInputNeededWake`
 *      (deriving the owner-scoped `owner` + a per-frame `requestId` the redaction-safe
 *      core event omits).
 *   2. Binds `isSessionActive` to the owner-scoped registry (`registries.get(agentId)?
 *      .get(sessionId, owner) !== undefined`) — a wake for a killed/evicted/cross-owner
 *      session is dropped.
 *   3. Binds `wakeOneTurn` to the woken-turn driver (`terminal-wake-turn.ts`):
 *      status → read → decideAutoAnswer (safe-only) → send (audited) | escalate, with the
 *      loop-guard escalating a re-rendered prompt.
 *   4. Binds `escalate` (the FSM's hop-limit path) to a `terminal:escalated` emit + the
 *      NotifyFn chain.
 *
 * **Owner derivation (the central seam).** The fd3 attention frame is unsolicited and the
 * worker is owner-agnostic, so the re-published `terminal:input_needed` carries `agentId`
 * but neither `sessionKey` nor `requestId`. The wake `owner = { agentId, sessionKey }` is the
 * AGENT-TURN identity; the REGISTRY owner (status/read/send/active-check) is RECOVERED from the
 * session's STAMPED owner via `registry.getOwner` (a channel/API drive is stamped
 * under `(userId, sessionKey)`, which the re-publish drops), so a DETACHED drive's woken turns
 * resolve the LIVE session instead of dropping cross-owner. The `requestId` correlation key is
 * synthesized from `(sessionId, reason)` so N re-publishes of ONE unanswered frame coalesce
 * to ONE woken turn, and a distinct subsequent prompt (a fresh `reason`) is a fresh
 * wake.
 *
 * **One-per-daemon** (like the completion runner): subscribes the shared `TypedEventBus`
 * ONCE at startup; `shutdown()` unsubscribes + drains in-flight turns (reverse-order vs the
 * emit hook, which is per-agent on the registry).
 *
 * Per AGENTS §2.4: composition root + factories. This wiring lives in `@comis/daemon`; the
 * FSM body and the policy modules live in `@comis/daemon` / `@comis/skills`.
 *
 * @module
 */

import { systemNowMs, type TypedEventBus, type ComisLogger, type TimerPort, type TimerHandle } from "@comis/core";
import { createLoopGuard, type TerminalSessionRegistry, type DriveJournal, type NotifyPolicy, type EvictReason } from "@comis/skills/tools";

import {
  createTerminalWakeDispatcher,
  type TerminalWakeDispatcher,
  type TerminalInputNeededWake,
  type WakeDispatcherBus,
} from "./terminal-wake-dispatch.js";
import { buildWokenTurnDriver, type TerminalAttentionConfig, type WokenTurnNotify } from "./terminal-wake-turn.js";
import { removeWakeStateFile, type PersistedWakeOwner } from "./terminal-wake-persistence.js";
import { driveScopeKeyFor, registryOwnerFor } from "./terminal-drive-scope.js";
import { emitTerminalOutcome, runHeartbeatTick, runBackstopSessionCheck, shouldFailOnLost, type TerminalNotifyDeps } from "./terminal-wake-notify.js";
import type { LivenessSignal } from "./terminal-wake-types.js";

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
  /** The human-escalation NotifyFn. Optional; absent ⇒ bus-only escalation audit. */
  notify?: WokenTurnNotify;
  /** Base data dir (~/.comis) — the FSM's durable wake-state lives under `terminal-wake/`. */
  dataDir: string;
  /**
   * The daemon-bound durable journal store — the single persistence
   * point for a PROMOTED drive's rolling journal. The holder persists on every
   * `journal.set` (so a multi-hour drive's progress survives a daemon restart) and seeds the
   * resumed journal from `load` on a `terminal:drive_reattached` (so a re-attached drive
   * resumes its objective + answered prompts rather than starting over). Optional:
   * ABSENT ⇒ no durable persistence (in-memory-only, byte-identical to the store-present
   * path when nothing is persisted). The store wraps the `@comis/observability` fs-safe
   * `persistDriveJournal` / `loadDriveJournal` / `removeDriveJournal` bound to `dataDir`; a fake
   * is injected in unit tests. ALL methods best-effort (never throw — the in-memory holder
   * is the runtime source of truth). `remove` is the DISTINCT explicit delete called ONLY
   * on a clean exit/evict, NEVER on a lost/crash (preserve-on-failure so a fresh drive can resume).
   */
  driveJournalStore?: DriveJournalStorePort;
  /**
   * The injected TimerPort the coarse liveness BACKSTOP arms its
   * `setInterval(...).unref()` on (mirroring the reaper). The daemon passes
   * `createSystemTimers()`; a test passes a fake. ABSENT (or absent
   * `checkLiveness`) ⇒ NO backstop (event-only behavior, byte-identical when the timer is absent).
   */
  timers?: TimerPort;
  /**
   * The backstop cadence in ms (`drive.heartbeatMs`, default 90_000). The
   * timer fires this often; on a tick it acts ONLY for a promoted session that has had NO
   * wake within this window (fires only in the ABSENCE of a wake). Default 90_000.
   */
  heartbeatMs?: number;
  /**
   * The injected SINGLE liveness check the backstop performs on a tick —
   * the worker's `has-session` + `noProgressMs` + the `stuckMs` window (the {@link LivenessSignal}
   * the pure `busyOrHung` predicate consumes; `awaitingInput` rides it for the completion
   * notification), with NO per-tick SCREEN read (the
   * signature carries no grid/cursor; the daemon binds it to the registry's `status`
   * round-trip, which returns the worker's CLASSIFIER perception — `working`/`stuck`/`exited` —
   * never the screen bytes). Async: the single check is a worker round-trip, awaited inside the
   * fire-and-forget tick. Receives the owning `agentId` (the backstop resolves it from the
   * per-session bridge) so the daemon binding scopes the registry `status` round-trip. Returns
   * `undefined` for a session that is already gone (the backstop skips it). The daemon
   * binds it; a test injects a fake. ABSENT ⇒ no backstop.
   */
  checkLiveness?: (sessionId: string, agentId: string) => Promise<LivenessSignal | undefined> | LivenessSignal | undefined;
  /**
   * The operator `drive.notify` policy that gates the user-facing
   * `done`/`failed` outcome notifications (a `needs-you` escalation is NEVER gated — it rides
   * the existing escalate() path). `"terminal"` (default) + `"all"` fire `done`/`failed`;
   * `"none"` suppresses them (the escalation still fires). Resolved per-daemon from the default
   * agent's `drive` block (terminal-durable-wiring.ts). Default `"terminal"`.
   */
  notifyPolicy?: NotifyPolicy;
  /**
   * The COARSE user-facing heartbeat cadence in ms (`drive.heartbeatNotifyMs`,
   * default 3_600_000 / 1h). A SECOND timer (distinct from the internal backstop's
   * `heartbeatMs`) fires this often; on a tick it emits a content-free progress digest for each
   * PROMOTED drive due at the cadence. `0` ⇒ terminal-only (the timer is NEVER armed). The timer
   * is also NOT armed under `notifyPolicy:"none"` (the heartbeat is a non-escalation notification).
   * Default 3_600_000.
   */
  heartbeatNotifyMs?: number;
  /** The operator per-drive spend ceiling (`drive.maxCostUsd`), `null` = uncapped (default). FORWARDED to the woken-turn driver below; the lone consumer STOPS+escalates a breach (see {@link WokenTurnDriverDeps.maxCostUsd}). */
  maxCostUsd?: number | null;
  // NO refreshLastActivity dep — checkLiveness's `registry.status`
  // round-trip already stamps the handle's lastActivity (the registry status side effect), so a
  // busy verdict's liveness check IS the idle-reaper liveness stamp. A separate refresh
  // hook would double-stamp what status already does (dead weight), so it was removed.
  /** Injected clock (no raw global). Default `systemNowMs`. */
  nowMs?: () => number;
  logger: ComisLogger;
}

/**
 * The daemon-bound durable journal store the wake-holder consumes. A thin
 * per-`dataDir` wrapper over the `terminal-drive-journal-persistence.ts` module
 * functions, agent-keyed (the holder is daemon-wide; the store is confined per-agent). The
 * daemon binds the real fs impl; unit tests inject a fake. Every method is
 * best-effort + total (a fault is swallowed inside the impl — the in-memory holder already
 * updated). `remove` is the explicit-only delete (persist/recover/load NEVER delete).
 */
export interface DriveJournalStorePort {
  /** Persist (or overwrite) the journal for a promoted session — the single persistence point. */
  persist(agentId: string, sessionId: string, journal: DriveJournal): void;
  /**
   * Load ONE persisted journal — the resume read. The holder calls it
   * LAZILY on the first woken turn of a recovered/promoted session whose in-memory
   * journal is empty (order-independent, so the boot-time
   * `terminal:drive_reattached` event is NOT load-bearing for resume). `undefined`
   * when no journal is persisted. There is deliberately NO bulk `recover(agentId)`
   * (the resume design reads one journal per re-attach).
   */
  load(agentId: string, sessionId: string): DriveJournal | undefined;
  /** Remove a journal file — the DISTINCT explicit delete (clean exit only, NEVER on crash). */
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

  // The resolved drive.notify policy (default "terminal").
  const notifyPolicy: NotifyPolicy = deps.notifyPolicy ?? "terminal";
  // The structural notify/log/clock/policy bundle the extracted emit helper consumes
  // (terminal-wake-notify.ts) — keeps the holder thin (the gating + the structured log record live there).
  const notifyDeps: TerminalNotifyDeps = {
    ...(deps.notify ? { notify: deps.notify } : {}),
    info: (obj, msg) => log.info(obj, msg),
    warn: (obj, msg) => log.warn(obj, msg),
    nowMs,
    policy: notifyPolicy,
  };

  // Default hop / concurrency caps for the FSM construction. The PER-WAKE owner-config
  // (getTerminalAttentionConfig) governs the auto-answer policy; the FSM-level caps are
  // a conservative daemon ceiling (the woken turn cannot widen them).
  const DEFAULT_MAX_HOPS = 8;
  const DEFAULT_MAX_CONCURRENT = 4;

  // The shared loop-guard — closure-local per-session ring, injected clock. One
  // instance across woken turns so a re-rendered prompt is caught across frames.
  const loopGuard = createLoopGuard({ nowMs });

  // The closure-local promoted-session set — the daemon owns the
  // promotion STATE (the skills wait tool only EMITS the content-free terminal:drive_promoted;
  // it never reaches into daemon state — the layer inversion the arch gate forbids). Mirrors
  // the loopGuard lifecycle exactly: closure-local, reclaimed in onSessionGone (so a recycled
  // sessionId never inherits a stale promotion), bounded over a long-running daemon. It is
  // the promote-once dedupe: the skills tool emits per-qualifying-wait, this Set collapses
  // repeated emits for one session to ONE drive-started notify. A plain Set suffices (record
  // + notify-once); the drive-scope key below reads promotedSessions to flip the
  // drive-scope sessionKey for a promoted session's woken turns.
  const promotedSessions = new Set<string>();
  // The once-per-idle-stretch completion-notification latch. The backstop adds a
  // promoted session here when it FIRST observes it awaiting-input (finished its work + idle at the
  // prompt) and delivers the "drive finished — waiting for input" notification; the latch is cleared
  // when the drive resumes working, so a fresh idle after the user replies re-notifies. Reclaimed
  // on end-of-life alongside promotedSessions.
  const completionNotified = new Set<string>();

  // The drive-scope attribution key for a session's woken turns. A
  // PROMOTED session routes to `drive:<sessionId>` (isolating its woken turns from the
  // primary `sessionKey:""` conversation); an unpromoted session stays on `""` (the
  // inline path — byte-identical). This is ONLY the FSM/journal/conversation attribution
  // key — `registryOwnerFor` strips it back to the stamped registry owner for every registry
  // call, so the drive scope never changes which jail/allow-entry resolves.
  const driveScopeKey = (sessionId: string): string => driveScopeKeyFor(sessionId, promotedSessions.has(sessionId));

  // The closure-local per-session journal holder — a PROMOTED drive's
  // bounded content-free cross-wake memory. Mirrors the loopGuard lifecycle EXACTLY:
  // closure-local, keyed by the bare sessionId, reclaimed in onSessionGone (so a recycled
  // sessionId never inherits a stale journal), bounded over a long-running daemon (the
  // journal itself is per-session capped, terminal-drive-journal.ts). The journal SHAPE +
  // pure (de)serialize/cap is the skills sibling; the daemon owns this holder. This
  // is the single durable-persistence point.
  const driveJournals = new Map<string, DriveJournal>();

  // The closure-local per-session drive-START timestamp — the
  // wall-clock ms a session was PROMOTED (the "drive started" moment, stamped in
  // onDrivePromoted). The woken-turn driver derives the journal's cumulative `elapsedMs` as
  // `now - driveStartedAtMs[sessionId]` (NOT a per-turn delta). Mirrors the driveJournals
  // lifecycle EXACTLY: closure-local, keyed by the bare sessionId, reclaimed in onSessionGone
  // (so a recycled sessionId never inherits a stale start), bounded over a long-running
  // daemon. It is persisted beside the journal so a resumed drive's elapsedMs
  // survives a restart.
  const driveStartedAtMs = new Map<string, number>();

  // The per-session owning agentId — the durable journal store is confined
  // PER-AGENT (`<dataDir>/terminal-drive/<agentId>/journals`), but the journal holder + the
  // woken-turn driver key by the BARE sessionId (the worker is owner-agnostic). This map is
  // the bridge: stamped on promotion (onDrivePromoted) + on a re-attach
  // (terminal:drive_reattached), read by the journal.set persist wrapper so each journal
  // lands under its agent's confined dir. Mirrors the driveJournals lifecycle EXACTLY:
  // closure-local, reclaimed in onSessionGone, bounded over a long-running daemon.
  const sessionAgent = new Map<string, string>();

  // The per-session wall-clock ms of the LAST wake/transition — the gate
  // the backstop reads. Stamped on EVERY inbound terminal:input_needed (a real fd3 wake AND
  // the backstop's own synthesized stuck — which makes the synth at-most-once per silent
  // stretch). The backstop fires its single liveness check ONLY when `now - lastTransitionMs
  // >= heartbeatMs` (i.e. ONLY in the absence of a wake), so a normally-progressing drive
  // never triggers it. Reclaimed in onSessionGone; bounded over a long-running daemon.
  const lastTransitionMs = new Map<string, number>();

  // The per-session wall-clock ms of the LAST user-facing heartbeat sent —
  // the coarse-cadence dedupe stamp. The heartbeat tick fires for a promoted session only when
  // `now - lastHeartbeatSentMs >= heartbeatNotifyMs`, then stamps it. Mirrors lastTransitionMs's
  // lifecycle EXACTLY: closure-local, reclaimed in onSessionGone (a recycled sessionId starts
  // unstamped → its first due-check fires from 0), bounded over a long-running daemon.
  const lastHeartbeatSentMs = new Map<string, number>();

  // The per-session "lazy-seed attempted this daemon life" marker. The
  // registry's recover-on-boot emits terminal:drive_reattached during the boot sweep
  // BEFORE this holder subscribes, so that event is DROPPED on the boot path — making the
  // resume non-load-bearing on the event. The robust fix is order-independent: on the FIRST
  // wake of a session whose in-memory journal is empty, the holder LAZY-LOADS the durable
  // journal (`maybeSeedRecoveredDrive`). This Set bounds that to ONE disk read per session
  // per life (a plain, never-recovered session pays one no-op load on its first wake, never
  // again). Reclaimed in onSessionGone; bounded over a long-running daemon.
  const seedAttempted = new Set<string>();

  // The woken-turn driver the FSM calls.
  const wakeOneTurn = buildWokenTurnDriver({
    registries: deps.registries,
    getTerminalAttentionConfig: deps.getTerminalAttentionConfig,
    loopGuard,
    eventBus: deps.eventBus,
    ...(deps.notify ? { notify: deps.notify } : {}),
    // A thin store wrapper over the closure-local Map (the driver engages it ONLY
    // for a promoted, drive-scoped wake; an unpromoted turn touches nothing).
    journal: {
      get: (sessionId: string): DriveJournal | undefined => driveJournals.get(sessionId),
      set: (sessionId: string, j: DriveJournal): void => {
        driveJournals.set(sessionId, j);
        // The SINGLE durable persistence point — persist on EVERY set so a
        // multi-hour drive's rolling journal survives a daemon restart. Gated on a present store +
        // a known owning agent (a promoted session always has one, stamped in onDrivePromoted
        // / on re-attach). Best-effort: the store swallows any fs fault (the in-memory holder
        // already updated — never blocks the woken turn). NEVER deletes.
        const agentId = sessionAgent.get(sessionId);
        if (deps.driveJournalStore && agentId !== undefined) {
          deps.driveJournalStore.persist(agentId, sessionId, j);
        }
      },
    },
    // The drive-start accessor (the journal's elapsedMs base). Undefined until the
    // session is promoted — the driver falls back to the turn's own start then (a sane ≥0
    // elapsedMs), so an unpromoted/pre-stamp turn never throws.
    driveStartMs: (sessionId: string): number | undefined => driveStartedAtMs.get(sessionId),
    maxCostUsd: deps.maxCostUsd, // forward the operator spend ceiling to checkSpendCeiling.
    nowMs,
    logger: deps.logger,
  });

  // The owner-scoped active-check. A wake for a session this reports
  // false (killed/evicted/cross-owner) is dropped + audited by the FSM.
  //
  // Resolve via `registryOwnerFor(owner)` — the STAMPED registry owner.
  // A promoted session's wake owner carries `drive:<id>`; passing that raw to `registry.get`
  // would mismatch the stamped owner (`sameOwner`), report the session inactive, and DROP
  // its wakes — a silent strand. The strip resolves the live session,
  // so a promoted drive's wakes are NOT dropped.
  const isSessionActive = (sessionId: string, owner: PersistedWakeOwner): boolean => {
    const registry = deps.registries.get(owner.agentId);
    if (!registry) return false;
    // Recover the STAMPED owner (getOwner) the worker→event re-publish drops, so a channel/API drive's live wake is not falsely dropped cross-owner; fall back to the owner-scoped get.
    return registry.getOwner?.(sessionId) !== undefined || registry.get(sessionId, registryOwnerFor(owner)) !== undefined;
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

  // Consume the skills wait tool's content-free terminal:drive_promoted.
  // The skills layer emits per-qualifying-wait; the daemon collapses to ONE "drive started
  // (backgrounded)" notify per session (promote-once via the promotedSessions Set). This is a
  // PROMOTION, not an escalation — it uses the WokenTurnNotify chain (origin:background_task),
  // NOT escalate(). Defensively validate the structural fields the Set keys on
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
    // Stamp the owning agent so the journal.set persist wrapper can route
    // this session's journal to the agent's confined durable dir (reclaimed in onSessionGone).
    sessionAgent.set(sessionId, agentId);
    // The promotion instant IS a transition — seed lastTransitionMs so a
    // freshly-promoted, not-yet-woken drive is NOT immediately treated as silent-past-heartbeat
    // (the backstop's first tick within heartbeatMs of promotion skips it). A real wake
    // re-stamps it on the next fd3 frame.
    lastTransitionMs.set(sessionId, nowMs());
    // Stamp the drive-start at the promotion instant — the journal's cumulative
    // elapsedMs measures from here. Stamped once (promote-once gate above), reclaimed in
    // onSessionGone, so a recycled sessionId re-stamps fresh.
    driveStartedAtMs.set(sessionId, nowMs());
    // Seed the heartbeat dedupe stamp at promotion (mirroring lastTransitionMs)
    // so the FIRST user heartbeat lands one full cadence AFTER promotion — not seconds after (an
    // unstamped session reads `last:0` ⇒ `now-0 >= cadence` fires on the first tick: "elapsed 0.0h").
    lastHeartbeatSentMs.set(sessionId, nowMs());
    log.info(
      { sessionId, agentId, reason, step: "drive_promoted" },
      "terminal drive promoted to a backgrounded drive-owner",
    );
    if (deps.notify) {
      // Fire-and-forget on this synchronous bus listener; a notify fault must never become an
      // uncaughtException that crashes the daemon. The message is STRUCTURAL only (session id +
      // "background") — no screen text/secrets.
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

  // SEED a recovered durable drive into the holder's
  // in-memory state — the SHARED path for both the re-attach event (onDriveReattached) AND the
  // lazy-seed (maybeSeedRecoveredDrive). It (1) seeds the journal cache from the durable
  // store (resume from objective + answered prompts, not a fresh empty — so the next woken turn
  // does not re-answer), (2) PROMOTES the session (promotedSessions + sessionAgent) so the
  // woken-turn driver sees it drive-scoped AND the backstop + spend ceiling guard the
  // resumed drive (they only key on promoted, which is empty for a boot-recovered drive
  // otherwise), and (3) stamps driveStartedAtMs (the resumed elapsedMs survives the restart) +
  // lastTransitionMs (so a freshly-seeded drive is not instantly treated as silent-past-heartbeat).
  // A missing store / missing journal still PROMOTES + stamps (so the backstop guards even a
  // re-attach with nothing persisted) — it simply resumes an empty journal. Never throws.
  const seedRecoveredDrive = (sessionId: string, agentId: string): boolean => {
    sessionAgent.set(sessionId, agentId);
    const resumed = deps.driveJournalStore?.load(agentId, sessionId);
    if (resumed !== undefined) driveJournals.set(sessionId, resumed);
    // Promote the recovered drive so the backstop + spend ceiling (which key ONLY on
    // promotedSessions) guard its remaining, possibly-multi-hour life.
    promotedSessions.add(sessionId);
    // The resumed elapsedMs base: re-derive the drive-start from the journal's cumulative
    // elapsedMs so `now - driveStartedAtMs` reconstructs the SAME running total post-restart
    // (a missing/odd value → now, a sane ≥0 elapsedMs).
    const elapsed = typeof resumed?.elapsedMs === "number" && Number.isFinite(resumed.elapsedMs) && resumed.elapsedMs >= 0 ? resumed.elapsedMs : 0;
    driveStartedAtMs.set(sessionId, nowMs() - elapsed);
    lastTransitionMs.set(sessionId, nowMs());
    // Seed the heartbeat dedupe stamp on resume too, so a recovered drive's
    // first user heartbeat lands one full cadence after re-attach (not immediately on the next tick).
    lastHeartbeatSentMs.set(sessionId, nowMs());
    return resumed !== undefined;
  };

  // RESUME on a re-attach. The registry's recover-on-boot re-attached
  // a surviving detached tmux session and emitted the content-free terminal:drive_reattached.
  // The holder consumes it to seed + promote the resumed drive (the shared seedRecoveredDrive).
  // NOTE: this event can fire DURING the boot sweep BEFORE this listener
  // subscribes (daemon.ts), so on the boot path it is DROPPED — the lazy-seed (below) is the
  // load-bearing resume path; this listener covers a re-attach that happens AFTER subscription
  // (a future call order). Defensive: validate the structural ids before keying state.
  const onDriveReattached = (e: { sessionId?: unknown; agentId?: unknown }): void => {
    if (typeof e.sessionId !== "string" || typeof e.agentId !== "string") {
      log.warn(
        { hint: "malformed terminal:drive_reattached payload (missing sessionId/agentId); resume skipped", errorKind: "validation" as const, step: "drive_reattached_dropped" },
        "terminal drive-reattach resume dropped a malformed frame",
      );
      return;
    }
    const { sessionId, agentId } = e;
    seedAttempted.add(sessionId); // the event delivered the seed → the lazy-seed need not re-load.
    const resumed = seedRecoveredDrive(sessionId, agentId);
    log.info(
      { sessionId, agentId, resumed, step: "drive_reattached" },
      "terminal drive re-attached; journal resumed from durable store",
    );
  };
  deps.eventBus.on("terminal:drive_reattached", onDriveReattached);

  // LAZY-SEED a recovered durable drive on its FIRST wake when the boot
  // terminal:drive_reattached was dropped (the boot-race). On the first inbound wake for a
  // session whose in-memory journal is empty (and not yet seed-attempted this life), load the
  // durable journal: if one exists it is a recovered drive → seed + promote it (so the resume
  // guard + the backstop/spend ceiling engage). Order-independent (does not depend on the boot
  // event) + bounded (one disk read per session per life via seedAttempted). MUST run BEFORE
  // the wake adapter computes the owner (so driveScopeKey sees the promotion on THIS wake) —
  // onWakeTransition is registered before the adapter bus, and the bus fires handlers in order.
  const maybeSeedRecoveredDrive = (sessionId: string, agentId: string): void => {
    if (driveJournals.has(sessionId) || promotedSessions.has(sessionId) || seedAttempted.has(sessionId)) return;
    seedAttempted.add(sessionId);
    if (deps.driveJournalStore?.load(agentId, sessionId) === undefined) return; // not a recovered drive.
    seedRecoveredDrive(sessionId, agentId);
    log.info(
      { sessionId, agentId, step: "drive_resume_lazy_seed" },
      "Terminal drive initialized a recovered journal on first wake",
    );
  };

  // Stamp the per-session last-transition on EVERY inbound wake — the
  // gate the backstop reads. ALSO lazy-seed a recovered durable drive on its first wake
  // (the boot terminal:drive_reattached may have been dropped) — run FIRST so the wake adapter
  // computes a drive-scoped owner for a just-seeded session. A defensive structural-field check
  // (a malformed frame is dropped by the wake adapter anyway). This includes the backstop's OWN
  // synthesized terminal:input_needed{state:"stuck"} (which re-stamps the transition → the synth
  // fires at most once per silent stretch).
  const onWakeTransition = (e: { sessionId?: unknown; agentId?: unknown }): void => {
    if (typeof e.sessionId !== "string") return;
    if (typeof e.agentId === "string") maybeSeedRecoveredDrive(e.sessionId, e.agentId);
    lastTransitionMs.set(e.sessionId, nowMs());
  };
  deps.eventBus.on("terminal:input_needed", onWakeTransition);

  // The coarse liveness BACKSTOP timer — a safety net UNDER the event-driven
  // wake (it fires only in the ABSENCE of a wake + resolves to ONE check; NO per-tick
  // screen read). Armed off the injected TimerPort exactly like the reaper
  // (setInterval(...).unref()), gated on BOTH timers + checkLiveness being present (absent ⇒
  // no backstop, event-only behavior). On each tick, for each PROMOTED session
  // (the backstop guards drives, not plain sessions): if a wake landed within heartbeatMs SKIP
  // (a normally-progressing drive never triggers it); else run the SINGLE injected
  // checkLiveness (has-session + noProgressMs — NO screen) → busyOrHung:
  //   - "busy" → NOT stuck (the reaper liveness stamp is the checkLiveness round-trip's
  //     `registry.status` lastActivity stamp; no separate refresh hook).
  //   - "hung" → synthesize a state:"stuck" wake through the EXISTING terminal:input_needed
  //     seam (NOT a new event) + a WARN; the stamp above makes this at-most-once per stretch.
  let backstopHandle: TimerHandle | undefined;
  // Process one promoted session's backstop check (async — the liveness check is a worker
  // round-trip). Separated from the loop so a per-session fault is isolated + awaited cleanly.
  const runBackstopTick = (): void => {
    const checkLiveness = deps.checkLiveness;
    if (!checkLiveness) return;
    const now = nowMs();
    const heartbeatMs = deps.heartbeatMs ?? 90_000;
    // Snapshot the promoted set (a synth-stuck-triggered woken turn could mutate it mid-tick). The
    // per-session body is the extracted runBackstopSessionCheck (terminal-wake-notify.ts) — this
    // holder keeps ONLY the timer + the loop (file-size cap). It runs the liveness probe (NO
    // screen) and acts: hung → synth-stuck through the EXISTING input_needed seam;
    // awaiting-input (finished + idle) → a ONE-TIME completion notification (de-duped via
    // completionNotified); still-working → clears the latch. Fire-and-forget per session.
    for (const sessionId of [...promotedSessions]) {
      void runBackstopSessionCheck({
        sessionId,
        agentId: sessionAgent.get(sessionId) ?? "",
        now,
        heartbeatMs,
        lastWakeMs: lastTransitionMs.get(sessionId),
        checkLiveness,
        emitStuck: (ev) => deps.eventBus.emit("terminal:input_needed", ev),
        completionNotified,
        notify: deps.notify,
        notifyPolicy,
        info: (obj, msg) => log.info(obj, msg),
        warn: (obj, msg) => log.warn(obj, msg),
      }).catch((err: unknown) => {
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

  // The COARSE user-facing heartbeat timer — a SECOND interval, distinct
  // from the backstop (a 1h user cadence vs the 90s internal liveness tick). Cloned from the
  // backstop arm pattern (setInterval(...).unref()).
  // Armed ONLY when timers + notify are present AND heartbeatNotifyMs > 0 (`0` is
  // terminal-only, never armed) AND notifyPolicy !== "none" (the heartbeat is a non-escalation
  // notification, suppressed under "none"; the escalation still fires via escalate()). The
  // per-tick loop body lives in the extracted terminal-wake-notify.ts (runHeartbeatTick) to keep
  // this holder under the file-size cap — it iterates promotedSessions ONLY + reads the
  // journal (NEVER the screen).
  let heartbeatNotifyHandle: TimerHandle | undefined;
  const heartbeatNotifyMs = deps.heartbeatNotifyMs ?? 3_600_000;
  if (deps.timers && deps.notify && heartbeatNotifyMs > 0 && notifyPolicy !== "none") {
    const notifyFn = deps.notify;
    heartbeatNotifyHandle = deps.timers.setInterval(
      () =>
        runHeartbeatTick({
          promotedSessions,
          driveJournals,
          sessionAgent,
          lastHeartbeatSentMs,
          notify: notifyFn,
          info: (obj, msg) => log.info(obj, msg),
          warn: (obj, msg) => log.warn(obj, msg),
          nowMs,
          heartbeatNotifyMs,
        }),
      heartbeatNotifyMs,
    );
    // .unref() so a pending tick never holds the event loop open on SIGTERM (TimerHandle contract).
    heartbeatNotifyHandle.unref();
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

  // Reclaim ALL per-session attention state on end-of-life so
  // a long-running daemon never leaks the loop-guard ring, the durable wake-state
  // file, or the FSM in-memory state. Wired to the SAME eviction/exit signals the
  // reaper + the fd3 PTY-exit hook already publish (setup-terminal-tools.ts).
  //
  // The `durableJournal` disposition gates whether the DURABLE
  // journal file is removed. The IN-MEMORY caches are ALWAYS reclaimed (no leak), but the
  // on-disk journal is removed ONLY on a CLEAN exit/evict (`"remove"`) and PRESERVED on a
  // crash/lost (`"preserve"`) so a genuinely-gone-but-recoverable durable drive keeps its
  // journal for a fresh drive to resume (preserve-on-failure).
  const onSessionGone = (sessionId: string, durableJournal: "remove" | "preserve"): void => {
    // Both total/never-throw.
    loopGuard.forget(sessionId);
    dispatcher.forgetSession(sessionId);
    // Reclaim the promoted-state so a recycled sessionId never inherits a
    // stale promotion (mirrors loopGuard.forget — wired to the SAME end-of-life signals below).
    promotedSessions.delete(sessionId);
    completionNotified.delete(sessionId); // reclaim the completion latch (same lifecycle).
    // Reclaim the DURABLE journal file FIRST (while the owning agent is still
    // known) — but ONLY on a clean exit/evict. On a lost/crash it is PRESERVED.
    const agentId = sessionAgent.get(sessionId);
    if (durableJournal === "remove" && deps.driveJournalStore && agentId !== undefined) {
      deps.driveJournalStore.remove(agentId, sessionId); // best-effort (the store swallows faults)
    }
    // Reclaim the per-session owning-agent bridge (no leak; same lifecycle).
    sessionAgent.delete(sessionId);
    // Reclaim the per-session in-memory journal cache (no per-session memory
    // leak over a long-running daemon; a recycled sessionId starts with a fresh journal).
    // NOTE: this drops the in-memory copy only — the DURABLE file is governed above.
    driveJournals.delete(sessionId);
    // Reclaim the per-session drive-start timestamp alongside the journal (same
    // lifecycle — no leak; a recycled sessionId re-stamps on its next promotion).
    driveStartedAtMs.delete(sessionId);
    // Reclaim the per-session last-transition stamp (same lifecycle — no
    // leak; a recycled sessionId starts unstamped so its first wake re-arms the backstop gate).
    lastTransitionMs.delete(sessionId);
    // Reclaim the per-session heartbeat dedupe stamp (same lifecycle — no
    // leak; a recycled sessionId starts unstamped so its first due-check fires from 0).
    lastHeartbeatSentMs.delete(sessionId);
    // Reclaim the lazy-seed-attempted marker (same lifecycle — no leak; a
    // recycled sessionId re-attempts the recovered-journal load on its first wake).
    seedAttempted.delete(sessionId);
    // removeWakeStateFile re-raises a non-ENOENT fs fault (@allow-throw) — wrap it so a
    // cleanup failure inside this bus listener can NEVER become an uncaughtException that
    // crashes the daemon. Surface the fault to the log with an actionable hint.
    try {
      removeWakeStateFile(deps.dataDir, sessionId);
    } catch (err) {
      log.warn(
        { sessionId, err, hint: "could not remove wake-state file on session end-of-life; it will be dropped on the next boot's first wake", errorKind: "resource" as const, step: "wake_cleanup_failed" },
        "terminal wake-state cleanup failed",
      );
    }
  };
  // Derive + emit the user-facing terminal outcome for a PROMOTED drive,
  // CAPTURING wasPromoted + journal + drive-start BEFORE onSessionGone clears them (the
  // ordering constraint). An UNPROMOTED session emits nothing. The done/failed derivation +
  // gating + structured log record live in the extracted sibling (terminal-wake-notify.ts). needs-you is
  // NEVER routed here — the escalate() paths own it UNCONDITIONALLY.
  const emitOutcomeBeforeGone = (
    sessionId: string,
    transition: "exited" | "lost" | "evicted",
    capName: EvictReason | undefined,
    disposition: "remove" | "preserve",
    lostReason?: string,
  ): void => {
    const wasPromoted = promotedSessions.has(sessionId);
    const j = driveJournals.get(sessionId);
    const startedAt = driveStartedAtMs.get(sessionId);
    const agentId = sessionAgent.get(sessionId) ?? "";
    // Reclaim ALL per-session state (the in-memory caches are ALWAYS cleared; the durable file
    // disposition is per the transition — exited/evicted "remove", lost "preserve", I10).
    onSessionGone(sessionId, disposition);
    if (!wasPromoted) return; // an unpromoted (inline short) drive emits NO outcome.
    emitTerminalOutcome(notifyDeps, {
      sessionId,
      agentId,
      transition,
      ...(capName !== undefined ? { capName } : {}),
      // Thread the genuine-death reason so the `failed` message + WARN name the actual cause.
      ...(lostReason !== undefined ? { lostReason } : {}),
      durationMs: startedAt !== undefined ? nowMs() - startedAt : undefined,
      interactions: j?.interactions,
    });
  };
  // A reaper/operator eviction is a CLEAN end-of-life → remove the durable journal + name the cap
  // on the `failed` outcome (events-terminal.ts). The eviction path is the SOLE owner of the
  // cap-eviction outcome; the reaper's companion plain lost is inert (not a genuine death),
  // so this no longer double-fires regardless of emit order.
  const onEvicted = (e: { sessionId: string; reason?: EvictReason }): void =>
    emitOutcomeBeforeGone(e.sessionId, "evicted", e.reason, "remove");
  // Map `lost` → `failed` ONLY for a GENUINE death (unrecoverable:true, from
  // durable-wiring's onUnrecoverable — the pure `shouldFailOnLost` lives in the sibling). A
  // transient/recoverable lost (worker-crash respawn / reaper plain-lost / re-attaching durable
  // drive) reclaims state only — NO `failed`. `exited` → done. The reason rides through.
  const onStateChange = (e: { sessionId: string; state: string; unrecoverable?: boolean; reason?: string }): void => {
    if (e.state === "exited") emitOutcomeBeforeGone(e.sessionId, "exited", undefined, "remove");
    else if (e.state === "lost") {
      if (shouldFailOnLost(e.unrecoverable)) emitOutcomeBeforeGone(e.sessionId, "lost", undefined, "preserve", e.reason);
      else onSessionGone(e.sessionId, "preserve");
    }
  };
  deps.eventBus.on("terminal:session_evicted", onEvicted);
  deps.eventBus.on("terminal:session_state", onStateChange);

  log.info({ step: "terminal_wake_subscribed" }, "terminal wake-dispatch FSM subscribed");

  return {
    async shutdown(): Promise<void> {
      deps.eventBus.off("terminal:session_evicted", onEvicted);
      deps.eventBus.off("terminal:session_state", onStateChange);
      // Unsubscribe the promotion consumer (no leaked listener; a
      // post-shutdown emit drives no notify).
      deps.eventBus.off("terminal:drive_promoted", onDrivePromoted);
      // Unsubscribe the re-attach resume consumer too (no leaked listener).
      deps.eventBus.off("terminal:drive_reattached", onDriveReattached);
      // Unsubscribe the transition stamp + CANCEL the backstop interval (no
      // leaked listener / timer; a post-shutdown tick never fires).
      deps.eventBus.off("terminal:input_needed", onWakeTransition);
      backstopHandle?.cancel();
      backstopHandle = undefined;
      // CANCEL the user-facing heartbeat interval too (no leaked timer; a
      // post-shutdown tick never fires).
      heartbeatNotifyHandle?.cancel();
      heartbeatNotifyHandle = undefined;
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
 * coalesce to ONE woken turn; a distinct subsequent prompt (a fresh `reason`) is a
 * fresh wake.
 *
 * The woken-turn owner's `sessionKey` is derived via `driveScopeKey` — a
 * PROMOTED session routes to `drive:<sessionId>` (isolating its woken turns from the primary
 * `sessionKey:""` conversation), an unpromoted one stays on `""` (the inline
 * fallback). This is ONLY the FSM/journal/conversation attribution; the
 * woken-turn driver + the active-check strip it back to the stamped registry owner
 * (`registryOwnerFor`) so the drive scope never changes which jail/allow-entry resolves.
 *
 * The translating handler is wrapped 1:1 so `off` removes exactly the wrapper `on` added —
 * a per-(handler) WeakMap pairs the FSM's handler with our wrapper (no module-global state).
 *
 * This is an inbound seam that must not trust the bus payload's shape
 * blindly. It VALIDATES the structural fields the FSM keys on (`sessionId`/`agentId`) BEFORE
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
        // Validate the shape before trusting it. A frame missing the structural
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
          // drive:<id> for a promoted session (isolated woken-turn attribution), ""
          // otherwise. This stays the AGENT-TURN id; the REGISTRY owner is RECOVERED downstream via
          // registry.getOwner (channel/API sessions), registryOwnerFor being the fallback.
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
