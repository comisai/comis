// SPDX-License-Identifier: Apache-2.0
/**
 * Acceptance — fail-CLOSED guard for the kill-switch slice
 * resolver (injection regression guard).
 *
 * The sibling `default-off` test seeds `agents.default.activity = {channels:{}}`
 * (present-but-empty) and proves the gate suppresses. The fail-OPEN hole it
 * misses: the daemon getter re-reads `agents[ctx.agentId]?.activity`, and
 * `agents[ctx.agentId]` can be `undefined` when the turn's RUNTIME-RESOLVED
 * agentId is not a key in the parsed config (an agent removed from config, or a
 * default-fallback id mismatch — cf. the `createExecutor` defaultAgentId
 * fallback). A getter returning `undefined` there is read by the coordinator as
 * "no suppression" (`activity-turn-coordinator.ts`: `if (!ks) return false`) →
 * activity renders UNCONDITIONALLY: fail-OPEN, the opposite of the kill-switch's
 * fail-closed contract.
 *
 * `resolveActivityKillSwitchSlice` is the production resolver the daemon getter
 * now delegates to. A security kill-switch must fail CLOSED by construction:
 * this asserts the resolver NEVER returns undefined and collapses a missing
 * agent / missing slice to "no emergency, no channel enabled".
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

const silentLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return this;
  },
} as never;

describe("resolveActivityKillSwitchSlice fails closed", () => {
  it("returns a suppressing slice (never undefined) for an agentId absent from the map", () => {
    const agents: AgentActivityConfigMap = {
      default: { activity: { emergencyDisabled: false, channels: {} } },
    };
    const slice = resolveActivityKillSwitchSlice(agents, "ghost");
    // Fail-closed: no emergency, empty channels, defaultEnabled false → every
    // renderer suppressed by the gate.
    expect(slice).toEqual({ emergencyDisabled: false, channels: {}, defaultEnabled: false });
  });

  it("returns a suppressing slice when the agent entry has no activity config", () => {
    const agents = { default: {} } as AgentActivityConfigMap;
    const slice = resolveActivityKillSwitchSlice(agents, "default");
    expect(slice).toEqual({ emergencyDisabled: false, channels: {}, defaultEnabled: false });
  });

  it("preserves a configured slice verbatim (emergency + enabled channels pass through)", () => {
    const agents: AgentActivityConfigMap = {
      default: { activity: { emergencyDisabled: true, channels: { "default:echo:c1": { enabled: true } } } },
    };
    const slice = resolveActivityKillSwitchSlice(agents, "default");
    expect(slice).toEqual({ emergencyDisabled: true, channels: { "default:echo:c1": { enabled: true } }, defaultEnabled: false });
  });

  it("end-to-end: a real tool turn for an absent agentId drives ZERO renderer.apply", async () => {
    const bus = new TypedEventBus();
    const stream = createActivityStream({ eventBus: bus });
    const sink = createTestSink();
    const timer = createFakeTimers(0);
    const clock = createFakeClock(0);
    const config: ProjectionConfig = { verbosity: "verbose" };
    const AGENT = "ghost"; // NOT a key in `agents`
    const SESSION = "ghost:echo:chan-1";
    const TRACE = "trace-absent-agent";

    const agents: AgentActivityConfigMap = {
      default: { activity: { emergencyDisabled: false, channels: {} } },
    };

    // Daemon-shaped getter — delegates to the SAME production resolver the
    // inbound coordinatorFactory uses (setup-channels-runtime.ts).
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

    const ctx: TurnActivityContext = {
      agentId: AGENT,
      sessionKey: SESSION,
      traceId: TRACE,
      channelType: "echo",
      channelKey: "chan-1",
      chatType: "direct",
      inboundMessageId: "inbound-absent-agent",
      rendererKey: `${AGENT}:echo:chan-1`,
    };
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

    // A getter that returned `undefined` for the absent agent would leave
    // suppression OFF and paint a frame — this guards the fail-OPEN regression.
    expect(sink.recorded.frames.length).toBe(0);

    coordinator.dispose();
    stream.dispose();
  });
});
