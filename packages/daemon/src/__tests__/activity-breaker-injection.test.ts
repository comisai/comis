// SPDX-License-Identifier: Apache-2.0
/**
 * WIRE-08 acceptance — a tripped circuit breaker skips `renderer.apply` on the
 * LIVE (daemon-shaped) coordinator path; an untripped one renders and records.
 *
 * Builds the SAME daemon-shaped `coordinatorFactory` Plan 03 wired (a per-turn
 * `createActivityTurnCoordinator` over a real redacted `ActivityStream`, with a
 * re-reading WIRE-07 `killSwitch` getter), but with chan-1 EXPLICITLY enabled so
 * the kill-switch does NOT suppress — isolating the WIRE-08 breaker gate. A fake
 * `ActivityBreakerGate` is injected; its `isTripped(key)` keys on the turn's
 * `{ agentId: "default", channelKey: "chan-1" }` (activity-turn-coordinator.ts
 * breakerKey()). The gate ordering is killSwitch FIRST, breaker SECOND, then
 * apply, then record (flushApply :322-339).
 *
 * Two assertions:
 *   • tripped === true  → `flushApply` early-returns BEFORE renderer.apply →
 *     `frames.length === 0` (the breaker skipped the paint);
 *   • tripped === false → a fresh turn renders (`frames.length >= 1`) and the
 *     breaker's `record(key, result)` was called with the apply outcome.
 *
 * The suppress assertion depends on the wired breaker: a coordinator built
 * WITHOUT a breaker would render the enabled channel, so `frames.length === 0`
 * is a genuine WIRE-08 driver (T-77-04-03).
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import {
  TypedEventBus,
  type TurnActivityContext,
  type ProjectionConfig,
  chatProjection,
} from "@comis/core";
import { createActivityStream } from "@comis/observability";
import { createTestSink } from "@comis/channels";
import { createActivityTurnCoordinator, type ActivityBreakerGate, type RecordOutcome } from "@comis/orchestrator";
import { createFakeTimers } from "../../../../test/support/fake-timers.js";
import { createFakeClock } from "../../../../test/support/fake-clock.js";

const AGENT = "default";
const CHANNEL_KEY = "chan-1";
const RENDERER_KEY = "default:echo:chan-1";

const silentLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return this;
  },
} as never;

function makeCtx(traceId: string): TurnActivityContext {
  return {
    agentId: AGENT,
    sessionKey: RENDERER_KEY,
    traceId,
    channelType: "echo",
    channelKey: CHANNEL_KEY,
    chatType: "direct",
    inboundMessageId: `inbound-${traceId}`,
    rendererKey: RENDERER_KEY,
  };
}

/** chan-1 ENABLED so the kill-switch passes — the breaker is the only gate. */
const agents: Record<
  string,
  { activity: { verbosity: string; emergencyDisabled: boolean; channels: Record<string, { enabled: boolean }> } }
> = {
  default: {
    activity: { verbosity: "normal", emergencyDisabled: false, channels: { "default:echo:chan-1": { enabled: true } } },
  },
};

function makeFactory(bus: TypedEventBus, sink: ReturnType<typeof createTestSink>, breaker: ActivityBreakerGate) {
  const stream = createActivityStream({ eventBus: bus });
  const timer = createFakeTimers(0);
  const clock = createFakeClock(0);
  const config: ProjectionConfig = { verbosity: "verbose" };
  const factory = (ctx: TurnActivityContext) =>
    createActivityTurnCoordinator({
      activityStreamPort: stream,
      renderer: sink,
      projection: chatProjection,
      timer,
      clock,
      logger: silentLogger,
      config,
      killSwitch: () => {
        const activity = agents[ctx.agentId]?.activity;
        return activity
          ? { emergencyDisabled: activity.emergencyDisabled, channels: activity.channels }
          : undefined;
      },
      breaker,
    });
  return { factory, stream, timer };
}

async function driveTurn(
  bus: TypedEventBus,
  timer: ReturnType<typeof createFakeTimers>,
  coordinator: ReturnType<ReturnType<typeof makeFactory>["factory"]>,
  ctx: TurnActivityContext,
): Promise<void> {
  coordinator.start(ctx);
  bus.emit("tool:started", {
    toolName: "read_file",
    toolCallId: `call-${ctx.traceId}`,
    timestamp: 1,
    agentId: AGENT,
    sessionKey: ctx.sessionKey,
    traceId: ctx.traceId,
  });
  bus.emit("tool:executed", {
    toolName: "read_file",
    durationMs: 7,
    success: true,
    timestamp: 2,
    toolCallId: `call-${ctx.traceId}`,
    agentId: AGENT,
    sessionKey: ctx.sessionKey,
    traceId: ctx.traceId,
  });
  timer.advance(800);
  await Promise.resolve();
}

describe("WIRE-08 breaker injection: a tripped breaker skips renderer.apply on the live coordinator path", () => {
  it("suppresses the paint while the (agent, channel) breaker isTripped and renders + records when not tripped", async () => {
    let tripped = true;
    // WR-03: type the fake against the EXPORTED RecordOutcome (not an inline cast) so a
    // rename of the breaker contract (`tripped`/`reason`) fails this test at compile time.
    // `recordResult` is mutable so the fresh-trip arm below can drive the `onFreshTrip` path.
    let recordResult: RecordOutcome = { tripped: false };
    const recordSpy = vi.fn((): RecordOutcome => recordResult);
    const isTrippedSpy = vi.fn((key: { agentId: string; channelKey: string }) => {
      // Confirm the coordinator keys the breaker on the turn's (agent, channel).
      expect(key).toEqual({ agentId: AGENT, channelKey: CHANNEL_KEY });
      return tripped;
    });
    const breaker: ActivityBreakerGate = { isTripped: isTrippedSpy, record: recordSpy };

    const bus = new TypedEventBus();
    const sink = createTestSink();
    const { factory, stream, timer } = makeFactory(bus, sink, breaker);

    // (1) tripped → the breaker gate (after the kill-switch) skips apply.
    const trippedCtx = makeCtx("t-tripped");
    const c1 = factory(trippedCtx);
    await driveTurn(bus, timer, c1, trippedCtx);
    expect(sink.recorded.frames.length).toBe(0);
    expect(isTrippedSpy).toHaveBeenCalled();
    // No apply happened → record was never reached.
    expect(recordSpy).not.toHaveBeenCalled();
    c1.dispose();

    // (2) not tripped → a fresh turn renders and the breaker records the result.
    tripped = false;
    const okCtx = makeCtx("t-untripped");
    const c2 = factory(okCtx);
    await driveTurn(bus, timer, c2, okCtx);
    expect(sink.recorded.frames.length).toBeGreaterThanOrEqual(1);
    expect(recordSpy).toHaveBeenCalled();
    c2.dispose();

    // (3) WR-03: not tripped at the gate, but the apply's `record` returns a FRESH trip
    // → the coordinator must take the onFreshTrip branch exactly once (counter bump). The
    // prior arm's cast hid that `record` never returned a `reason`, leaving onFreshTrip
    // (activity-turn-coordinator.ts:337-338) untested at this seam.
    recordResult = { tripped: true, reason: "permission" };
    const freshCtx = makeCtx("t-fresh-trip");
    const c3 = factory(freshCtx);
    await driveTurn(bus, timer, c3, freshCtx);
    expect(sink.recorded.frames.length).toBeGreaterThanOrEqual(1);
    expect(c3.counters().circuitBreakerTripped).toBe(1);
    c3.dispose();

    stream.dispose();
  });
});
