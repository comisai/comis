// SPDX-License-Identifier: Apache-2.0
/**
 * ActivityTurnCoordinator — owns the turn boundary in the orchestrator.
 *
 * One coordinator is constructed per turn and disposed at turn end. It:
 *   1. subscribes to the canonical activity stream for the turn
 *      (`ActivityStreamPort.subscribeForTurn`) and unsubscribes on dispose /
 *      aborted-turn cleanup (try/finally),
 *   2. buffers events, feeds each through the injected projection
 *      (chat/acp) to build the next `ActivityRenderFrame`, and calls
 *      `renderer.apply(frame)` debounced to one paint per 800ms via the
 *      injected `TimerPort` (`handle.cancel()` for cancellation — never a raw
 *      timer global),
 *   3. on `finalize(outcome)` enforces the delete gate:
 *      • any observed `ActivityEvent{status:"failed"}` reclassifies the
 *        outcome to `kind:"failure"` with NO delete branch — even when delivery
 *        itself succeeded,
 *      • a `success` / `success_with_recovered_failures` outcome calls
 *        `renderer.finalize` ONLY after `outcome.delivery.deliveredAtMs` is
 *        acknowledged (delete never precedes the answer),
 *      • `failure` / `silent` / `aborted` call `renderer.finalize` with the
 *        renderer's own keep/delete policy (no success-delete forced here),
 *   4. translates any `ActivityRenderError` from `apply`/`finalize` into an
 *      operator-visible WARN via the injected logger (`{hint, errorKind}`).
 *
 * Hexagonal boundary: this file imports ONLY the core package (the
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
  PlanSnapshot,
  ClockPort,
  TimerPort,
  TimerHandle,
  ComisLogger,
  ErrorKind,
} from "@comis/core";
import { redactValue } from "@comis/core";
import type { Result } from "@comis/shared";
import { suppressError } from "@comis/shared";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Debounce window for `renderer.apply` — at most one paint per 800ms. */
const APPLY_DEBOUNCE_MS = 800;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Projection function the coordinator drives per render tick. Unifies the chat
 * (`chatProjection(events, config, prev?, latestPlanSnapshot?)`) and ACP
 * (`acpProjection(events, prev?)`) shapes from `@comis/core` — the coordinator
 * factory adapts the ACP projection (which ignores `config` and
 * `latestPlanSnapshot`) to this signature when wiring it. The optional 4th arg
 * lets the chat projection thread the latest SEP plan snapshot into
 * `ActivityRenderFrame.planSnapshot`.
 */
export type ActivityProjection = (
  events: readonly ActivityEvent[],
  config: ProjectionConfig,
  prev?: ActivityRenderFrame,
  latestPlanSnapshot?: PlanSnapshot,
) => ActivityRenderFrame;

/**
 * Minimal PlanUpdate shape the coordinator's PlanStream subscription expects.
 *
 * Structural type defined LOCALLY here (NOT imported from `@comis/observability`)
 * so the orchestrator preserves its boundary: imports ONLY
 * `@comis/core` and never `@comis/observability` (see src/index.ts:36 and
 * execution-pipeline.ts:131). The observability `createPlanStream(...)` returns
 * a `PlanStream` whose `PlanUpdate` payload structurally satisfies THIS shape;
 * the daemon composition root (which IS allowed to import both packages) hands
 * the instance through `ChannelManagerBuildDeps.executionPlanPort` → the chat
 * coordinator factory.
 *
 * Mirrors `packages/observability/src/activity/plan-stream.ts:47-56`. Any change
 * MUST stay byte-compatible with the observability shape or the daemon-side
 * structural assignment fails to compile (the regression-lock test in
 * `packages/daemon/src/__tests__/setup-channels-plan-stream.composition.test.ts`
 * exercises the real createPlanStream against this type).
 */
export interface PlanUpdate {
  readonly agentId: string;
  readonly sessionKey: string;
  readonly stepCount: number;
  readonly completedCount: number;
  readonly entries: readonly {
    readonly index: number;
    readonly description: string;
    readonly status: "pending" | "in_progress" | "done" | "skipped";
    readonly completed: boolean;
  }[];
}

/**
 * Minimal PlanStream port the coordinator subscribes to in start(ctx).
 *
 * Structural type defined locally for the same boundary reason as PlanUpdate
 * above. The single `subscribe` method matches the observability shape; the
 * returned `unsubscribe()` is walked from `releaseSubscription`.
 */
export interface PlanStream {
  subscribe(onPlanUpdate: (update: PlanUpdate) => void): () => void;
}

/**
 * Live read of the operator kill switches for the agent owning this turn.
 * Returns the per-agent `activity` slice the gate cares about:
 * the agent-wide `emergencyDisabled` stop and the per-renderer `channels` enable
 * map (keyed by `TurnActivityContext.rendererKey`). MUST be a getter, not a
 * snapshot — the coordinator reads it on every `flushApply` so an in-memory
 * `config.write` flip hot-reloads without reconstructing the coordinator.
 * `undefined` (getter absent, or the agent has no `activity`
 * config) means "no suppression" — the un-wired composition path is unaffected.
 */
export type ActivityKillSwitch = () =>
  | {
      emergencyDisabled: boolean;
      channels: Record<string, { enabled: boolean }>;
      /** Operator opt-in to default-ON: when true, a rendererKey with no
       *  explicit `channels` entry is enabled (an explicit entry still wins).
       *  Absent/false preserves the fail-closed Day-0 posture. */
      defaultEnabled?: boolean;
    }
  | undefined;

/**
 * The slice of the circuit breaker the coordinator consumes. Keyed on
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
   * Live kill-switch getter. OPTIONAL: when absent, no suppression is
   * applied (preserving behavior for callers that do not inject it — the daemon
   * thread-through is the documented composition-root follow-on). When present,
   * `flushApply` early-returns BEFORE `renderer.apply` if the agent is
   * emergency-disabled or the turn's rendererKey is not explicitly enabled.
   */
  killSwitch?: ActivityKillSwitch;
  /**
   * Auto-managed per-agent×channel circuit breaker. OPTIONAL: when
   * absent, no breaker gating is applied (preserving behavior for callers that
   * do not inject it — the daemon thread-through is the same documented
   * composition-root follow-on as `killSwitch`). When
   * present, `flushApply` skips `renderer.apply` while the turn's
   * `(agentId, channelKey)` is tripped (AFTER the killSwitch gate) and records
   * every apply result so the breaker can count toward / recover from a trip.
   */
  breaker?: ActivityBreakerGate;
  /**
   * Optional SEP plan-stream the coordinator subscribes to in
   * start(ctx). Absent → no plan-state wiring; the renderer's `frame.planSnapshot`
   * stays undefined (the elapsed-time fallback at render.ts handles this via the
   * elapsed line). Built ONCE per agent runtime at the
   * composition root via `createPlanStream({eventBus, executionPlanPort})` and
   * threaded into the per-turn coordinator. The subscription is detached in
   * `releaseSubscription` (cleanup runs even on aborted turns via try/finally).
   */
  planStream?: PlanStream;
}

/**
 * In-process counter snapshot. Mirrors the observability
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
   * by this coordinator. Incremented once per trip, never per
   * subsequent skipped flush. Zero when no breaker is injected.
   */
  circuitBreakerTripped: number;
}

/** The per-turn coordinator handle. */
export interface ActivityTurnCoordinator {
  /** Subscribe for the turn. Call once at turn start. */
  start(ctx: TurnActivityContext): void;
  /**
   * End-of-turn finalisation with the delete gate. Idempotent w.r.t.
   * subscription cleanup (unsubscribes in a finally).
   */
  finalize(outcome: TurnOutcome): Promise<void>;
  /** Release the subscription (idempotent). Safe to call after finalize. */
  dispose(): void;
  /** Counter snapshot. */
  counters(): ActivityTurnCounters;
}

/**
 * Factory shape the composition root wires: `(ctx) => ActivityTurnCoordinator`.
 * The deps are captured once at the composition root; the per-turn context is
 * supplied to `start`.
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

/**
 * Honest fallback errorKind when a reclassified failure carries no failed event
 * with a classified `errorKind`. An unclassified failure is an internal one —
 * never "platform" (which falsely blames the chat platform). This is the
 * documented default for the reclassify path (FIX #3 / T-hbe-04).
 */
const RECLASSIFY_FALLBACK_ERROR_KIND: ErrorKind = "internal";

/**
 * Derive the reclassify `errorKind` from the observed failed events: the first
 * failed event that carries a classified `errorKind` wins; otherwise the honest
 * internal fallback. Never returns the hardcoded "platform" default.
 */
function deriveReclassifyErrorKind(failedEvents: readonly ActivityEvent[]): ErrorKind {
  for (const e of failedEvents) {
    if (e.errorKind !== undefined) return e.errorKind;
  }
  return RECLASSIFY_FALLBACK_ERROR_KIND;
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
  // The per-turn context, captured at start(). flushApply reads
  // ctx.rendererKey to key the per-renderer kill switch.
  let turnCtx: TurnActivityContext | undefined;
  let prevFrame: ActivityRenderFrame | undefined;
  let debounceHandle: TimerHandle | undefined;
  // The live PlanStream subscription cleanup + the latest SEP
  // snapshot captured by the in-handler adapter. The cleanup runs in
  // releaseSubscription (the SAME finally-guarded path as the activity-stream
  // subscription) so an aborted turn never leaks a plan handler.
  let planUnsubscribe: (() => void) | undefined;
  let latestPlanSnapshot: PlanSnapshot | undefined;
  // Success-path delivery gate timer; captured so it can be unref'd (so
  // it never keeps the event loop alive during shutdown) and cancelled on an
  // aborted turn.
  let pendingGate: TimerHandle | undefined;
  // Reclassification trigger: set once any observed event is "failed".
  let sawFailedEvent = false;
  let startedAtMs = 0;
  let disposed = false;
  // The turn's root activity id, minted once at start(). The spawning
  // turn's root is the parent of every sub-agent ActivityEvent (the spawn event
  // carries parentSessionKey, not a parent activityId).
  let turnRootActivityId: string | undefined;
  // Active sub-agent stack (runId-less here — the coordinator keys on the
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

  /** Translate an apply/finalize render error into an operator WARN. */
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
   * Kill-switch gate. Returns true when this renderer's activity must be
   * suppressed for the current turn. Reads the LIVE getter on every call (no
   * captured snapshot) so an in-memory config.write flip hot-reloads without
   * reconstructing the coordinator:
   *   • emergencyDisabled === true → suppress ALL activity for the agent,
   *   • an explicit channels[ctx.rendererKey] entry always wins: enabled:true
   *     renders, enabled:false suppresses (per-channel opt-out),
   *   • no explicit entry → suppress UNLESS defaultEnabled === true (operator
   *     opt-in to default-ON); fail-closed otherwise.
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
    const entry = ks.channels[rendererKey];
    if (entry !== undefined) return entry.enabled !== true; // explicit opt-in/opt-out wins
    return ks.defaultEnabled !== true; // no entry → default-on only if operator opted in
  }

  /**
   * The current turn's breaker key (agentId, channelKey). Both fields live on
   * `TurnActivityContext` (:14,:20); undefined until `start(ctx)` captures the
   * context. The breaker keys on the (agent, channel) pair — distinct
   * from the kill switch which keys on `ctx.rendererKey`.
   */
  function breakerKey(): { agentId: string; channelKey: string } | undefined {
    if (turnCtx === undefined) return undefined;
    return { agentId: turnCtx.agentId, channelKey: turnCtx.channelKey };
  }

  /**
   * Fresh-trip handler: a single operator WARN (mirrors warnRenderError
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
    // the whole agent killed. Lifecycle reactions and final delivery
    // flow through separate paths (lifecycle-reactor.ts / execution-deliver.ts)
    // and are intentionally NOT gated here.
    if (isActivitySuppressed()) return;
    // After the kill switch, before the paint — skip apply while this
    // (agent, channel) breaker is tripped. A half-open transient breaker reports
    // not-tripped (one probe allowed), so the apply runs and its result is
    // recorded below, closing or re-opening the breaker.
    const key = breakerKey();
    if (key !== undefined && deps.breaker?.isTripped(key) === true) return;

    // Pass the cached `latestPlanSnapshot` as the projection's
    // 4th arg so chatProjection threads it onto frame.planSnapshot
    // (this supersedes a silent forward of prevFrame's stale snapshot).
    const frame = deps.projection(events, deps.config, prevFrame, latestPlanSnapshot);
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
    // global.
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
   * Supply `parentActivityId` for a sub-agent event from the active
   * stack. The stream emits sub-agent events WITHOUT a parent link (it has no
   * turn state); the coordinator (the single owner) resolves it here:
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
    // timer holding the event loop open. cancel() is idempotent.
    pendingGate?.cancel();
    subscription?.unsubscribe();
    // Detach the SEP plan-stream subscription so a re-extracted
    // plan after this turn's dispose never fires the (now-stale) handler.
    planUnsubscribe?.();
    planUnsubscribe = undefined;
    latestPlanSnapshot = undefined;
  }

  /**
   * The delete gate. Reclassifies on observed failure, then dispatches
   * `renderer.finalize` — gated on deliveredAtMs for the success path.
   */
  async function runFinalize(outcome: TurnOutcome): Promise<void> {
    counters.turnDurationMs = deps.clock.now() - startedAtMs;

    // (1) Reclassify: any observed failed event flips a non-failure outcome to
    // failure with NO delete branch — even if delivery itself succeeded.
    // Already-failure / silent / aborted outcomes are left as-is.
    let effective = outcome;
    if (sawFailedEvent && (outcome.kind === "success" || outcome.kind === "success_with_recovered_failures")) {
      const failedEvents = events.filter((e) => e.status === "failed");
      effective = {
        kind: "failure",
        errorKind: deriveReclassifyErrorKind(failedEvents),
        failedEvents,
      };
    }

    // (2) Success path: the delete (owned by renderer.finalize) must
    // NOT precede the assistant message landing. Gate on deliveredAtMs.
    if (effective.kind === "success" || effective.kind === "success_with_recovered_failures") {
      const deliveredAtMs = effective.delivery.deliveredAtMs;
      const waitMs = deliveredAtMs - deps.clock.now();
      if (waitMs > 0) {
        counters.deleteGated++;
        await new Promise<void>((resolve) => {
          // Capture + unref the gate handle: unref so a pending gate never keeps
          // the Node event loop alive during graceful shutdown, captured so
          // releaseSubscription() can cancel it on an aborted turn.
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
      // Capture the per-turn context so flushApply can key the kill
      // switch on ctx.rendererKey.
      turnCtx = ctx;
      // Mint the turn's root activity id once — the parent of every sub-agent
      // event observed during this turn.
      turnRootActivityId = randomUUID();
      subscription = deps.activityStreamPort.subscribeForTurn(ctx, onEvent);

      // Subscribe to the injected SEP plan-stream and cache
      // the most recent snapshot per turn. The plan-stream is shared per agent
      // runtime; the per-turn (agentId, sessionKey) filter prevents a snapshot
      // from session A reaching a render of session B. The adapter maps the
      // observability PlanUpdate shape to the core PlanSnapshot shape AND
      // runs redactValue on each description before exposing it as `label`
      // (SEP descriptions are LLM-extracted from the model
      // response and could echo a user message including a secret). On a new
      // snapshot, schedule a debounced apply so the renderer paints the
      // updated checkbox header within one tick.
      if (deps.planStream !== undefined) {
        planUnsubscribe = deps.planStream.subscribe((update: PlanUpdate) => {
          if (update.agentId !== ctx.agentId || update.sessionKey !== ctx.sessionKey) return;
          latestPlanSnapshot = {
            entries: update.entries.map((e) => {
              // redactValue on a string returns the redacted string in `.value`
              // (pure, non-throwing). The defensive type-guard preserves the
              // raw description ONLY if redactValue's value is not a string —
              // which never happens for a string input but keeps the type sound.
              const redactedDesc = redactValue(e.description);
              const label =
                typeof redactedDesc.value === "string" ? redactedDesc.value : e.description;
              return {
                id: String(e.index),
                label,
                status: e.status,
              };
            }),
          };
          scheduleApply();
        });
      }
    },

    async finalize(outcome: TurnOutcome): Promise<void> {
      try {
        await runFinalize(outcome);
      } finally {
        // Aborted/failed turns still release the subscription.
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
