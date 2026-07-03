// SPDX-License-Identifier: Apache-2.0
/**
 * Operator-opt-in DEFAULT-ON (per-agent `defaultChannelEnabled`)
 * with per-channel opt-OUT.
 *
 * The shipped default posture is fail-CLOSED (every renderer off until explicitly
 * enabled — see `default-off` + `absent-agent` guards). This adds the additive
 * operator control an operator sets to flip THEIR agent to default-ON: when
 * `activity.defaultChannelEnabled === true`, a renderer with NO explicit
 * `channels[rendererKey]` entry RENDERS, and the operator opts a specific
 * renderer out with `channels[rendererKey].enabled = false`. `emergencyDisabled`
 * still overrides everything, and an agent absent from the map stays fail-closed.
 *
 * Built on the SAME daemon-shaped getter (`resolveActivityKillSwitchSlice` →
 * `createActivityTurnCoordinator`) the inbound coordinatorFactory uses.
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
import {
  resolveActivityKillSwitchSlice,
  type AgentActivityConfigMap,
} from "../wiring/setup-channels/activity-kill-switch.js";
import { createFakeTimers } from "../../../../test/support/fake-timers.js";
import { createFakeClock } from "../../../../test/support/fake-clock.js";

const AGENT = "default";
const SESSION = "default:telegram:678314278";
const TRACE = "trace-default-on";
const RENDERER_KEY = `${AGENT}:telegram:678314278`;

const silentLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return this;
  },
} as never;

function makeCtx(): TurnActivityContext {
  return {
    agentId: AGENT,
    sessionKey: SESSION,
    traceId: TRACE,
    channelType: "telegram",
    channelKey: "678314278",
    chatType: "direct",
    inboundMessageId: "inbound-default-on",
    rendererKey: RENDERER_KEY,
  };
}

/** Drive one inbound tool turn through a coordinator built over the given agents
 *  config and return the number of frames the sink painted. */
async function framesForAgents(agents: AgentActivityConfigMap): Promise<number> {
  const bus = new TypedEventBus();
  const stream = createActivityStream({ eventBus: bus });
  const sink = createTestSink();
  const timer = createFakeTimers(0);
  const clock = createFakeClock(0);
  const config: ProjectionConfig = { verbosity: "verbose" };

  const coordinatorFactory = (ctx: TurnActivityContext) =>
    createActivityTurnCoordinator({
      activityStreamPort: stream,
      renderer: sink,
      projection: chatProjection,
      timer,
      clock,
      logger: silentLogger,
      config,
      killSwitch: () => resolveActivityKillSwitchSlice(agents, ctx.agentId),
      breaker: undefined,
    });

  const ctx = makeCtx();
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

  const n = sink.recorded.frames.length;
  coordinator.dispose();
  stream.dispose();
  return n;
}

describe("defaultChannelEnabled: operator opt-in to default-ON with per-channel opt-out", () => {
  it("renders for a renderer with NO explicit channels entry when defaultChannelEnabled is true", async () => {
    const agents: AgentActivityConfigMap = {
      default: { activity: { defaultChannelEnabled: true, channels: {} } },
    };
    expect(await framesForAgents(agents)).toBeGreaterThanOrEqual(1);
  });

  it("opt-OUT: an explicit channels[rendererKey].enabled=false suppresses even when defaultChannelEnabled is true", async () => {
    const agents: AgentActivityConfigMap = {
      default: {
        activity: {
          defaultChannelEnabled: true,
          channels: { [RENDERER_KEY]: { enabled: false } },
        },
      },
    };
    expect(await framesForAgents(agents)).toBe(0);
  });

  it("emergencyDisabled overrides defaultChannelEnabled (suppresses all)", async () => {
    const agents: AgentActivityConfigMap = {
      default: { activity: { emergencyDisabled: true, defaultChannelEnabled: true, channels: {} } },
    };
    expect(await framesForAgents(agents)).toBe(0);
  });

  it("default-OFF preserved: defaultChannelEnabled absent + no entry still suppresses (fail-closed)", async () => {
    const agents: AgentActivityConfigMap = {
      default: { activity: { channels: {} } },
    };
    expect(await framesForAgents(agents)).toBe(0);
  });
});
