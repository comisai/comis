// SPDX-License-Identifier: Apache-2.0
/**
 * Acceptance — "emergency": `emergencyDisabled: true` suppresses
 * ALL activity for the agent, overriding an otherwise-enabled channel.
 *
 * Builds the SAME daemon-shaped `coordinatorFactory` the daemon wires (a per-turn
 * `createActivityTurnCoordinator` over a real redacted `ActivityStream`, with a
 * `killSwitch` getter that RE-READS `agents[ctx.agentId]?.activity` fresh per
 * `flushApply`). The per-agent slice has `emergencyDisabled: true` AND
 * `channels: { "default:echo:chan-1": { enabled: true } }` — the channel is
 * explicitly ENABLED, yet emergency wins: the gate
 * (`ks.emergencyDisabled === true → suppress`, activity-turn-coordinator.ts:277)
 * returns before the per-rendererKey check, so ZERO frames are painted.
 *
 * The suppress assertion (`frames.length === 0`) depends on the wired killSwitch:
 * a coordinator built WITHOUT it — or one that ignored `emergencyDisabled` —
 * would render the enabled channel, so this is a genuine driver for the
 * emergency safety barrier.
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
const TRACE = "trace-emergency";

const silentLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return this;
  },
} as never;

function makeCtx(rendererKey: string, channelKey: string): TurnActivityContext {
  return {
    agentId: AGENT,
    sessionKey: SESSION,
    traceId: TRACE,
    channelType: "echo",
    channelKey,
    chatType: "direct",
    inboundMessageId: "inbound-emergency",
    rendererKey,
  };
}

describe("emergency: emergencyDisabled suppresses an otherwise-enabled channel", () => {
  it("paints zero frames for an enabled rendererKey when the agent is emergency-disabled (emergency wins)", async () => {
    const bus = new TypedEventBus();
    const stream = createActivityStream({ eventBus: bus });
    const sink = createTestSink();
    const timer = createFakeTimers(0);
    const clock = createFakeClock(0);
    const config: ProjectionConfig = { verbosity: "verbose" };

    // chan-1 is EXPLICITLY enabled, but emergencyDisabled is true → emergency
    // overrides the per-renderer enable.
    const agents: Record<
      string,
      { activity: { verbosity: string; emergencyDisabled: boolean; channels: Record<string, { enabled: boolean }> } }
    > = {
      default: {
        activity: { verbosity: "normal", emergencyDisabled: true, channels: { "default:echo:chan-1": { enabled: true } } },
      },
    };

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
      durationMs: 9,
      success: true,
      timestamp: 2,
      toolCallId: "call-1",
      agentId: AGENT,
      sessionKey: SESSION,
      traceId: TRACE,
    });

    timer.advance(800);
    await Promise.resolve();

    // Emergency overrides the enabled channel — no paint.
    expect(sink.recorded.frames.length).toBe(0);

    coordinator.dispose();
    stream.dispose();
  });
});
