// SPDX-License-Identifier: Apache-2.0
/**
 * activity-turn-coordinator.test.
 *
 * The per-turn coordinator: subscribe on start, unsubscribe on end (and on an
 * aborted turn via try/finally), debounce renderer.apply to ≤1/800ms, feed the
 * projection per event, translate ActivityRenderError into operator WARNs, and
 * — the anti-orphan-state guarantee — gate the finalize delete:
 *   • success: renderer.finalize fires ONLY after outcome.delivery.deliveredAtMs,
 *   • failure / silent / aborted: NO success-delete (keep the trail),
 *   • any observed ActivityEvent{status:"failed"} reclassifies the outcome to
 *     kind:"failure" with the no-delete branch, even when delivery succeeded,
 *   • the activity message is DISTINCT from the assistant message (finalize
 *     operates on the activity surface only; never edits the assistant msg).
 */
import type {
  ActivityEvent,
  ActivityStreamPort,
  ActivitySubscription,
  ActivityRenderFrame,
  ChannelActivityRenderer,
  ActivityRenderError,
  TurnActivityContext,
  TurnOutcome,
  ProjectionConfig,
  FinalDeliveryReceipt,
  PlanSnapshot,
} from "@comis/core";
import { chatProjection } from "@comis/core";
import { ok, err, type Result } from "@comis/shared";
import { describe, it, expect, vi } from "vitest";
import { createFakeTimers } from "../../../../test/support/fake-timers.js";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

import {
  createActivityTurnCoordinator,
  type PlanStream,
  type PlanUpdate,
} from "./activity-turn-coordinator.js";

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

function makeCtx(overrides?: Partial<TurnActivityContext>): TurnActivityContext {
  return {
    agentId: "agent-1",
    sessionKey: "default:user-1:chat-1",
    traceId: "trace-1",
    channelType: "telegram",
    channelKey: "chat-1",
    chatType: "group",
    inboundMessageId: "in-1",
    rendererKey: "agent-1:telegram:chat-1:group",
    ...overrides,
  };
}

let tsCounter = 0;
function makeEvent(overrides?: Partial<ActivityEvent>): ActivityEvent {
  // Distinct ts per event (1s apart) so adjacent events never coalesce into one
  // surrogate (sameGroup uses a <800ms window). durationMs above the
  // fast-success drop threshold (1500ms) so "completed" events stay visible at
  // normal verbosity (the projection drops sub-1500ms successes).
  const ts = new Date(1_700_000_000_000 + tsCounter++ * 1_000).toISOString();
  return {
    schemaVersion: 1,
    activityId: crypto.randomUUID(),
    sessionKey: "default:user-1:chat-1",
    agentId: "agent-1",
    channelKey: "chat-1",
    traceId: "trace-1",
    ts,
    phase: "progress",
    status: "running",
    kind: "tool",
    semanticPhase: "tool",
    durationMs: 2_000,
    defaultLabel: "Running tool",
    ...overrides,
  } as ActivityEvent;
}

// A fake ActivityStreamPort that captures the onEvent callback so the test can
// drive events synchronously and assert subscribe/unsubscribe lifecycle.
function makeStreamPort(): {
  port: ActivityStreamPort;
  emit: (e: ActivityEvent) => void;
  subscribeCalls: number;
  unsubscribeCalls: () => number;
} {
  let onEvent: ((e: ActivityEvent) => void) | undefined;
  let subscribeCalls = 0;
  let unsubscribeCalls = 0;
  const port: ActivityStreamPort = {
    subscribeForTurn(_ctx: TurnActivityContext, cb: (e: ActivityEvent) => void): ActivitySubscription {
      subscribeCalls++;
      onEvent = cb;
      return { unsubscribe: () => { unsubscribeCalls++; } };
    },
  };
  return {
    port,
    emit: (e) => onEvent?.(e),
    get subscribeCalls() { return subscribeCalls; },
    unsubscribeCalls: () => unsubscribeCalls,
  };
}

interface RecordingRenderer extends ChannelActivityRenderer {
  applyFrames: ActivityRenderFrame[];
  finalizeCalls: { outcome: TurnOutcome; at: number }[];
}

function makeRenderer(
  clock: { now(): number },
  opts?: { applyError?: ActivityRenderError; finalizeError?: ActivityRenderError },
): RecordingRenderer {
  const applyFrames: ActivityRenderFrame[] = [];
  const finalizeCalls: { outcome: TurnOutcome; at: number }[] = [];
  return {
    strategy: "EditPlace",
    canDelete: true,
    canEdit: true,
    applyFrames,
    finalizeCalls,
    async apply(frame: ActivityRenderFrame): Promise<Result<void, ActivityRenderError>> {
      applyFrames.push(frame);
      return opts?.applyError ? err(opts.applyError) : ok(undefined);
    },
    async finalize(outcome: TurnOutcome): Promise<Result<void, ActivityRenderError>> {
      finalizeCalls.push({ outcome, at: clock.now() });
      return opts?.finalizeError ? err(opts.finalizeError) : ok(undefined);
    },
  };
}

const PROJECTION = (events: readonly ActivityEvent[], config: ProjectionConfig, prev?: ActivityRenderFrame) =>
  chatProjection(events, config, prev);

function makeReceipt(deliveredAtMs: number): FinalDeliveryReceipt {
  return { ok: true, deliveredChunks: 1, lastChunkMessageId: "msg-1", deliveredAtMs };
}

function makeCoordinatorDeps(overrides?: {
  clock?: ReturnType<typeof createFakeClock>;
  timer?: ReturnType<typeof createFakeTimers>;
  stream?: ReturnType<typeof makeStreamPort>;
  renderer?: RecordingRenderer;
  logger?: ReturnType<typeof createMockLogger>;
}) {
  const clock = overrides?.clock ?? createFakeClock(0);
  const timer = overrides?.timer ?? createFakeTimers(0);
  const stream = overrides?.stream ?? makeStreamPort();
  const renderer = overrides?.renderer ?? makeRenderer(clock);
  const logger = overrides?.logger ?? createMockLogger();
  return {
    deps: {
      activityStreamPort: stream.port,
      renderer,
      projection: PROJECTION,
      timer,
      clock,
      logger,
      config: { verbosity: "normal" as const },
    },
    clock, timer, stream, renderer, logger,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle + debounce + WARN translation
// ---------------------------------------------------------------------------

describe("createActivityTurnCoordinator — lifecycle + debounce", () => {
  it("subscribes on start and unsubscribes on dispose", () => {
    const { deps, stream } = makeCoordinatorDeps();
    const coord = createActivityTurnCoordinator(deps);

    coord.start(makeCtx());
    expect(stream.subscribeCalls).toBe(1);
    expect(stream.unsubscribeCalls()).toBe(0);

    coord.dispose();
    expect(stream.unsubscribeCalls()).toBe(1);
  });

  it("unsubscribes even when an aborted turn finalizes (try/finally cleanup)", async () => {
    const { deps, stream } = makeCoordinatorDeps();
    const coord = createActivityTurnCoordinator(deps);
    coord.start(makeCtx());

    await coord.finalize({ kind: "aborted", reason: "user_cancel" });
    coord.dispose();

    expect(stream.unsubscribeCalls()).toBe(1);
  });

  it("debounces renderer.apply to at most one call per 800ms window across rapid events", () => {
    const { deps, timer, stream, renderer } = makeCoordinatorDeps();
    const coord = createActivityTurnCoordinator(deps);
    coord.start(makeCtx());

    // Three rapid events inside one debounce window collapse to ONE apply.
    stream.emit(makeEvent({ defaultLabel: "a" }));
    stream.emit(makeEvent({ defaultLabel: "b" }));
    stream.emit(makeEvent({ defaultLabel: "c" }));
    expect(renderer.applyFrames.length).toBe(0); // nothing flushed yet (debounced)

    timer.advance(800);
    expect(renderer.applyFrames.length).toBe(1); // one collapsed apply

    // A later event after the window opens a fresh debounce → a second apply.
    stream.emit(makeEvent({ defaultLabel: "d" }));
    timer.advance(800);
    expect(renderer.applyFrames.length).toBe(2);

    coord.dispose();
  });

  it("feeds each event through the projection so the frame grows across the turn", () => {
    const { deps, timer, stream, renderer } = makeCoordinatorDeps();
    const coord = createActivityTurnCoordinator(deps);
    coord.start(makeCtx());

    stream.emit(makeEvent({ defaultLabel: "first", status: "completed", phase: "end" }));
    timer.advance(800);
    stream.emit(makeEvent({ defaultLabel: "second", status: "completed", phase: "end" }));
    timer.advance(800);

    expect(renderer.applyFrames.length).toBe(2);
    // The projection accumulated both events into the latest frame.
    expect(renderer.applyFrames[1].visibleEvents.length).toBeGreaterThanOrEqual(2);
    expect(renderer.applyFrames[1].frameSeq).toBeGreaterThan(renderer.applyFrames[0].frameSeq);

    coord.dispose();
  });

  it("translates an ActivityRenderError from apply into an operator WARN with errorKind", async () => {
    const clock = createFakeClock(0);
    const renderer = makeRenderer(clock, { applyError: { kind: "rate_limited", retryAfterMs: 500 } });
    const logger = createMockLogger();
    const { deps, timer, stream } = makeCoordinatorDeps({ clock, renderer, logger });
    const coord = createActivityTurnCoordinator(deps);
    coord.start(makeCtx());

    stream.emit(makeEvent());
    timer.advance(800);
    await Promise.resolve(); // let the apply promise settle

    expect(logger.warn).toHaveBeenCalled();
    const warnArg = vi.mocked(logger.warn).mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(warnArg).toMatchObject({ errorKind: expect.any(String) });
    expect(warnArg).toHaveProperty("hint");

    coord.dispose();
  });
});

// ---------------------------------------------------------------------------
// The delete gate
// ---------------------------------------------------------------------------

describe("createActivityTurnCoordinator — delete gate", () => {
  it("finalizes a success outcome ONLY after deliveredAtMs is reached (delete never precedes the answer)", async () => {
    const clock = createFakeClock(1_000);
    const { deps, timer, renderer } = makeCoordinatorDeps({ clock });
    const coord = createActivityTurnCoordinator(deps);
    coord.start(makeCtx());

    // Delivery acknowledges at t=1_500, but we're at t=1_000: finalize must wait.
    const finalizePromise = coord.finalize({
      kind: "success", trivial: false, delivery: makeReceipt(1_500),
    });
    expect(renderer.finalizeCalls.length).toBe(0); // gated — not yet acknowledged

    clock.advance(500); // now at deliveredAtMs
    timer.advance(500); // fire the scheduled finalize
    await finalizePromise;

    expect(renderer.finalizeCalls.length).toBe(1);
    expect(renderer.finalizeCalls[0].outcome.kind).toBe("success");
    // The finalize (and thus any delete) happened at/after deliveredAtMs.
    expect(renderer.finalizeCalls[0].at).toBeGreaterThanOrEqual(1_500);

    coord.dispose();
  });

  it("finalizes a success immediately when deliveredAtMs has already passed", async () => {
    const clock = createFakeClock(2_000);
    const { deps, renderer } = makeCoordinatorDeps({ clock });
    const coord = createActivityTurnCoordinator(deps);
    coord.start(makeCtx());

    await coord.finalize({ kind: "success", trivial: true, delivery: makeReceipt(1_000) });

    expect(renderer.finalizeCalls.length).toBe(1);
    expect(renderer.finalizeCalls[0].outcome.kind).toBe("success");

    coord.dispose();
  });

  it("keeps the activity message on a failure outcome — passes failure to renderer.finalize, no success branch", async () => {
    const clock = createFakeClock(0);
    const { deps, renderer } = makeCoordinatorDeps({ clock });
    const coord = createActivityTurnCoordinator(deps);
    coord.start(makeCtx());

    await coord.finalize({ kind: "failure", errorKind: "platform", failedEvents: [] });

    expect(renderer.finalizeCalls.length).toBe(1);
    expect(renderer.finalizeCalls[0].outcome.kind).toBe("failure");

    coord.dispose();
  });

  it("reclassifies a success outcome to failure when ANY observed event had status:'failed' (no delete)", async () => {
    const clock = createFakeClock(5_000);
    const { deps, timer, stream, renderer } = makeCoordinatorDeps({ clock });
    const coord = createActivityTurnCoordinator(deps);
    coord.start(makeCtx());

    // Observe a failed event during the turn.
    stream.emit(makeEvent({ status: "failed", errorKind: "dependency", phase: "end" }));
    timer.advance(800);

    // Delivery itself SUCCEEDED — but the failed event must flip the outcome.
    await coord.finalize({ kind: "success", trivial: false, delivery: makeReceipt(1_000) });

    expect(renderer.finalizeCalls.length).toBe(1);
    // Reclassified: the renderer receives kind:"failure", NOT success → no delete.
    expect(renderer.finalizeCalls[0].outcome.kind).toBe("failure");

    coord.dispose();
  });

  it("reclassify carries the observed failed event's errorKind, never the hardcoded platform default", async () => {
    const clock = createFakeClock(5_000);
    const { deps, timer, stream, renderer } = makeCoordinatorDeps({ clock });
    const coord = createActivityTurnCoordinator(deps);
    coord.start(makeCtx());

    // The failed event carried a non-platform kind — the reclassify must honor it.
    stream.emit(makeEvent({ status: "failed", errorKind: "dependency", phase: "end" }));
    timer.advance(800);

    await coord.finalize({ kind: "success", trivial: false, delivery: makeReceipt(1_000) });

    expect(renderer.finalizeCalls.length).toBe(1);
    const outcome = renderer.finalizeCalls[0].outcome;
    expect(outcome.kind).toBe("failure");
    if (outcome.kind !== "failure") throw new Error("expected failure");
    expect(outcome.errorKind).toBe("dependency");
    expect(outcome.errorKind).not.toBe("platform");

    coord.dispose();
  });

  it("never edits the assistant message — finalize only ever drives the renderer (activity surface)", async () => {
    // The coordinator has no handle to the assistant message; it only holds the
    // renderer (activity surface). This pins the DISTINCT-message invariant: the
    // sole finalize effect is renderer.finalize, never an assistant-message edit.
    const clock = createFakeClock(0);
    const { deps, renderer } = makeCoordinatorDeps({ clock });
    const coord = createActivityTurnCoordinator(deps);
    coord.start(makeCtx());

    await coord.finalize({ kind: "silent", reason: "NO_REPLY" });

    expect(renderer.finalizeCalls.length).toBe(1);
    expect(renderer.finalizeCalls[0].outcome.kind).toBe("silent");
    // No editMessage / assistant-message mutation surface exists on the coordinator.
    expect((coord as unknown as { editMessage?: unknown }).editMessage).toBeUndefined();

    coord.dispose();
  });
});

// ---------------------------------------------------------------------------
// Active sub-agent stack + parentActivityId resolution
// ---------------------------------------------------------------------------
//
// Linkage seam: the ActivityStream emits a
// kind:"subagent" event WITHOUT a parentActivityId (it has no turn state). The
// coordinator — the per-turn single owner — maintains a `runId →
// parentActivityId` map plus an active-subagent stack and annotates the parent
// link in onEvent: on a phase:"start" subagent event lacking parentActivityId,
// it sets parentActivityId to the turn's root activity id (minted once at
// start) and records runId→parent; on phase:"end" it pops the stack entry. The
// stream side of this seam is pinned in
// `observability/.../__tests__/activity-stream.subagent.test.ts`.

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("createActivityTurnCoordinator — sub-agent parent stack", () => {
  it("annotates a subagent start event with a uuid parentActivityId resolved from the active turn", () => {
    const { deps, timer, stream, renderer } = makeCoordinatorDeps();
    const coord = createActivityTurnCoordinator(deps);
    coord.start(makeCtx());

    const seen: ActivityEvent[] = [];
    const spy = vi.spyOn(renderer, "apply");

    stream.emit(
      makeEvent({
        kind: "subagent",
        semanticPhase: "thinking",
        phase: "start",
        status: "running",
        defaultLabel: "🤖 sub-agent-1 subagent",
        parentActivityId: undefined,
      }),
    );
    timer.advance(800);

    // The projection consumes the buffered event; assert the buffered event was
    // annotated by inspecting the frame the renderer received.
    const frame = spy.mock.calls.at(-1)?.[0];
    const subEvent = frame?.visibleEvents.find((e) => e.kind === "subagent");
    void seen;
    expect(subEvent).toBeDefined();
    expect(subEvent?.parentActivityId).toBeTypeOf("string");
    expect(subEvent?.parentActivityId).toMatch(UUID_RE);

    coord.dispose();
  });

  it("links nested sub-agents: each subagent's parentActivityId is a valid uuid (parent stack)", () => {
    const { deps, timer, stream, renderer } = makeCoordinatorDeps();
    const coord = createActivityTurnCoordinator(deps);
    coord.start(makeCtx());

    const spy = vi.spyOn(renderer, "apply");

    // Outer sub-agent spawns, then a nested sub-agent spawns inside it.
    stream.emit(
      makeEvent({
        kind: "subagent",
        semanticPhase: "thinking",
        phase: "start",
        status: "running",
        activityId: crypto.randomUUID(),
        defaultLabel: "🤖 outer subagent",
        parentActivityId: undefined,
      }),
    );
    stream.emit(
      makeEvent({
        kind: "subagent",
        semanticPhase: "thinking",
        phase: "start",
        status: "running",
        activityId: crypto.randomUUID(),
        defaultLabel: "🤖 nested subagent",
        parentActivityId: undefined,
      }),
    );
    timer.advance(800);

    const frame = spy.mock.calls.at(-1)?.[0];
    const subEvents = frame?.visibleEvents.filter((e) => e.kind === "subagent") ?? [];
    expect(subEvents.length).toBeGreaterThanOrEqual(1);
    for (const e of subEvents) {
      expect(e.parentActivityId).toBeTypeOf("string");
      expect(e.parentActivityId).toMatch(UUID_RE);
    }

    coord.dispose();
  });

  it("does not overwrite a parentActivityId that is already present on the event", () => {
    const { deps, timer, stream, renderer } = makeCoordinatorDeps();
    const coord = createActivityTurnCoordinator(deps);
    coord.start(makeCtx());

    const spy = vi.spyOn(renderer, "apply");
    const PRESET = crypto.randomUUID();

    stream.emit(
      makeEvent({
        kind: "subagent",
        semanticPhase: "thinking",
        phase: "start",
        status: "running",
        defaultLabel: "🤖 preset subagent",
        parentActivityId: PRESET,
      }),
    );
    timer.advance(800);

    const frame = spy.mock.calls.at(-1)?.[0];
    const subEvent = frame?.visibleEvents.find((e) => e.kind === "subagent");
    expect(subEvent?.parentActivityId).toBe(PRESET);

    coord.dispose();
  });

  it("leaves non-subagent events' parentActivityId untouched (no spurious annotation)", () => {
    const { deps, timer, stream, renderer } = makeCoordinatorDeps();
    const coord = createActivityTurnCoordinator(deps);
    coord.start(makeCtx());

    const spy = vi.spyOn(renderer, "apply");
    stream.emit(makeEvent({ kind: "tool", phase: "end", status: "completed", defaultLabel: "ran a tool" }));
    timer.advance(800);

    const frame = spy.mock.calls.at(-1)?.[0];
    const toolEvent = frame?.visibleEvents.find((e) => e.kind === "tool");
    expect(toolEvent).toBeDefined();
    expect(toolEvent?.parentActivityId).toBeUndefined();

    coord.dispose();
  });
});

// ---------------------------------------------------------------------------
// Error-kind mapping, finalize WARN, reject path, dispose-only, counters
// ---------------------------------------------------------------------------

describe("createActivityTurnCoordinator — error mapping + counters", () => {
  it.each([
    [{ kind: "rate_limited", retryAfterMs: 1 } as ActivityRenderError, "resource"],
    [{ kind: "transient_network", cause: "x" } as ActivityRenderError, "network"],
    [{ kind: "permission", detail: "x" } as ActivityRenderError, "auth"],
    [{ kind: "not_supported", capability: "edit" } as ActivityRenderError, "platform"],
    [{ kind: "internal", cause: "x" } as ActivityRenderError, "internal"],
  ])("maps the %o render error to errorKind %s in the operator WARN", async (renderError, expectedKind) => {
    const clock = createFakeClock(0);
    const renderer = makeRenderer(clock, { applyError: renderError });
    const logger = createMockLogger();
    const { deps, timer, stream } = makeCoordinatorDeps({ clock, renderer, logger });
    const coord = createActivityTurnCoordinator(deps);
    coord.start(makeCtx());

    stream.emit(makeEvent());
    timer.advance(800);
    await Promise.resolve();

    const warnArg = vi.mocked(logger.warn).mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(warnArg.errorKind).toBe(expectedKind);
    coord.dispose();
  });

  it("covers the exhaustive-never default of the render-error mapper via an out-of-union cast", async () => {
    const clock = createFakeClock(0);
    const renderer = makeRenderer(clock, {
      applyError: { kind: "future_variant" } as unknown as ActivityRenderError,
    });
    const logger = createMockLogger();
    const { deps, timer, stream } = makeCoordinatorDeps({ clock, renderer, logger });
    const coord = createActivityTurnCoordinator(deps);
    coord.start(makeCtx());

    stream.emit(makeEvent());
    timer.advance(800);
    await Promise.resolve();

    // The defensive default arm classifies an unknown variant as "internal".
    const warnArg = vi.mocked(logger.warn).mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(warnArg.errorKind).toBe("internal");
    coord.dispose();
  });

  it("translates a finalize ActivityRenderError into an operator WARN", async () => {
    const clock = createFakeClock(0);
    const renderer = makeRenderer(clock, { finalizeError: { kind: "internal", cause: "boom" } });
    const logger = createMockLogger();
    const { deps } = makeCoordinatorDeps({ clock, renderer, logger });
    const coord = createActivityTurnCoordinator(deps);
    coord.start(makeCtx());

    await coord.finalize({ kind: "failure", errorKind: "internal", failedEvents: [] });

    const warnArg = vi.mocked(logger.warn).mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(warnArg).toMatchObject({ step: "finalize", errorKind: "internal" });
    coord.dispose();
  });

  it("guards the debounced apply against an unexpected reject (projection throws) with a WARN", async () => {
    const clock = createFakeClock(0);
    const logger = createMockLogger();
    const { deps, timer, stream } = makeCoordinatorDeps({ clock, logger });
    // Replace the projection with one that throws to drive the suppressError path.
    const throwingDeps = {
      ...deps,
      projection: () => { throw new Error("projection-blew-up"); },
    };
    const coord = createActivityTurnCoordinator(throwingDeps);
    coord.start(makeCtx());

    stream.emit(makeEvent());
    timer.advance(800);
    await Promise.resolve();
    await Promise.resolve();

    expect(logger.warn).toHaveBeenCalled();
    coord.dispose();
  });

  it("is safe to dispose without start or finalize, and exposes a counters snapshot", () => {
    const { deps } = makeCoordinatorDeps();
    const coord = createActivityTurnCoordinator(deps);
    // dispose before start: no subscription to release, must not throw.
    expect(() => coord.dispose()).not.toThrow();
    const snap = coord.counters();
    expect(snap).toMatchObject({ renderApply: 0, renderError: 0, deleteGated: 0, deleteApplied: 0 });
  });

  it("increments deleteGated then deleteApplied for a future-dated success receipt", async () => {
    const clock = createFakeClock(1_000);
    const { deps, timer } = makeCoordinatorDeps({ clock });
    const coord = createActivityTurnCoordinator(deps);
    coord.start(makeCtx());

    const p = coord.finalize({ kind: "success", trivial: false, delivery: makeReceipt(1_400) });
    expect(coord.counters().deleteGated).toBe(1);
    clock.advance(400);
    timer.advance(400);
    await p;
    expect(coord.counters().deleteApplied).toBe(1);
    expect(coord.counters().turnDurationMs).toBeGreaterThanOrEqual(0);
    coord.dispose();
  });

  it("unref's the delivery-gate timer so it never holds the event loop open", async () => {
    const clock = createFakeClock(1_000);
    const { deps, timer } = makeCoordinatorDeps({ clock });
    const coord = createActivityTurnCoordinator(deps);
    coord.start(makeCtx());

    const p = coord.finalize({ kind: "success", trivial: false, delivery: makeReceipt(1_400) });
    // The gate timer is scheduled and must have been unref'd at schedule time.
    const gate = timer.unrefRecord().find((e) => e.delay === 400 && e.kind === "timeout");
    expect(gate?.unrefCalled).toBe(true);

    clock.advance(400);
    timer.advance(400);
    await p;
    coord.dispose();
  });

  it("cancels the in-flight delivery-gate timer when the turn is disposed mid-gate", () => {
    const clock = createFakeClock(1_000);
    const { deps, timer } = makeCoordinatorDeps({ clock });
    const coord = createActivityTurnCoordinator(deps);
    coord.start(makeCtx());

    // Fire-and-do-not-await the finalize so the gate is still pending.
    void coord.finalize({ kind: "success", trivial: false, delivery: makeReceipt(1_400) });
    expect(coord.counters().deleteGated).toBe(1);

    // Dispose mid-gate: the pending gate timer must be cancelled (not left to
    // hold the loop open on an aborted turn).
    coord.dispose();
    const gate = timer.unrefRecord().find((e) => e.delay === 400 && e.kind === "timeout");
    expect(gate?.cancelled).toBe(true);
  });

  it("starts the circuitBreakerTripped counter at zero in the snapshot", () => {
    const { deps } = makeCoordinatorDeps();
    const coord = createActivityTurnCoordinator(deps);
    expect(coord.counters().circuitBreakerTripped).toBe(0);
    coord.dispose();
  });
});

// ---------------------------------------------------------------------------
// Circuit-breaker gate inside flushApply (skip apply when tripped,
// record every apply result, single WARN + counter bump per fresh trip)
// ---------------------------------------------------------------------------

/**
 * A controllable breaker double exposing the `{ isTripped, record }` surface the
 * coordinator consumes. `tripped` toggles the gate; `nextRecord` is the
 * fresh-trip outcome the next `record` call reports (consumed once).
 */
function makeBreakerStub(opts?: { tripped?: boolean }) {
  let tripped = opts?.tripped ?? false;
  const recordCalls: Array<{ key: { agentId: string; channelKey: string }; ok: boolean }> = [];
  let nextRecord: { tripped: boolean; reason?: "permission" | "transient" } = { tripped: false };
  return {
    breaker: {
      isTripped: (_key: { agentId: string; channelKey: string }): boolean => tripped,
      record: (
        key: { agentId: string; channelKey: string },
        result: { ok: boolean },
      ): { tripped: boolean; reason?: "permission" | "transient" } => {
        recordCalls.push({ key, ok: result.ok });
        const out = nextRecord;
        nextRecord = { tripped: false };
        return out;
      },
    },
    setTripped: (v: boolean): void => { tripped = v; },
    armFreshTrip: (reason: "permission" | "transient"): void => { nextRecord = { tripped: true, reason }; },
    recordCalls,
  };
}

describe("createActivityTurnCoordinator — circuit-breaker gate", () => {
  it("skips renderer.apply for a turn whose breaker key is already tripped", () => {
    const stub = makeBreakerStub({ tripped: true });
    const { deps, timer, stream, renderer } = makeCoordinatorDeps();
    const coord = createActivityTurnCoordinator({ ...deps, breaker: stub.breaker });
    coord.start(makeCtx());

    stream.emit(makeEvent());
    timer.advance(800);

    // Tripped → apply is never called (mirrors the kill-switch early return).
    expect(renderer.applyFrames.length).toBe(0);
    coord.dispose();
  });

  it("records the apply result with the agentId+channelKey key after a successful paint", async () => {
    const stub = makeBreakerStub({ tripped: false });
    const { deps, timer, stream, renderer } = makeCoordinatorDeps();
    const coord = createActivityTurnCoordinator({ ...deps, breaker: stub.breaker });
    coord.start(makeCtx({ agentId: "agent-x", channelKey: "chan-y" }));

    stream.emit(makeEvent());
    timer.advance(800);
    await Promise.resolve(); // let the awaited apply settle so record() runs

    expect(renderer.applyFrames.length).toBe(1);
    expect(stub.recordCalls.length).toBe(1);
    expect(stub.recordCalls[0].key).toEqual({ agentId: "agent-x", channelKey: "chan-y" });
    expect(stub.recordCalls[0].ok).toBe(true);
    coord.dispose();
  });

  it("records the failing apply result so the breaker can count toward a trip", async () => {
    const clock = createFakeClock(0);
    const renderer = makeRenderer(clock, { applyError: { kind: "permission", detail: "forbidden" } });
    const stub = makeBreakerStub({ tripped: false });
    const { deps, timer, stream } = makeCoordinatorDeps({ clock, renderer });
    const coord = createActivityTurnCoordinator({ ...deps, breaker: stub.breaker });
    coord.start(makeCtx());

    stream.emit(makeEvent());
    timer.advance(800);
    await Promise.resolve();

    // The apply ran (not gated) and its failing Result was recorded.
    expect(stub.recordCalls.length).toBe(1);
    expect(stub.recordCalls[0].ok).toBe(false);
    coord.dispose();
  });

  it("fires exactly one WARN and bumps circuitBreakerTripped once on a fresh permission trip", async () => {
    const clock = createFakeClock(0);
    const renderer = makeRenderer(clock, { applyError: { kind: "permission", detail: "forbidden" } });
    const logger = createMockLogger();
    const stub = makeBreakerStub({ tripped: false });
    stub.armFreshTrip("permission"); // the next record reports a fresh trip
    const { deps, timer, stream } = makeCoordinatorDeps({ clock, renderer, logger });
    const coord = createActivityTurnCoordinator({ ...deps, breaker: stub.breaker });
    coord.start(makeCtx());

    stream.emit(makeEvent());
    timer.advance(800);
    await Promise.resolve();

    expect(coord.counters().circuitBreakerTripped).toBe(1);
    // The fresh trip emits a circuit_breaker-step WARN naming the reason.
    const tripWarn = vi
      .mocked(logger.warn)
      .mock.calls.map((c) => c[0] as Record<string, unknown>)
      .find((a) => a.step === "circuit_breaker");
    expect(tripWarn).toBeDefined();
    expect(tripWarn).toHaveProperty("hint");
    coord.dispose();
  });

  it("does not double-count the counter once the breaker is open on subsequent flushes", async () => {
    const clock = createFakeClock(0);
    const stub = makeBreakerStub({ tripped: false });
    stub.armFreshTrip("transient");
    const { deps, timer, stream } = makeCoordinatorDeps({ clock });
    const coord = createActivityTurnCoordinator({ ...deps, breaker: stub.breaker });
    coord.start(makeCtx());

    // First flush: a fresh trip is reported → counter = 1.
    stream.emit(makeEvent());
    timer.advance(800);
    await Promise.resolve();
    expect(coord.counters().circuitBreakerTripped).toBe(1);

    // Now the breaker is open: the next flush is gated (no apply, no record, no
    // counter movement).
    stub.setTripped(true);
    stream.emit(makeEvent());
    timer.advance(800);
    await Promise.resolve();
    expect(coord.counters().circuitBreakerTripped).toBe(1);
    coord.dispose();
  });

  it("paints normally when no breaker is injected (optional dep is a no-op)", () => {
    const { deps, timer, stream, renderer } = makeCoordinatorDeps();
    const coord = createActivityTurnCoordinator(deps); // no breaker dep
    coord.start(makeCtx());

    stream.emit(makeEvent());
    timer.advance(800);

    expect(renderer.applyFrames.length).toBe(1);
    expect(coord.counters().circuitBreakerTripped).toBe(0);
    coord.dispose();
  });
});

// ---------------------------------------------------------------------------
// planStream subscription + PlanUpdate→PlanSnapshot adapter
// with description redaction.
//
// The coordinator subscribes the injected `planStream` inside start(ctx) and
// caches the most recent PlanSnapshot. The adapter maps the observability
// PlanUpdate shape `{index, description, status}` to the core PlanSnapshot
// shape `{id, label, status}` (the two shapes differ; a mismatch would fail
// silently). The description is LLM-extracted SEP text and could echo a user
// message verbatim — the adapter MUST run `redactValue(description)` and use
// the redacted string as the snapshot label (never leak raw user content).
//
// The cached snapshot reaches the renderer as the projection's 4th argument
// on the next flushApply (the projection's `latestPlanSnapshot`
// arg supersedes the silent `prev.planSnapshot` forward). Cross-turn leakage
// is prevented by an in-handler `(agentId, sessionKey)` filter and the per-
// turn `planUnsubscribe` cleanup in releaseSubscription.
// ---------------------------------------------------------------------------

/**
 * Build a fake `PlanStream` whose `subscribe` returns a tracked unsubscribe.
 * The captured handler is invoked synchronously by `emit(update)` so the test
 * can drive PlanUpdates without a real event bus.
 */
function makePlanStream(): {
  stream: PlanStream;
  emit: (update: PlanUpdate) => void;
  subscribeCalls: () => number;
  unsubscribeCalls: () => number;
} {
  let handler: ((u: PlanUpdate) => void) | undefined;
  let subscribeCalls = 0;
  let unsubscribeCalls = 0;
  const stream: PlanStream = {
    subscribe(onPlanUpdate): () => void {
      subscribeCalls++;
      handler = onPlanUpdate;
      return () => {
        unsubscribeCalls++;
      };
    },
  };
  return {
    stream,
    emit: (u) => handler?.(u),
    subscribeCalls: () => subscribeCalls,
    unsubscribeCalls: () => unsubscribeCalls,
  };
}

describe("createActivityTurnCoordinator — planStream subscription", () => {
  it("subscribes to planStream on start(ctx) and unsubscribes on releaseSubscription via dispose", () => {
    const planStream = makePlanStream();
    const { deps } = makeCoordinatorDeps();
    const coord = createActivityTurnCoordinator({ ...deps, planStream: planStream.stream });

    coord.start(makeCtx());
    expect(planStream.subscribeCalls()).toBe(1);
    expect(planStream.unsubscribeCalls()).toBe(0);

    coord.dispose();
    expect(planStream.unsubscribeCalls()).toBe(1);
  });

  it("threads a PlanSnapshot via the projection's 4th arg after a PlanUpdate is delivered", () => {
    const planStream = makePlanStream();
    const projection = vi.fn(
      (
        _events: readonly ActivityEvent[],
        _config: ProjectionConfig,
        _prev?: ActivityRenderFrame,
        _latestPlanSnapshot?: PlanSnapshot,
      ): ActivityRenderFrame => ({
        frameSeq: 0,
        visibleEvents: [],
        groupedActivityIds: {},
        planSnapshot: _latestPlanSnapshot,
        changeSet: { added: [], edited: [], removed: [] },
      }),
    );
    const { deps, timer, stream } = makeCoordinatorDeps();
    const coord = createActivityTurnCoordinator({
      ...deps,
      projection,
      planStream: planStream.stream,
    });
    coord.start(makeCtx());

    // Deliver a PlanUpdate matching the turn ctx + drive a flushApply tick.
    planStream.emit({
      agentId: "agent-1",
      sessionKey: "default:user-1:chat-1",
      stepCount: 2,
      completedCount: 0,
      entries: [
        { index: 0, description: "step a", status: "pending", completed: false },
        { index: 1, description: "step b", status: "in_progress", completed: false },
      ],
    });
    stream.emit(makeEvent());
    timer.advance(800);

    // The projection received the adapted snapshot as its 4th arg.
    expect(projection).toHaveBeenCalled();
    const lastCall = projection.mock.calls.at(-1);
    const snapshotArg = lastCall?.[3] as PlanSnapshot | undefined;
    expect(snapshotArg).toBeDefined();
    expect(snapshotArg!.entries).toHaveLength(2);
    // Adapter maps {index, description, status} -> {id, label, status}.
    expect(snapshotArg!.entries[0]).toMatchObject({
      id: "0",
      label: "step a",
      status: "pending",
    });
    expect(snapshotArg!.entries[1]).toMatchObject({
      id: "1",
      label: "step b",
      status: "in_progress",
    });

    coord.dispose();
  });

  it("ignores a PlanUpdate whose agentId does not match the turn ctx (cross-turn leak guard)", () => {
    const planStream = makePlanStream();
    const projection = vi.fn(
      (
        _events: readonly ActivityEvent[],
        _config: ProjectionConfig,
        _prev?: ActivityRenderFrame,
        _latestPlanSnapshot?: PlanSnapshot,
      ): ActivityRenderFrame => ({
        frameSeq: 0,
        visibleEvents: [],
        groupedActivityIds: {},
        planSnapshot: _latestPlanSnapshot,
        changeSet: { added: [], edited: [], removed: [] },
      }),
    );
    const { deps, timer, stream } = makeCoordinatorDeps();
    const coord = createActivityTurnCoordinator({
      ...deps,
      projection,
      planStream: planStream.stream,
    });
    coord.start(makeCtx({ agentId: "agent-1" }));

    // Wrong agentId — filter must drop this update before assigning latestPlanSnapshot.
    planStream.emit({
      agentId: "agent-OTHER",
      sessionKey: "default:user-1:chat-1",
      stepCount: 1,
      completedCount: 0,
      entries: [
        { index: 0, description: "leaked step", status: "pending", completed: false },
      ],
    });
    stream.emit(makeEvent());
    timer.advance(800);

    const snapshotArg = projection.mock.calls.at(-1)?.[3] as PlanSnapshot | undefined;
    expect(snapshotArg).toBeUndefined();
    coord.dispose();
  });

  it("REGRESSION LOCK: runs redactValue on each description before exposing it as PlanSnapshot.label", () => {
    // The SEP extractor reads the LLM's response and pulls step descriptions
    // verbatim — the LLM could echo a user message including a secret. The
    // adapter MUST redact each description before the renderer sees it; this
    // test pins a real sk-test-* literal and asserts it never reaches the
    // label. Without the redactValue call, the literal would render verbatim
    // on every chat surface.
    const planStream = makePlanStream();
    const projection = vi.fn(
      (
        _events: readonly ActivityEvent[],
        _config: ProjectionConfig,
        _prev?: ActivityRenderFrame,
        _latestPlanSnapshot?: PlanSnapshot,
      ): ActivityRenderFrame => ({
        frameSeq: 0,
        visibleEvents: [],
        groupedActivityIds: {},
        planSnapshot: _latestPlanSnapshot,
        changeSet: { added: [], edited: [], removed: [] },
      }),
    );
    const { deps, timer, stream } = makeCoordinatorDeps();
    const coord = createActivityTurnCoordinator({
      ...deps,
      projection,
      planStream: planStream.stream,
    });
    coord.start(makeCtx());

    planStream.emit({
      agentId: "agent-1",
      sessionKey: "default:user-1:chat-1",
      stepCount: 1,
      completedCount: 0,
      entries: [
        {
          index: 0,
          description: "sk-test-1234567890ABCDEF1234567890ABCDEF",
          status: "pending",
          completed: false,
        },
      ],
    });
    stream.emit(makeEvent());
    timer.advance(800);

    const snapshotArg = projection.mock.calls.at(-1)?.[3] as PlanSnapshot | undefined;
    expect(snapshotArg).toBeDefined();
    const label = snapshotArg!.entries[0].label;
    expect(label).toContain("<redacted>");
    expect(label).not.toContain("sk-test-1234567890ABCDEF");
    coord.dispose();
  });
});
