// SPDX-License-Identifier: Apache-2.0
/**
 * ActivityTurnCoordinator — owns the turn boundary in the orchestrator
 * (spec §4.5/§4.6, TURN-04/07, SEC-04).
 *
 * One coordinator is constructed per turn and disposed at turn end. It:
 *   1. subscribes to the canonical activity stream for the turn
 *      (`ActivityStreamPort.subscribeForTurn`) and unsubscribes on dispose /
 *      aborted-turn cleanup (try/finally),
 *   2. buffers events, feeds each through the injected projection
 *      (chat/acp) to build the next `ActivityRenderFrame`, and calls
 *      `renderer.apply(frame)` debounced to one paint per 800ms via the
 *      injected `TimerPort` (`handle.cancel()` for cancellation — never a raw
 *      timer global, Pitfall 7),
 *   3. on `finalize(outcome)` enforces the SEC-04 delete gate:
 *      • any observed `ActivityEvent{status:"failed"}` reclassifies the
 *        outcome to `kind:"failure"` with NO delete branch — even when delivery
 *        itself succeeded,
 *      • a `success` / `success_with_recovered_failures` outcome calls
 *        `renderer.finalize` ONLY after `outcome.delivery.deliveredAtMs` is
 *        acknowledged (delete never precedes the answer; §7.3),
 *      • `failure` / `silent` / `aborted` call `renderer.finalize` with the
 *        renderer's own keep/delete policy (no success-delete forced here),
 *   4. translates any `ActivityRenderError` from `apply`/`finalize` into an
 *      operator-visible WARN via the injected logger (`{hint, errorKind}`).
 *
 * Hexagonal boundary (TURN-03): this file imports ONLY the core package (the
 * port + types + projections) and the shared Result helpers. It never depends
 * on the observability package; `orchestrator/package.json` gains no
 * observability dependency. Logger / timer / clock are injected via `Deps`.
 *
 * @module
 */
import type {
  ActivityEvent,
  ActivityStreamPort,
  ActivitySubscription,
  ActivityRenderFrame,
  ActivityRenderError,
  ChannelActivityRenderer,
  TurnActivityContext,
  TurnOutcome,
  ProjectionConfig,
  ClockPort,
  TimerPort,
  TimerHandle,
  ComisLogger,
  ErrorKind,
} from "@comis/core";
import type { Result } from "@comis/shared";
import { suppressError } from "@comis/shared";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Debounce window for `renderer.apply` — at most one paint per 800ms (§5/§9). */
const APPLY_DEBOUNCE_MS = 800;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Projection function the coordinator drives per render tick. Unifies the chat
 * (`chatProjection(events, config, prev?)`) and ACP (`acpProjection(events,
 * prev?)`) shapes from `@comis/core` — 70-10 adapts the ACP projection (which
 * ignores `config`) to this signature when wiring the coordinator factory.
 */
export type ActivityProjection = (
  events: readonly ActivityEvent[],
  config: ProjectionConfig,
  prev?: ActivityRenderFrame,
) => ActivityRenderFrame;

/**
 * Live read of the operator kill switches for the agent owning this turn
 * (WIRE-07, §22.2). Returns the per-agent `activity` slice the gate cares about:
 * the agent-wide `emergencyDisabled` stop and the per-renderer `channels` enable
 * map (keyed by `TurnActivityContext.rendererKey`). MUST be a getter, not a
 * snapshot — the coordinator reads it on every `flushApply` so an in-memory
 * `config.write` flip hot-reloads without reconstructing the coordinator
 * (Pitfall 4). `undefined` (getter absent, or the agent has no `activity`
 * config) means "no suppression" — the un-wired composition path is unaffected.
 */
export type ActivityKillSwitch = () =>
  | { emergencyDisabled: boolean; channels: Record<string, { enabled: boolean }> }
  | undefined;

/**
 * The slice of the WIRE-08 circuit breaker the coordinator consumes. Keyed on
 * the turn's `(agentId, channelKey)`; the coordinator calls `isTripped(key)`
 * before `renderer.apply` (skip when tripped) and `record(key, result)` after
 * the apply result is available. `record` returns whether THIS call caused a
 * fresh trip so the coordinator fires its single WARN + bumps the counter
 * exactly once per trip. The concrete breaker lives in
 * `activity-circuit-breaker.ts`; only this narrow surface is depended on here so
 * the coordinator keeps no construction-time coupling to its lifecycle.
 */
export interface ActivityBreakerGate {
  isTripped(key: { agentId: string; channelKey: string }): boolean;
  record(
    key: { agentId: string; channelKey: string },
    result: Result<void, ActivityRenderError>,
  ): { tripped: boolean; reason?: "permission" | "transient" };
}

/** Injected dependencies for one per-turn coordinator. */
export interface ActivityTurnCoordinatorDeps {
  activityStreamPort: ActivityStreamPort;
  renderer: ChannelActivityRenderer;
  projection: ActivityProjection;
  timer: TimerPort;
  clock: ClockPort;
  logger: ComisLogger;
  config: ProjectionConfig;
  /**
   * WIRE-07 live kill-switch getter. OPTIONAL: when absent, no suppression is
   * applied (preserving behavior for callers that do not inject it — the daemon
   * thread-through is the documented composition-root follow-on). When present,
   * `flushApply` early-returns BEFORE `renderer.apply` if the agent is
   * emergency-disabled or the turn's rendererKey is not explicitly enabled.
   */
  killSwitch?: ActivityKillSwitch;
  /**
   * WIRE-08 auto-managed per-agent×channel circuit breaker. OPTIONAL: when
   * absent, no breaker gating is applied (preserving behavior for callers that
   * do not inject it — the daemon thread-through is the same documented
   * composition-root follow-on as `killSwitch`, per 76-02-SUMMARY). When
   * present, `flushApply` skips `renderer.apply` while the turn's
   * `(agentId, channelKey)` is tripped (AFTER the killSwitch gate) and records
   * every apply result so the breaker can count toward / recover from a trip.
   */
  breaker?: ActivityBreakerGate;
}

/**
 * OBS-01 in-process counter snapshot (spec §20.1). Mirrors the observability
 * ActivityStream pattern — there is no metrics-sink primitive, so counters are
 * surfaced as a snapshot for the daemon scrape + the test harness.
 */
export interface ActivityTurnCounters {
  /** `activity.render.apply` — successful renderer.apply calls. */
  renderApply: number;
  /** `activity.render.error` — apply/finalize calls that returned ActivityRenderError. */
  renderError: number;
  /** `activity.delete.gated` — success finalizes deferred until deliveredAtMs. */
  deleteGated: number;
  /** `activity.delete.applied` — success finalizes dispatched (the renderer owns the actual delete). */
  deleteApplied: number;
  /** `activity.turn.duration_ms` — turn wall-clock at finalize (0 until finalized). */
  turnDurationMs: number;
  /**
   * `activity.circuit_breaker.tripped` — count of FRESH breaker trips observed
   * by this coordinator (WIRE-08). Incremented once per trip, never per
   * subsequent skipped flush. Zero when no breaker is injected.
   */
  circuitBreakerTripped: number;
}

/** The per-turn coordinator handle (§4.6). */
export interface ActivityTurnCoordinator {
  /** Subscribe for the turn. Call once at turn start. */
  start(ctx: TurnActivityContext): void;
  /**
   * End-of-turn finalisation with the SEC-04 delete gate. Idempotent w.r.t.
   * subscription cleanup (unsubscribes in a finally).
   */
  finalize(outcome: TurnOutcome): Promise<void>;
  /** Release the subscription (idempotent). Safe to call after finalize. */
  dispose(): void;
  /** OBS-01 counter snapshot. */
  counters(): ActivityTurnCounters;
}

/**
 * Factory shape 70-10 wires: `(ctx) => ActivityTurnCoordinator`. The deps are
 * captured once at the composition root; the per-turn context is supplied to
 * `start`.
 */
export type CoordinatorFactory = (deps: ActivityTurnCoordinatorDeps) => ActivityTurnCoordinator;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map an `ActivityRenderError` to a closed `ErrorKind` for the operator WARN.
 * Closed exhaustive switch (AGENTS.md §2.8) — a new render-error variant fails
 * `tsc` here until classified.
 */
function renderErrorKind(e: ActivityRenderError): ErrorKind {
  switch (e.kind) {
    case "rate_limited": return "resource";
    case "transient_network": return "network";
    case "permission": return "auth";
    case "not_supported": return "platform";
    case "internal": return "internal";
    default: {
      const _exhaustive: never = e;
      void _exhaustive;
      return "internal";
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Construct a per-turn `ActivityTurnCoordinator`. One instance per turn; call
 * `start(ctx)` at turn start and `finalize(outcome)` + `dispose()` at turn end.
 */
export function createActivityTurnCoordinator(deps: ActivityTurnCoordinatorDeps): ActivityTurnCoordinator {
  const events: ActivityEvent[] = [];
  let subscription: ActivitySubscription | undefined;
  // WIRE-07: the per-turn context, captured at start(). flushApply reads
  // ctx.rendererKey to key the per-renderer kill switch.
  let turnCtx: TurnActivityContext | undefined;
  let prevFrame: ActivityRenderFrame | undefined;
  let debounceHandle: TimerHandle | undefined;
  // SEC-04 success-path delivery gate timer; captured so it can be unref'd (so
  // it never keeps the event loop alive during shutdown) and cancelled on an
  // aborted turn (WR-01).
  let pendingGate: TimerHandle | undefined;
  // SEC-04 reclassification trigger: set once any observed event is "failed".
  let sawFailedEvent = false;
  let startedAtMs = 0;
  let disposed = false;
  // APV-01: the turn's root activity id, minted once at start(). The spawning
  // turn's root is the parent of every sub-agent ActivityEvent (the spawn event
  // carries parentSessionKey, not a parent activityId — §17.3 / Assumption A2).
  let turnRootActivityId: string | undefined;
  // APV-01: active sub-agent stack (runId-less here — the coordinator keys on the
  // event's own activityId) for nested-spawn parent resolution. The top of the
  // stack is the parent of the next nested sub-agent; entries pop on phase:"end".
  const subAgentStack: string[] = [];

  const counters: ActivityTurnCounters = {
    renderApply: 0,
    renderError: 0,
    deleteGated: 0,
    deleteApplied: 0,
    turnDurationMs: 0,
    circuitBreakerTripped: 0,
  };

  /** Translate an apply/finalize render error into an operator WARN (TURN-04). */
  function warnRenderError(stage: "apply" | "finalize", e: ActivityRenderError): void {
    counters.renderError++;
    deps.logger.warn({
      submodule: "activity-turn-coordinator",
      step: stage,
      errorKind: renderErrorKind(e),
      renderErrorKind: e.kind,
      hint: "Activity rendering degraded; the turn proceeds and the assistant reply is unaffected",
    }, "Activity renderer reported an error");
  }

  /**
   * WIRE-07 kill-switch gate. Returns true when this renderer's activity must be
   * suppressed for the current turn. Reads the LIVE getter on every call (no
   * captured snapshot) so an in-memory config.write flip hot-reloads without
   * reconstructing the coordinator (Pitfall 4 / §22.2):
   *   • emergencyDisabled === true → suppress ALL activity for the agent,
   *   • channels[ctx.rendererKey]?.enabled !== true → suppress this renderer
   *     (a missing entry OR an explicit false is disabled — fail-closed).
   * When the getter is absent or returns undefined, nothing is suppressed (the
   * un-wired composition path is unaffected — daemon injection is the documented
   * follow-on).
   */
  function isActivitySuppressed(): boolean {
    const ks = deps.killSwitch?.();
    if (!ks) return false;
    if (ks.emergencyDisabled === true) return true;
    const rendererKey = turnCtx?.rendererKey;
    if (rendererKey === undefined) return true;
    // eslint-disable-next-line security/detect-object-injection -- rendererKey is a trusted TurnActivityContext field minted by the composition root, not user input
    return ks.channels[rendererKey]?.enabled !== true;
  }

  /**
   * The current turn's breaker key (agentId, channelKey). Both fields live on
   * `TurnActivityContext` (:14,:20); undefined until `start(ctx)` captures the
   * context. The WIRE-08 breaker keys on the (agent, channel) pair — distinct
   * from the WIRE-07 kill switch which keys on `ctx.rendererKey`.
   */
  function breakerKey(): { agentId: string; channelKey: string } | undefined {
    if (turnCtx === undefined) return undefined;
    return { agentId: turnCtx.agentId, channelKey: turnCtx.channelKey };
  }

  /**
   * WIRE-08 fresh-trip handler: a single operator WARN (mirrors warnRenderError
   * :216-225) naming the channelKey + reason, plus one counter increment. Fired
   * ONLY on the record that crossed a threshold — never on a subsequent skipped
   * flush (the breaker reports `tripped:true` exactly once per trip).
   */
  function onFreshTrip(reason: "permission" | "transient"): void {
    counters.circuitBreakerTripped++;
    deps.logger.warn({
      submodule: "activity-turn-coordinator",
      step: "circuit_breaker",
      errorKind: reason === "permission" ? ("auth" as const) : ("internal" as const),
      breakerReason: reason,
      channelKey: turnCtx?.channelKey,
      hint:
        reason === "permission"
          ? "Activity rendering auto-disabled for this channel after repeated permission errors; resets on config reload"
          : "Activity rendering auto-disabled for this channel after repeated failures; a half-open probe retries after 5 minutes",
    }, "Activity circuit breaker tripped — channel rendering suppressed");
  }

  /** Build the next frame from the buffered events and paint it (idempotent). */
  async function flushApply(): Promise<void> {
    // Gate BEFORE rendering — never paint when an operator has the renderer or
    // the whole agent killed (WIRE-07). Lifecycle reactions and final delivery
    // flow through separate paths (lifecycle-reactor.ts / execution-deliver.ts)
    // and are intentionally NOT gated here.
    if (isActivitySuppressed()) return;
    // WIRE-08: after the kill switch, before the paint — skip apply while this
    // (agent, channel) breaker is tripped. A half-open transient breaker reports
    // not-tripped (one probe allowed), so the apply runs and its result is
    // recorded below, closing or re-opening the breaker.
    const key = breakerKey();
    if (key !== undefined && deps.breaker?.isTripped(key) === true) return;

    const frame = deps.projection(events, deps.config, prevFrame);
    prevFrame = frame;
    const result: Result<void, ActivityRenderError> = await deps.renderer.apply(frame);

    // Record every apply result (success or failure) so the breaker advances /
    // recovers; a FRESH trip fires the single WARN + counter bump exactly once.
    if (key !== undefined) {
      const trip = deps.breaker?.record(key, result);
      if (trip?.tripped === true && trip.reason !== undefined) onFreshTrip(trip.reason);
    }

    if (!result.ok) {
      warnRenderError("apply", result.error);
      return;
    }
    counters.renderApply++;
  }

  /** Schedule a debounced flush, collapsing rapid events to one apply/800ms. */
  function scheduleApply(): void {
    // Cancel the prior pending paint via the opaque handle — never a raw timer
    // global (Pitfall 7).
    debounceHandle?.cancel();
    debounceHandle = deps.timer.setTimeout(() => {
      // The apply runs async; render errors are surfaced as WARN inside
      // flushApply. suppressError guards the fire-and-forget Promise from the
      // timer callback against an unexpected reject (e.g. a projection throw),
      // routing the reason to the injected logger's WARN.
      suppressError(
        flushApply(),
        "activity-turn-coordinator debounced apply",
        (message: string) => deps.logger.warn(
          { submodule: "activity-turn-coordinator", step: "apply", errorKind: "internal" as const, hint: "Debounced activity apply rejected unexpectedly; rendering skipped for this tick" },
          message,
        ),
      );
    }, APPLY_DEBOUNCE_MS);
  }

  function onEvent(e: ActivityEvent): void {
    events.push(annotateSubAgentParent(e));
    if (e.status === "failed") sawFailedEvent = true;
    scheduleApply();
  }

  /**
   * APV-01: supply `parentActivityId` for a sub-agent event from the active
   * stack. The stream emits sub-agent events WITHOUT a parent link (it has no
   * turn state); the coordinator (the §4.5 single owner) resolves it here:
   *   • phase:"start" lacking a parent → parent is the enclosing sub-agent (top
   *     of the stack) for a nested spawn, else the turn's root activity; the
   *     event's own activityId is then pushed so a deeper spawn links to it,
   *   • phase:"end" → pop the matching stack entry.
   * A pre-set `parentActivityId` is left intact; non-subagent events pass through
   * untouched. Returns the (possibly annotated) event without mutating the input.
   */
  function annotateSubAgentParent(e: ActivityEvent): ActivityEvent {
    if (e.kind !== "subagent") return e;

    if (e.phase === "end") {
      const idx = subAgentStack.lastIndexOf(e.activityId);
      if (idx !== -1) subAgentStack.splice(idx, 1);
      return e;
    }

    if (e.phase === "start") {
      const resolved =
        e.parentActivityId ??
        subAgentStack[subAgentStack.length - 1] ??
        turnRootActivityId;
      subAgentStack.push(e.activityId);
      if (e.parentActivityId !== undefined || resolved === undefined) return e;
      return { ...e, parentActivityId: resolved };
    }

    return e;
  }

  /** Release the subscription + cancel any pending paint / delivery gate. Idempotent. */
  function releaseSubscription(): void {
    if (disposed) return;
    disposed = true;
    subAgentStack.length = 0;
    debounceHandle?.cancel();
    // Cancel the in-flight delivery gate so an aborted turn does not leave a
    // timer holding the event loop open (WR-01). cancel() is idempotent.
    pendingGate?.cancel();
    subscription?.unsubscribe();
  }

  /**
   * The SEC-04 delete gate. Reclassifies on observed failure, then dispatches
   * `renderer.finalize` — gated on deliveredAtMs for the success path.
   */
  async function runFinalize(outcome: TurnOutcome): Promise<void> {
    counters.turnDurationMs = deps.clock.now() - startedAtMs;

    // (1) Reclassify: any observed failed event flips a non-failure outcome to
    // failure with NO delete branch — even if delivery itself succeeded (SEC-04,
    // §19.3). Already-failure / silent / aborted outcomes are left as-is.
    let effective = outcome;
    if (sawFailedEvent && (outcome.kind === "success" || outcome.kind === "success_with_recovered_failures")) {
      effective = {
        kind: "failure",
        errorKind: "platform",
        failedEvents: events.filter((e) => e.status === "failed"),
      };
    }

    // (2) Success path: the delete (owned by renderer.finalize per §7.3) must
    // NOT precede the assistant message landing. Gate on deliveredAtMs.
    if (effective.kind === "success" || effective.kind === "success_with_recovered_failures") {
      const deliveredAtMs = effective.delivery.deliveredAtMs;
      const waitMs = deliveredAtMs - deps.clock.now();
      if (waitMs > 0) {
        counters.deleteGated++;
        await new Promise<void>((resolve) => {
          // Capture + unref the gate handle: unref so a pending gate never keeps
          // the Node event loop alive during graceful shutdown, captured so
          // releaseSubscription() can cancel it on an aborted turn (WR-01).
          pendingGate = deps.timer.setTimeout(() => resolve(), waitMs);
          pendingGate.unref();
        });
      }
      await dispatchFinalize(effective);
      return;
    }

    // (3) failure / silent / aborted — the renderer owns keep/delete; no gate.
    await dispatchFinalize(effective);
  }

  /** Call renderer.finalize and surface any render error as WARN. */
  async function dispatchFinalize(outcome: TurnOutcome): Promise<void> {
    counters.deleteApplied++;
    const result: Result<void, ActivityRenderError> = await deps.renderer.finalize(outcome);
    if (!result.ok) warnRenderError("finalize", result.error);
  }

  return {
    start(ctx: TurnActivityContext): void {
      startedAtMs = deps.clock.now();
      // Capture the per-turn context so flushApply can key the WIRE-07 kill
      // switch on ctx.rendererKey.
      turnCtx = ctx;
      // Mint the turn's root activity id once — the parent of every sub-agent
      // event observed during this turn (APV-01).
      turnRootActivityId = randomUUID();
      subscription = deps.activityStreamPort.subscribeForTurn(ctx, onEvent);
    },

    async finalize(outcome: TurnOutcome): Promise<void> {
      try {
        await runFinalize(outcome);
      } finally {
        // Aborted/failed turns still release the subscription (TURN-04 cleanup).
        releaseSubscription();
      }
    },

    dispose(): void {
      releaseSubscription();
    },

    counters(): ActivityTurnCounters {
      return { ...counters };
    },
  };
}
