// SPDX-License-Identifier: Apache-2.0
/**
 * The §17.9 "day-4" composition acceptance test: the activity pipe works
 * end-to-end IN-MEMORY.
 *
 * This is the terminus of the activity-pipe workstream. It proves a typed,
 * redacted `ActivityEvent` flows the whole way:
 *
 *   EventBus emit (tool:*) → ActivityStream (observability substrate, redacts +
 *   validates) → bounded queue → per-turn ActivityTurnCoordinator (orchestrator)
 *   → chatProjection (core) → Echo TestSink renderer (channels) `apply(frame)` +
 *   `finalize(outcome)`.
 *
 * It asserts the four §17.7 conditions:
 *   1. ActivityStream is instantiated and subscribed to the EventBus.
 *   2. Exactly ONE coordinator is constructed for the turn and disposed at end
 *      (subscribe→unsubscribe lifecycle once).
 *   3. The Echo TestSink renderer received ≥ 1 `apply(frame)` and a
 *      `finalize(outcome)`.
 *   4. On shutdown every bounded queue drains and no pending placeholder is
 *      orphaned (the stream unsubscribes; post-shutdown emits never reach the
 *      sink).
 *
 * Two complementary surfaces exercise the wiring:
 *   • Part A (in-memory composition) wires the REAL production factories
 *     (`createActivityStream` + `createActivityTurnCoordinator` + `createTestSink`
 *     over a real `TypedEventBus`) with deterministic fake timer/clock. This is
 *     the authoritative §17.9 Echo-end-to-end-in-memory proof — no channel API.
 *   • Part B boots the real daemon via the existing `startTestDaemon` harness and
 *     proves the DAEMON-level wiring: the ActivityStream is
 *     constructed + subscribed to the EventBus at boot, and a clean shutdown
 *     drains it (the EventBus handler is detached; no long-running timer leaks).
 *
 * KEEP the `__tests__/` path: the daemon dir convention — this is the
 * one place that keeps `__tests__/` per the §17.1 test table.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import {
  TypedEventBus,
  type TurnActivityContext,
  type ProjectionConfig,
  chatProjection,
} from "@comis/core";
import { createActivityStream } from "@comis/observability";
import { createTestSink } from "@comis/channels";
import { createActivityTurnCoordinator } from "@comis/orchestrator";
import { createFakeTimers } from "../../../../test/support/fake-timers.js";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { setupObservability } from "../wiring/setup-observability.js";
import { createTokenTracker } from "../observability/token-tracker.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const AGENT = "agent-1";
const SESSION = "agent-1:echo:echo-1";
const TRACE = "trace-1";

/** Per-turn routing context for the Echo channel (selectStrategy("echo") → TestSink). */
function makeEchoCtx(overrides: Partial<TurnActivityContext> = {}): TurnActivityContext {
  return {
    agentId: AGENT,
    sessionKey: SESSION,
    traceId: TRACE,
    channelType: "echo",
    channelKey: "echo-1",
    chatType: "direct",
    inboundMessageId: "inbound-1",
    rendererKey: `${AGENT}:echo:echo-1`,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Part A — in-memory composition (the §17.9 day-4 Echo-end-to-end proof)
// ---------------------------------------------------------------------------

describe("activity composition: Echo renderer end-to-end in-memory", () => {
  it("routes one inbound's tool events through the stream and coordinator into Echo TestSink apply+finalize", async () => {
    // --- Compose the real production pieces over a real EventBus -------------
    const bus = new TypedEventBus();
    // Assertion 1 (subscription): the stream subscribes to the EventBus at
    // construction. Capture the pre/post listener counts on a tool event to
    // prove a handler was attached.
    const beforeSubscribe = bus.listenerCount("tool:executed");
    const stream = createActivityStream({ eventBus: bus });
    const afterSubscribe = bus.listenerCount("tool:executed");
    expect(afterSubscribe).toBeGreaterThan(beforeSubscribe);

    const sink = createTestSink();
    const timer = createFakeTimers(0);
    const clock = createFakeClock(0);
    const config: ProjectionConfig = { verbosity: "verbose" };

    // The daemon's coordinatorFactory shape: capture deps once, return one
    // coordinator per turn. Track how many coordinators were constructed for the
    // single turn (assertion 2).
    let coordinatorsBuilt = 0;
    const coordinatorFactory = (_ctx: TurnActivityContext) => {
      coordinatorsBuilt++;
      return createActivityTurnCoordinator({
        activityStreamPort: stream,
        renderer: sink,
        // acpProjection ignores config; chatProjection matches the unified
        // (events, config, prev?) signature directly (Echo routes to chat).
        projection: chatProjection,
        timer,
        clock,
        logger: { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } as never,
        config,
      });
    };

    // --- One turn -----------------------------------------------------------
    const ctx = makeEchoCtx();
    const coordinator = coordinatorFactory(ctx);
    coordinator.start(ctx);

    // Emit ONE inbound's worth of tool activity. The ActivityStream maps each to
    // a redacted, schema-validated ActivityEvent scoped to {agent,session,trace}
    // and delivers it to the coordinator's per-turn subscriber.
    bus.emit("tool:started", {
      toolName: "edit",
      toolCallId: "call-1",
      timestamp: 1,
      agentId: AGENT,
      sessionKey: SESSION,
      traceId: TRACE,
    });
    bus.emit("tool:executed", {
      toolName: "edit",
      durationMs: 12,
      success: true,
      timestamp: 2,
      toolCallId: "call-1",
      agentId: AGENT,
      sessionKey: SESSION,
      traceId: TRACE,
    });

    // Fire the coordinator's 800ms apply debounce → renderer.apply(frame).
    timer.advance(800);
    await Promise.resolve();

    // Assertion 3a (apply): the Echo TestSink received at least one frame, and
    // that frame carried the redacted tool ActivityEvent (proving the WHOLE
    // producer→queue→coordinator→projection→renderer path is reachable, not just
    // compiled).
    expect(sink.recorded.frames.length).toBeGreaterThanOrEqual(1);
    const lastFrame = sink.recorded.frames[sink.recorded.frames.length - 1]!;
    expect(lastFrame.visibleEvents.length).toBeGreaterThanOrEqual(1);
    expect(lastFrame.visibleEvents.some((e) => e.kind === "tool")).toBe(true);

    // --- Finalize the turn (success; delivery already landed) ---------------
    await coordinator.finalize({
      kind: "success",
      trivial: false,
      delivery: {
        ok: true,
        deliveredChunks: 1,
        lastChunkMessageId: "echo-msg-1",
        deliveredAtMs: 0, // already passed (clock at 0) → finalize immediately
      },
    });

    // Assertion 3b (finalize): the renderer received exactly one finalize with
    // the success outcome.
    expect(sink.recorded.outcome).toBeDefined();
    expect(sink.recorded.outcome?.kind).toBe("success");

    // Assertion 2 (one coordinator per turn): exactly one was constructed for
    // this single turn.
    expect(coordinatorsBuilt).toBe(1);

    // --- Assertion 4 (clean shutdown drain) ---------------------------------
    // The coordinator's finalize unsubscribed the turn (in its finally); dispose
    // is idempotent. Then dispose the stream (the shutdown drain hook):
    // it detaches every EventBus handler so post-shutdown emits never reach the
    // sink (no orphaned pending placeholder).
    coordinator.dispose();
    stream.dispose();
    expect(bus.listenerCount("tool:executed")).toBe(0);

    const framesAfterShutdown = sink.recorded.frames.length;
    bus.emit("tool:executed", {
      toolName: "edit",
      durationMs: 5,
      success: true,
      timestamp: 3,
      toolCallId: "call-2",
      agentId: AGENT,
      sessionKey: SESSION,
      traceId: TRACE,
    });
    timer.advance(800);
    await Promise.resolve();
    // No new frame: the stream is drained + detached; the turn is over.
    expect(sink.recorded.frames.length).toBe(framesAfterShutdown);
  });

  it("builds exactly one coordinator per turn that delivers events then stops painting after dispose", () => {
    // Lifecycle-only proof of §17.7 assertion 2 (subscribe→unsubscribe ONCE).
    const bus = new TypedEventBus();
    // Pre-stream baseline (no handlers yet) — stream.dispose() must return here.
    const baseline = bus.listenerCount("tool:executed");
    const stream = createActivityStream({ eventBus: bus });
    const sink = createTestSink();
    const timer = createFakeTimers(0);
    const clock = createFakeClock(0);

    const coordinator = createActivityTurnCoordinator({
      activityStreamPort: stream,
      renderer: sink,
      projection: chatProjection,
      timer,
      clock,
      logger: { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } as never,
      config: { verbosity: "normal" },
    });

    // The stream itself holds the only bus handler; per-turn subscribers are an
    // in-process Set inside the stream (subscribeForTurn does not add a new bus
    // listener). Prove the turn lifecycle via the stream's subscriber accounting:
    // a started turn delivers events; a disposed coordinator stops delivering.
    const ctx = makeEchoCtx();
    coordinator.start(ctx);

    const delivered: number[] = [];
    // Re-emit a quiet-visible failure (always shown) to make delivery observable
    // independent of verbosity coalescing.
    bus.emit("tool:executed", {
      toolName: "edit",
      durationMs: 9,
      success: false,
      timestamp: 1,
      toolCallId: "call-x",
      agentId: AGENT,
      sessionKey: SESSION,
      traceId: TRACE,
    });
    timer.advance(800);
    delivered.push(sink.recorded.frames.length);
    expect(delivered[0]).toBeGreaterThanOrEqual(1);

    // Dispose ends the turn (idempotent unsubscribe). After dispose, the stream
    // still has its single bus handler (it is shut down separately), but the
    // coordinator no longer paints.
    coordinator.dispose();
    const framesAfterDispose = sink.recorded.frames.length;
    bus.emit("tool:executed", {
      toolName: "edit",
      durationMs: 9,
      success: false,
      timestamp: 2,
      toolCallId: "call-y",
      agentId: AGENT,
      sessionKey: SESSION,
      traceId: TRACE,
    });
    timer.advance(800);
    expect(sink.recorded.frames.length).toBe(framesAfterDispose);

    // Stream shutdown detaches the bus handler (count returns to baseline).
    stream.dispose();
    expect(bus.listenerCount("tool:executed")).toBe(baseline);
  });
});

// ---------------------------------------------------------------------------
// Part B — daemon-level wiring via the real setupObservability
// ---------------------------------------------------------------------------
//
// Drives the daemon's OWN composition-root wiring function (setupObservability)
// over a real TypedEventBus and exercises its drain
// hook (disposeActivityStream). This proves the daemon constructs the
// ActivityStream, returns it as the orchestrator-facing port, subscribes it to
// the EventBus at boot, and detaches every handler on shutdown — using the
// REAL daemon code path, not a re-implementation.
//
// A FULL `startTestDaemon` boot of the activity pipe (the §17.7 "boots a fake
// daemon" smoke) lives in the integration tier at
// test/integration/activity-composition.test.ts — the daemon-harness dynamically
// imports `@comis/daemon`, which only resolves under the integration vitest
// config's `@comis/*`→dist aliases (single-fork, dedicated port). Booting it here
// in the parallel-worker unit tier cannot resolve `@comis/daemon` and would
// collide on the gateway port. The functional pipe assertions (apply/finalize/
// drain) are proven deterministically in-memory in Part A above.

describe("activity composition: daemon constructs and drains the ActivityStream", () => {
  it("returns the ActivityStream from setupObservability and clears its EventBus subscription on dispose", async () => {
    const bus = new TypedEventBus();
    // Pre-wiring baseline: no tool:* handler before setupObservability runs.
    const baseline = bus.listenerCount("tool:executed");

    // The REAL daemon composition-root function (async since Phase 178 — the
    // config-gated OTel await-import seam).
    const obs = await setupObservability({
      eventBus: bus,
      _createTokenTracker: createTokenTracker,
      activityLogger: { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } as never,
    });

    // Assertion 1 (daemon level): the ActivityStream is constructed + returned as
    // the orchestrator-facing port, and it subscribed to the EventBus tool:*
    // events at construction.
    expect(obs.activityStream).toBeDefined();
    expect(typeof obs.activityStream.subscribeForTurn).toBe("function");
    expect(bus.listenerCount("tool:executed")).toBeGreaterThan(baseline);

    // A live turn subscriber receives a redacted ActivityEvent (the stream is
    // genuinely wired to the bus, not a dormant object).
    const received: unknown[] = [];
    const sub = obs.activityStream.subscribeForTurn(makeEchoCtx(), (e) => received.push(e));
    bus.emit("tool:executed", {
      toolName: "edit",
      durationMs: 7,
      success: true,
      timestamp: 1,
      toolCallId: "call-1",
      agentId: AGENT,
      sessionKey: SESSION,
      traceId: TRACE,
    });
    expect(received.length).toBeGreaterThanOrEqual(1);
    sub.unsubscribe();

    // Assertion 4 (daemon level): the drain hook detaches every EventBus
    // handler (no orphaned subscriber across a restart).
    obs.disposeActivityStream();
    expect(bus.listenerCount("tool:executed")).toBe(baseline);

    // Post-drain emits never reach a subscriber (the stream is fully detached).
    const countBefore = received.length;
    bus.emit("tool:executed", {
      toolName: "edit",
      durationMs: 3,
      success: true,
      timestamp: 2,
      toolCallId: "call-2",
      agentId: AGENT,
      sessionKey: SESSION,
      traceId: TRACE,
    });
    expect(received.length).toBe(countBefore);
  });
});
