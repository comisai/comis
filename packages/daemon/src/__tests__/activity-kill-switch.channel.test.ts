// SPDX-License-Identifier: Apache-2.0
/**
 * Acceptance — "channel": per-rendererKey enable/disable + the
 * hot-reload re-read proof (BOTH an in-place flip AND the real config.write
 * full-object replacement).
 *
 * Builds the SAME daemon-shaped `coordinatorFactory` the daemon wires: a per-turn
 * `createActivityTurnCoordinator` over a real redacted `ActivityStream`, with a
 * `killSwitch` getter that RE-READS `agents[ctx.agentId]?.activity` fresh on
 * every `flushApply` (through the STABLE top-level `agents` map ref — NOT a
 * captured const). This mirrors the daemon, where `agents = container.config.agents`
 * is stable and hot-reload swaps `agents[id]` wholesale (setup-agents-runtime.ts:99).
 *
 * Four behaviors, each a fresh turn over the SAME stable `agents` map:
 *   1. an ENABLED rendererKey (`default:echo:chan-1`) renders;
 *   2. an ABSENT rendererKey (`default:echo:chan-2`) does NOT render (fail-closed);
 *   3. an IN-PLACE flip of chan-1 to `enabled:false` on the live object stops it;
 *   4. a FULL-OBJECT REPLACEMENT of `agents["default"]` (the config.write shape)
 *      stops it — this sub-test FAILS on a stale-ref getter, so it
 *      pins the re-read fix.
 *
 * Each suppress assertion (`frames.length === 0`) depends on the wired killSwitch:
 * remove it and the absent/disabled cases would render → the assertion fails →
 * genuine driver. The replacement variant additionally depends on the getter
 * RE-READING — a captured-ref getter would still see the OLD enabled object and
 * wrongly render after the swap.
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
import { createTestSink, type TestSinkRecorder } from "@comis/channels";
import { createActivityTurnCoordinator } from "@comis/orchestrator";
import { createFakeTimers, type FakeTimers } from "../../../../test/support/fake-timers.js";
import { createFakeClock } from "../../../../test/support/fake-clock.js";

const AGENT = "default";

const silentLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return this;
  },
} as never;

type AgentsMap = Record<
  string,
  { activity: { verbosity: string; emergencyDisabled: boolean; channels: Record<string, { enabled: boolean }> } }
>;

function makeCtx(rendererKey: string, channelKey: string, sessionKey: string, traceId: string): TurnActivityContext {
  return {
    agentId: AGENT,
    sessionKey,
    traceId,
    channelType: "echo",
    channelKey,
    chatType: "direct",
    inboundMessageId: `inbound-${channelKey}-${traceId}`,
    rendererKey,
  };
}

/**
 * Drive ONE turn through a fresh coordinator over the shared stable `agents` map
 * and return how many frames the sink painted. The killSwitch RE-READS
 * `agents[ctx.agentId]?.activity` per flushApply (mirrors the daemon's live getter),
 * reading through the STABLE outer `agents` ref so a later full-object swap of
 * `agents["default"]` is observed.
 */
async function runTurn(
  agents: AgentsMap,
  bus: TypedEventBus,
  stream: ReturnType<typeof createActivityStream>,
  sink: TestSinkRecorder,
  timer: FakeTimers,
  clock: ReturnType<typeof createFakeClock>,
  rendererKey: string,
  channelKey: string,
  sessionKey: string,
  traceId: string,
): Promise<number> {
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
      killSwitch: () => {
        const activity = agents[ctx.agentId]?.activity;
        return activity
          ? { emergencyDisabled: activity.emergencyDisabled, channels: activity.channels }
          : undefined;
      },
      breaker: undefined,
    });

  const ctx = makeCtx(rendererKey, channelKey, sessionKey, traceId);
  const coordinator = coordinatorFactory(ctx);
  const before = sink.recorded.frames.length;
  coordinator.start(ctx);

  bus.emit("tool:started", {
    toolName: "read_file",
    toolCallId: `call-${traceId}`,
    timestamp: 1,
    agentId: AGENT,
    sessionKey,
    traceId,
  });
  bus.emit("tool:executed", {
    toolName: "read_file",
    durationMs: 8,
    success: true,
    timestamp: 2,
    toolCallId: `call-${traceId}`,
    agentId: AGENT,
    sessionKey,
    traceId,
  });

  timer.advance(800);
  await Promise.resolve();
  const painted = sink.recorded.frames.length - before;
  coordinator.dispose();
  return painted;
}

describe("channel kill-switch: per-rendererKey gate + hot-reload via in-place flip AND full-object replacement", () => {
  it("renders an enabled rendererKey, suppresses an absent one, and hot-reloads disable both ways without rebuilding", async () => {
    const bus = new TypedEventBus();
    const stream = createActivityStream({ eventBus: bus });
    const sink = createTestSink();
    const timer = createFakeTimers(0);
    const clock = createFakeClock(0);

    // STABLE top-level map; chan-1 enabled, chan-2 absent (the daemon shape:
    // `agents = container.config.agents` is stable, only agents[id] is swapped).
    const agents: AgentsMap = {
      default: {
        activity: { verbosity: "normal", emergencyDisabled: false, channels: { "default:echo:chan-1": { enabled: true } } },
      },
    };

    // (1) ENABLED rendererKey renders.
    const enabledFrames = await runTurn(
      agents,
      bus,
      stream,
      sink,
      timer,
      clock,
      "default:echo:chan-1",
      "chan-1",
      "default:echo:chan-1",
      "t-enabled",
    );
    expect(enabledFrames).toBeGreaterThanOrEqual(1);

    // (2) ABSENT rendererKey (default:echo:chan-2 is NOT in the map) stays silent
    // — fail-closed. (Without the wired killSwitch this would render.)
    const absentFrames = await runTurn(
      agents,
      bus,
      stream,
      sink,
      timer,
      clock,
      "default:echo:chan-2",
      "chan-2",
      "default:echo:chan-2",
      "t-absent",
    );
    expect(absentFrames).toBe(0);

    // (3) IN-PLACE hot-reload: flip chan-1 to disabled on the LIVE object. A
    // subsequent turn no longer renders because the getter re-reads the flipped
    // enabled flag (no coordinator rebuild).
    agents.default.activity.channels["default:echo:chan-1"].enabled = false;
    const afterInPlaceFlip = await runTurn(
      agents,
      bus,
      stream,
      sink,
      timer,
      clock,
      "default:echo:chan-1",
      "chan-1",
      "default:echo:chan-1",
      "t-inplace",
    );
    expect(afterInPlaceFlip).toBe(0);

    // (4) FULL-OBJECT REPLACEMENT hot-reload (the real config.write shape —
    // setup-agents-runtime.ts:99 `container.config.agents[id] = effectiveConfig`).
    //
    // This sub-test MUST reuse ONE long-lived coordinator across the swap (built
    // BEFORE the replacement) — a fresh-coordinator-per-turn helper cannot
    // distinguish a re-reading getter from a per-turn-captured one. Re-enable
    // chan-1 in place, build ONE coordinator, render once (proving it is alive),
    // then swap the WHOLE per-agent object for an empty-channels one and flush
    // AGAIN on the SAME coordinator. The getter re-reads
    // `agents[ctx.agentId]?.activity` fresh through the STABLE outer ref every
    // flushApply, so it picks up the NEW object and suppresses the second flush.
    // A getter that captured the per-agent object at construction would still see
    // the OLD enabled object and wrongly paint a second frame — so this assertion
    // fails on the stale-ref bug.
    agents.default.activity.channels["default:echo:chan-1"].enabled = true;

    const liveCtx = makeCtx("default:echo:chan-1", "chan-1", "default:echo:chan-1", "t-live");
    const liveCoordinator = createActivityTurnCoordinator({
      activityStreamPort: stream,
      renderer: sink,
      projection: chatProjection,
      timer,
      clock,
      logger: silentLogger,
      config: { verbosity: "verbose" },
      killSwitch: () => {
        const activity = agents[liveCtx.agentId]?.activity;
        return activity
          ? { emergencyDisabled: activity.emergencyDisabled, channels: activity.channels }
          : undefined;
      },
      breaker: undefined,
    });
    liveCoordinator.start(liveCtx);

    // First flush while enabled → renders.
    bus.emit("tool:started", {
      toolName: "read_file",
      toolCallId: "call-live-1",
      timestamp: 10,
      agentId: AGENT,
      sessionKey: "default:echo:chan-1",
      traceId: "t-live",
    });
    bus.emit("tool:executed", {
      toolName: "read_file",
      durationMs: 8,
      success: true,
      timestamp: 11,
      toolCallId: "call-live-1",
      agentId: AGENT,
      sessionKey: "default:echo:chan-1",
      traceId: "t-live",
    });
    timer.advance(800);
    await Promise.resolve();
    const framesBeforeSwap = sink.recorded.frames.length;
    expect(framesBeforeSwap).toBeGreaterThan(0);

    // Swap the WHOLE per-agent object (the config.write hot-reload shape).
    agents["default"] = {
      activity: { verbosity: "normal", emergencyDisabled: false, channels: {} },
    };

    // Second flush on the SAME coordinator → the re-read getter sees the NEW
    // empty-channels object and suppresses. No new frame is painted.
    bus.emit("tool:executed", {
      toolName: "read_file",
      durationMs: 9,
      success: true,
      timestamp: 12,
      toolCallId: "call-live-2",
      agentId: AGENT,
      sessionKey: "default:echo:chan-1",
      traceId: "t-live",
    });
    timer.advance(800);
    await Promise.resolve();
    expect(sink.recorded.frames.length).toBe(framesBeforeSwap);

    liveCoordinator.dispose();
    stream.dispose();
  });
});
