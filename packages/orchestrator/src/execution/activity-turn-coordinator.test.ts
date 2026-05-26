// SPDX-License-Identifier: Apache-2.0
/**
 * activity-turn-coordinator.test — TURN-04/07 + SEC-04.
 *
 * The per-turn coordinator: subscribe on start, unsubscribe on end (and on an
 * aborted turn via try/finally), debounce renderer.apply to ≤1/800ms, feed the
 * projection per event, translate ActivityRenderError into operator WARNs, and
 * — the milestone's anti-orphan-state guarantee — gate the finalize delete:
 *   • success: renderer.finalize fires ONLY after outcome.delivery.deliveredAtMs,
 *   • failure / silent / aborted: NO success-delete (keep the trail),
 *   • any observed ActivityEvent{status:"failed"} reclassifies the outcome to
 *     kind:"failure" with the no-delete branch, even when delivery succeeded,
 *   • the activity message is DISTINCT from the assistant message (finalize
 *     operates on the activity surface only; never edits the assistant msg).
 *
 * RED on the absent module: `Cannot find module './activity-turn-coordinator.js'`.
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
} from "@comis/core";
import { chatProjection } from "@comis/core";
import { ok, err, type Result } from "@comis/shared";
import { describe, it, expect, vi } from "vitest";
import { createFakeTimers } from "../../../../test/support/fake-timers.js";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

import { createActivityTurnCoordinator } from "./activity-turn-coordinator.js";

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

function makeEvent(overrides?: Partial<ActivityEvent>): ActivityEvent {
  return {
    activityId: crypto.randomUUID(),
    channelKey: "chat-1",
    timestamp: 1_000,
    phase: "progress",
    status: "running",
    kind: "tool",
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
// TURN-04 — lifecycle + debounce + WARN translation
// ---------------------------------------------------------------------------

describe("createActivityTurnCoordinator — TURN-04 lifecycle + debounce", () => {
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
// SEC-04 — the delete gate
// ---------------------------------------------------------------------------

describe("createActivityTurnCoordinator — SEC-04 delete gate", () => {
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
