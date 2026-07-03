// SPDX-License-Identifier: Apache-2.0
/**
 * activity-kill-switch.emergency.test — emergency stop + hot-reload.
 *
 * `agents.<id>.activity.emergencyDisabled:true` is the agent-wide emergency
 * stop: it suppresses ALL activity rendering for the agent regardless
 * of any per-renderer `channels.<key>.enabled`. The gate inside `flushApply()`
 * reads a LIVE getter on every flush, so an operator `config.write` flip of
 * `emergencyDisabled` takes effect WITHOUT reconstructing the coordinator
 * (Comis "config-watcher" = the in-memory config.write RPC propagation).
 *
 * Observable: with `emergencyDisabled:true` the `renderer.apply` spy is NOT
 * called even though the per-renderer switch is enabled; after flipping the
 * SAME backing object to `false` mid-run, the next flush DOES call apply.
 * Without the gate, apply fires on the first flush regardless.
 */
import type {
  ActivityEvent,
  ActivityStreamPort,
  ActivitySubscription,
  ActivityRenderFrame,
  ChannelActivityRenderer,
  ActivityRenderError,
  TurnActivityContext,
  ProjectionConfig,
} from "@comis/core";
import { chatProjection } from "@comis/core";
import { ok, type Result } from "@comis/shared";
import { describe, it, expect, vi } from "vitest";
import { createFakeTimers } from "../../../../test/support/fake-timers.js";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

import { createActivityTurnCoordinator } from "./activity-turn-coordinator.js";

// ---------------------------------------------------------------------------
// Doubles (forked from activity-turn-coordinator.test.ts:43-167)
// ---------------------------------------------------------------------------

const RENDERER_KEY = "agent-1:telegram:chat-1:group";

function makeCtx(overrides?: Partial<TurnActivityContext>): TurnActivityContext {
  return {
    agentId: "agent-1",
    sessionKey: "default:user-1:chat-1",
    traceId: "trace-1",
    channelType: "telegram",
    channelKey: "chat-1",
    chatType: "group",
    inboundMessageId: "in-1",
    rendererKey: RENDERER_KEY,
    ...overrides,
  };
}

let tsCounter = 0;
function makeEvent(overrides?: Partial<ActivityEvent>): ActivityEvent {
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

function makeStreamPort(): {
  port: ActivityStreamPort;
  emit: (e: ActivityEvent) => void;
} {
  let onEvent: ((e: ActivityEvent) => void) | undefined;
  const port: ActivityStreamPort = {
    subscribeForTurn(_ctx: TurnActivityContext, cb: (e: ActivityEvent) => void): ActivitySubscription {
      onEvent = cb;
      return { unsubscribe: () => {} };
    },
  };
  return { port, emit: (e) => onEvent?.(e) };
}

interface RecordingRenderer extends ChannelActivityRenderer {
  applyFrames: ActivityRenderFrame[];
}

function makeRenderer(): RecordingRenderer {
  const applyFrames: ActivityRenderFrame[] = [];
  return {
    strategy: "EditPlace",
    canDelete: true,
    canEdit: true,
    applyFrames,
    async apply(frame: ActivityRenderFrame): Promise<Result<void, ActivityRenderError>> {
      applyFrames.push(frame);
      return ok(undefined);
    },
    async finalize(): Promise<Result<void, ActivityRenderError>> {
      return ok(undefined);
    },
  };
}

const PROJECTION = (events: readonly ActivityEvent[], config: ProjectionConfig, prev?: ActivityRenderFrame) =>
  chatProjection(events, config, prev);

interface KillSwitchValue {
  emergencyDisabled: boolean;
  channels: Record<string, { enabled: boolean }>;
}

function makeKillSwitchDeps(backing: KillSwitchValue, renderer: RecordingRenderer) {
  const clock = createFakeClock(0);
  const timer = createFakeTimers(0);
  const stream = makeStreamPort();
  const logger = createMockLogger();
  return {
    deps: {
      activityStreamPort: stream.port,
      renderer,
      projection: PROJECTION,
      timer,
      clock,
      logger,
      config: { verbosity: "normal" as const },
      // The getter returns the SAME backing object every call — flipping a field
      // on `backing` mid-run is what proves the gate reads it live.
      killSwitch: (): KillSwitchValue => backing,
    },
    timer,
    stream,
  };
}

// ---------------------------------------------------------------------------
// Emergency stop + hot-reload
// ---------------------------------------------------------------------------

describe("createActivityTurnCoordinator — emergency stop + hot-reload", () => {
  it("suppresses renderer.apply for any renderer when emergencyDisabled is true", () => {
    const renderer = makeRenderer();
    const applySpy = vi.spyOn(renderer, "apply");
    // Per-renderer switch is ENABLED, but the agent-wide emergency stop wins.
    const backing: KillSwitchValue = {
      emergencyDisabled: true,
      channels: { [RENDERER_KEY]: { enabled: true } },
    };
    const { deps, timer, stream } = makeKillSwitchDeps(backing, renderer);
    const coord = createActivityTurnCoordinator(deps);
    coord.start(makeCtx());

    stream.emit(makeEvent({ defaultLabel: "a", status: "completed", phase: "end" }));
    timer.advance(800);

    expect(applySpy).not.toHaveBeenCalled();

    coord.dispose();
  });

  it("hot-reloads emergencyDisabled without reconstructing the coordinator", () => {
    const renderer = makeRenderer();
    const applySpy = vi.spyOn(renderer, "apply");
    // Start emergency-disabled with the per-renderer switch on.
    const backing: KillSwitchValue = {
      emergencyDisabled: true,
      channels: { [RENDERER_KEY]: { enabled: true } },
    };
    const { deps, timer, stream } = makeKillSwitchDeps(backing, renderer);
    const coord = createActivityTurnCoordinator(deps);
    coord.start(makeCtx());

    // First flush while emergency-disabled → suppressed.
    stream.emit(makeEvent({ defaultLabel: "first", status: "completed", phase: "end" }));
    timer.advance(800);
    expect(applySpy).not.toHaveBeenCalled();

    // Operator flips the emergency stop OFF in-memory (config.write propagation)
    // WITHOUT reconstructing the coordinator. The same backing object mutates.
    backing.emergencyDisabled = false;

    // A subsequent flush must now paint — proving the gate read the LIVE value.
    stream.emit(makeEvent({ defaultLabel: "second", status: "completed", phase: "end" }));
    timer.advance(800);
    expect(applySpy).toHaveBeenCalledTimes(1);
    expect(renderer.applyFrames.length).toBe(1);

    coord.dispose();
  });
});
