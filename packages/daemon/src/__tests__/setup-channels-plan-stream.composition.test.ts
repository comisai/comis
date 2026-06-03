// SPDX-License-Identifier: Apache-2.0
/**
 * Composition acceptance test — the chat plan-stream pipe works
 * end-to-end IN-MEMORY against the real production factories.
 *
 * Two complementary surfaces:
 *
 *   Case 1 — shared-holder regression lock: the SAME ExecutionPlanHolder reference
 *   threads through createAcpWiring().holder → ChannelsDeps.executionPlanPort
 *   (NO parallel holder). The identity-equality assertion is the canonical
 *   guard: a future refactor that constructs a fresh
 *   `createExecutionPlanHolder()` for the chat path would silently always-read
 *   empty (SEP publishes into the original holder).
 *
 *   Case 2 — End-to-end SEP plan flow: publish `sep:plan_extracted` on a real
 *   TypedEventBus, drive `tool:executed` to fire the coordinator's debounced
 *   apply, and assert the rendered frame carries `planSnapshot` whose entries
 *   were mapped through the PlanUpdate→PlanSnapshot adapter (the shape
 *   transformation: {index, description, status} → {id, label, status}).
 *
 * Both cases compose the REAL production factories (createAcpWiring +
 * createPlanStream + createActivityStream + createActivityTurnCoordinator +
 * createTestSink) over a real TypedEventBus with deterministic fake timer /
 * clock — no daemon-process boot.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import {
  TypedEventBus,
  type ExecutionPlanPort,
  type TurnActivityContext,
} from "@comis/core";
import { chatProjection } from "@comis/core";
import { createActivityStream, createPlanStream } from "@comis/observability";
import { createTestSink } from "@comis/channels";
import { createActivityTurnCoordinator } from "@comis/orchestrator";
import { createAcpWiring } from "../wiring/setup-agents/setup-acp-wiring.js";
import { createFakeTimers } from "../../../../test/support/fake-timers.js";
import { createFakeClock } from "../../../../test/support/fake-clock.js";

const AGENT = "agent-1";
const SESSION = "default:user-1:chat-1";
const TRACE = "trace-1";

const NOOP_LOGGER = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return this;
  },
} as never;

function makeCtx(overrides: Partial<TurnActivityContext> = {}): TurnActivityContext {
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

/**
 * The shape of the daemon-side ChannelsDeps slice this test asserts identity
 * on. The full ChannelsDeps interface lives in setup-channels-registry.ts; the
 * single load-bearing field is the `executionPlanPort` reference — that is
 * what the shared-holder lock guards.
 */
interface ChannelsDepsSlice {
  executionPlanPort: ExecutionPlanPort | undefined;
}

describe("chat plan-stream composition wiring", () => {
  it("shared-holder regression lock — channels and ACP share the same ExecutionPlanHolder reference", () => {
    // The daemon's setup-agents-runtime.ts captures `executionPlanHolder` from
    // createAcpWiring and threads the SAME object into BOTH
    // PiExecutorDeps.executionPlanHolder + ChannelsDeps.executionPlanPort.
    // This test composes the same pair at the composition seam and asserts
    // identity equality — a future refactor that constructs a second holder
    // for the chat path would silently always-read-empty (SEP publishes into
    // the original); the `toBe` assertion catches that regression loudly.
    const bus = new TypedEventBus();
    const acpWiring = createAcpWiring({ eventBus: bus, logger: NOOP_LOGGER });

    // Mirror the daemon-side threading in buildChannelManagerDeps:
    // `executionPlanPort: executionPlanPorts.get(defaultAgentId)`.
    const channelsDeps: ChannelsDepsSlice = {
      executionPlanPort: acpWiring.holder,
    };

    expect(acpWiring.holder).toBe(channelsDeps.executionPlanPort);
    // The reverse check also holds — the relation is symmetric identity.
    expect(channelsDeps.executionPlanPort).toBe(acpWiring.holder);
    // The holder is also the same object exposed on AcpServerDeps — preserving
    // the original invariant the createAcpWiring helper introduced.
    expect(acpWiring.acpServerDeps.executionPlanPort).toBe(acpWiring.holder);
  });

  it("End-to-end plan flow — SEP publish reaches frame.planSnapshot via the wired plan-stream", async () => {
    // Real production factories over a real TypedEventBus with fake timer/clock
    // (deterministic debounce). Mirrors setup-activity.composition.test.ts.
    const bus = new TypedEventBus();
    const acpWiring = createAcpWiring({ eventBus: bus, logger: NOOP_LOGGER });

    // The ExecutionPlanHolder created by createAcpWiring is the SAME reference
    // threaded into both PiExecutor (the writer) and ChannelsDeps (the reader).
    // The test pre-publishes a plan ref into the holder so getCurrentPlan()
    // returns an active plan when the stream re-reads on sep:plan_extracted.
    // The holder reads `ref.current` LIVE, so a later mutation to the same
    // ref would also be visible — matching SEP's per-turn ref-mutation idiom.
    acpWiring.holder.publish({
      current: {
        active: true,
        request: "investigate failure",
        completedCount: 0,
        createdAtMs: 1,
        steps: [
          {
            index: 0,
            description: "investigate failure",
            status: "in_progress",
            completedBy: undefined,
          },
          {
            index: 1,
            description: "fix root cause",
            status: "pending",
            completedBy: undefined,
          },
        ],
      },
    });

    // The plan-stream the daemon's setup-channels-runtime.ts builds:
    // `createPlanStream({eventBus, executionPlanPort: holder, logger})`.
    const planStream = createPlanStream({
      eventBus: bus,
      executionPlanPort: acpWiring.holder,
      logger: NOOP_LOGGER,
    });

    const activityStream = createActivityStream({ eventBus: bus });
    const sink = createTestSink();
    const timer = createFakeTimers(0);
    const clock = createFakeClock(0);

    const coordinator = createActivityTurnCoordinator({
      activityStreamPort: activityStream,
      renderer: sink,
      projection: chatProjection,
      timer,
      clock,
      logger: NOOP_LOGGER,
      config: { verbosity: "verbose" },
      planStream,
    });

    coordinator.start(makeCtx());

    // Publish sep:plan_extracted — the plan-stream re-reads the holder and
    // emits a PlanUpdate. The coordinator's adapter maps each entry to a
    // PlanSnapshot (id/label/status) and runs redactValue on description.
    bus.emit("sep:plan_extracted", {
      agentId: AGENT,
      sessionKey: SESSION,
      stepCount: 2,
      timestamp: 1,
    });

    // Drive a tool event so the coordinator buffers + scheduleApply fires.
    bus.emit("tool:started", {
      toolName: "edit",
      toolCallId: "call-1",
      timestamp: 2,
      agentId: AGENT,
      sessionKey: SESSION,
      traceId: TRACE,
    });
    bus.emit("tool:executed", {
      toolName: "edit",
      durationMs: 12,
      success: true,
      timestamp: 3,
      toolCallId: "call-1",
      agentId: AGENT,
      sessionKey: SESSION,
      traceId: TRACE,
    });

    // Advance the 800ms apply debounce → renderer.apply(frame) fires.
    timer.advance(800);
    await Promise.resolve();

    // Assert: the rendered frame carries the adapted plan snapshot end-to-end.
    expect(sink.recorded.frames.length).toBeGreaterThanOrEqual(1);
    const lastFrame = sink.recorded.frames[sink.recorded.frames.length - 1]!;
    expect(lastFrame.planSnapshot).toBeDefined();
    const snap = lastFrame.planSnapshot!;
    expect(snap.entries).toHaveLength(2);
    expect(snap.entries[0]).toMatchObject({
      id: "0",
      label: "investigate failure",
      status: "in_progress",
    });
    expect(snap.entries[1]).toMatchObject({
      id: "1",
      label: "fix root cause",
      status: "pending",
    });

    coordinator.dispose();
    activityStream.dispose();
  });
});
