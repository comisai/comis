// SPDX-License-Identifier: Apache-2.0
/**
 * activity-kill-switch.default-off.test — fail-closed default.
 *
 * The rollout-barrier safety property: a rendererKey with NO entry in the
 * `activity.channels` map is treated as disabled. The schema defaults
 * `channels` to `{}` and `enabled` to `false`, so an un-configured renderer
 * paints nothing until an operator explicitly flips it on. The gate inside
 * `flushApply()` enforces this BEFORE `renderer.apply` (`enabled !== true`
 * covers both the missing-entry and the explicit-false cases).
 *
 * Observable: the `renderer.apply` spy is NOT called when the rendererKey is
 * absent from the map. Without the gate, apply always fires.
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
      killSwitch: (): KillSwitchValue => backing,
    },
    timer,
    stream,
  };
}

// ---------------------------------------------------------------------------
// Fail-closed default (missing channels entry = disabled)
// ---------------------------------------------------------------------------

describe("createActivityTurnCoordinator — fail-closed default", () => {
  it("suppresses renderer.apply when the renderer has no channels entry (fail-closed)", () => {
    const renderer = makeRenderer();
    const applySpy = vi.spyOn(renderer, "apply");
    // The rendererKey is ABSENT from the channels map → treated as disabled.
    const backing: KillSwitchValue = {
      emergencyDisabled: false,
      channels: {},
    };
    const { deps, timer, stream } = makeKillSwitchDeps(backing, renderer);
    const coord = createActivityTurnCoordinator(deps);
    coord.start(makeCtx());

    stream.emit(makeEvent({ defaultLabel: "a", status: "completed", phase: "end" }));
    timer.advance(800);

    expect(applySpy).not.toHaveBeenCalled();
    expect(renderer.applyFrames.length).toBe(0);

    coord.dispose();
  });

  it("suppresses renderer.apply for an unrelated rendererKey while a different key is enabled", () => {
    const renderer = makeRenderer();
    const applySpy = vi.spyOn(renderer, "apply");
    // A DIFFERENT renderer is enabled, but THIS turn's rendererKey is absent.
    const backing: KillSwitchValue = {
      emergencyDisabled: false,
      channels: { "agent-1:discord:other:channel": { enabled: true } },
    };
    const { deps, timer, stream } = makeKillSwitchDeps(backing, renderer);
    const coord = createActivityTurnCoordinator(deps);
    coord.start(makeCtx());

    stream.emit(makeEvent({ defaultLabel: "a", status: "completed", phase: "end" }));
    timer.advance(800);

    // The enabled entry is for another renderer; this turn's key is still off.
    expect(applySpy).not.toHaveBeenCalled();

    coord.dispose();
  });
});
