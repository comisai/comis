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

/** Injected dependencies for one per-turn coordinator. */
export interface ActivityTurnCoordinatorDeps {
  activityStreamPort: ActivityStreamPort;
  renderer: ChannelActivityRenderer;
  projection: ActivityProjection;
  timer: TimerPort;
  clock: ClockPort;
  logger: ComisLogger;
  config: ProjectionConfig;
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

  const counters: ActivityTurnCounters = {
    renderApply: 0,
    renderError: 0,
    deleteGated: 0,
    deleteApplied: 0,
    turnDurationMs: 0,
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

  /** Build the next frame from the buffered events and paint it (idempotent). */
  async function flushApply(): Promise<void> {
    const frame = deps.projection(events, deps.config, prevFrame);
    prevFrame = frame;
    const result: Result<void, ActivityRenderError> = await deps.renderer.apply(frame);
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
    events.push(e);
    if (e.status === "failed") sawFailedEvent = true;
    scheduleApply();
  }

  /** Release the subscription + cancel any pending paint / delivery gate. Idempotent. */
  function releaseSubscription(): void {
    if (disposed) return;
    disposed = true;
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
