// SPDX-License-Identifier: Apache-2.0
/**
 * activity-kill-switch.channel.test — per-renderer enable gate.
 *
 * The operator kill switch `agents.<id>.activity.channels.<rendererKey>.enabled`
 * is enforced inside the coordinator's `flushApply()` BEFORE `renderer.apply` is
 * called. When the rendererKey's channels entry is `enabled:false`, no activity
 * frame is painted for that renderer; when `enabled:true`, the apply fires
 * normally. Lifecycle reactions + final delivery are out of scope (they do not
 * flow through `renderer.apply`).
 *
 * Observable: the `renderer.apply` spy is NOT called when the switch is off,
 * and IS called when it is on. Without the gate, apply always
 * fires regardless of the kill switch.
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

/**
 * The live kill-switch shape the gate reads. A mutable backing object lets the
 * test flip values mid-run to prove the gate reads it live (hot-reload).
 */
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
      // The live getter the gate reads on every flushApply.
      killSwitch: (): KillSwitchValue => backing,
    },
    timer,
    stream,
  };
}

// ---------------------------------------------------------------------------
// Per-renderer enable gate
// ---------------------------------------------------------------------------

describe("createActivityTurnCoordinator — per-renderer kill switch", () => {
  it("suppresses renderer.apply when the per-renderer channel switch is disabled", () => {
    const renderer = makeRenderer();
    const applySpy = vi.spyOn(renderer, "apply");
    const backing: KillSwitchValue = {
      emergencyDisabled: false,
      channels: { [RENDERER_KEY]: { enabled: false } },
    };
    const { deps, timer, stream } = makeKillSwitchDeps(backing, renderer);
    const coord = createActivityTurnCoordinator(deps);
    coord.start(makeCtx());

    stream.emit(makeEvent({ defaultLabel: "a", status: "completed", phase: "end" }));
    timer.advance(800);

    // enabled:false → the gate must short-circuit before renderer.apply.
    expect(applySpy).not.toHaveBeenCalled();
    expect(renderer.applyFrames.length).toBe(0);

    coord.dispose();
  });

  it("calls renderer.apply when the per-renderer channel switch is enabled", () => {
    const renderer = makeRenderer();
    const applySpy = vi.spyOn(renderer, "apply");
    const backing: KillSwitchValue = {
      emergencyDisabled: false,
      channels: { [RENDERER_KEY]: { enabled: true } },
    };
    const { deps, timer, stream } = makeKillSwitchDeps(backing, renderer);
    const coord = createActivityTurnCoordinator(deps);
    coord.start(makeCtx());

    stream.emit(makeEvent({ defaultLabel: "a", status: "completed", phase: "end" }));
    timer.advance(800);

    // enabled:true (and not emergency-disabled) → apply fires normally.
    expect(applySpy).toHaveBeenCalledTimes(1);
    expect(renderer.applyFrames.length).toBe(1);

    coord.dispose();
  });
});
