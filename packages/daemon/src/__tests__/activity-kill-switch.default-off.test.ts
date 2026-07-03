// SPDX-License-Identifier: Apache-2.0
/**
 * Acceptance — "default-off" fail-closed regression guard.
 *
 * Builds the SAME daemon-shaped `coordinatorFactory` the daemon wires (a per-turn
 * `createActivityTurnCoordinator` over a real redacted `ActivityStream`, with a
 * `killSwitch` getter that RE-READS `agents[ctx.agentId]?.activity` fresh on
 * every `flushApply`), but with the schema-default empty `channels: {}` map.
 *
 * The shipped default posture is fail-CLOSED: with no rendererKey explicitly
 * enabled, the kill-switch gate (`channels[rendererKey]?.enabled !== true`)
 * suppresses EVERY renderer, so a real turn's worth of tool events drives ZERO
 * `renderer.apply`. This test asserts `sink.recorded.frames.length === 0`.
 *
 * REGRESSION-GUARD, not a red-first driver: an empty `channels` map suppresses
 * regardless of whether the kill-switch wiring landed (an absent/`undefined`
 * killSwitch leaves suppression off, but the daemon getter returns the agent's
 * `{channels:{}}` slice, which suppresses). It guards against a FUTURE change
 * that defaults the gate ON — flip the default to enabled and this test goes red.
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

const AGENT = "default";
const SESSION = "default:echo:chan-1";
const TRACE = "trace-default-off";

const silentLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return this;
  },
} as never;

/** A turn ctx whose 3-segment rendererKey is `default:echo:chan-1`. */
function makeCtx(rendererKey: string, channelKey: string): TurnActivityContext {
  return {
    agentId: AGENT,
    sessionKey: SESSION,
    traceId: TRACE,
    channelType: "echo",
    channelKey,
    chatType: "direct",
    inboundMessageId: "inbound-default-off",
    rendererKey,
  };
}

describe("default-off: an empty channels map suppresses every renderer (fail-closed)", () => {
  it("drives zero renderer.apply for a real tool turn when no rendererKey is enabled (fail-closed default)", async () => {
    const bus = new TypedEventBus();
    const stream = createActivityStream({ eventBus: bus });
    const sink = createTestSink();
    const timer = createFakeTimers(0);
    const clock = createFakeClock(0);
    const config: ProjectionConfig = { verbosity: "verbose" };

    // The schema-default per-agent activity slice: an EMPTY channels map +
    // emergency off (schema-agent-runtime.ts:175-194 defaults).
    const agents: Record<
      string,
      { activity: { verbosity: string; emergencyDisabled: boolean; channels: Record<string, { enabled: boolean }> } }
    > = {
      default: { activity: { verbosity: "normal", emergencyDisabled: false, channels: {} } },
    };

    // Daemon-shaped factory: the killSwitch getter RE-READS agents[ctx.agentId]
    // fresh per flushApply (mirrors the daemon's live getter; NOT a captured const).
    const coordinatorFactory = (ctx: TurnActivityContext) =>
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
        breaker: undefined,
      });

    const ctx = makeCtx(`${AGENT}:echo:chan-1`, "chan-1");
    const coordinator = coordinatorFactory(ctx);
    coordinator.start(ctx);

    // Emit one inbound's worth of tool activity (the same shape the sibling
    // setup-activity.composition.test.ts drives through the bus).
    bus.emit("tool:started", {
      toolName: "read_file",
      toolCallId: "call-1",
      timestamp: 1,
      agentId: AGENT,
      sessionKey: SESSION,
      traceId: TRACE,
    });
    bus.emit("tool:executed", {
      toolName: "read_file",
      durationMs: 11,
      success: true,
      timestamp: 2,
      toolCallId: "call-1",
      agentId: AGENT,
      sessionKey: SESSION,
      traceId: TRACE,
    });

    timer.advance(800);
    await Promise.resolve();

    // Fail-closed: the kill-switch gate ran BEFORE renderer.apply and suppressed
    // because `channels["default:echo:chan-1"]` is absent (≠ enabled:true). No
    // frame was painted. (A coordinator built WITHOUT the killSwitch — or one
    // that defaulted the gate on — would render here, so this assertion is a
    // genuine guard.)
    expect(sink.recorded.frames.length).toBe(0);

    coordinator.dispose();
    stream.dispose();
  });
});
