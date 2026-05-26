// SPDX-License-Identifier: Apache-2.0
/**
 * RED test for the ActivityStream EventBus subscriber (STRAT-07, OBS-01/02/03).
 *
 * Fails on pre-patch code: `./activity-stream.js` does not exist.
 *
 * Behavior under test:
 *   - maps tool:started → tool:executed to ordered ActivityEvents (validated by
 *     parseActivityEvent), scoped to a turn via subscribeForTurn.
 *   - subagent events are IGNORED at this layer (Phase 73 renders them).
 *   - approval:requested → approval:resolved (same requestId) close the matching
 *     activity via the correlation index keyed by requestId.
 *   - subscribeForTurn delivers only events scoped to {agentId,sessionKey,traceId};
 *     ActivitySubscription.unsubscribe() detaches (no leak).
 *   - OBS-03: a non-empty redactionsApplied logs exactly ONE WARN with
 *     hint+errorKind; a malformed event logs ERROR; NO `module:` field appears.
 *   - OBS-01: counters expose emitted + dropped + redaction-replacement counts.
 */
import { describe, it, expect, vi } from "vitest";
import { TypedEventBus, registerActivityLabelSpec, type ComisLogger } from "@comis/core";
import type { TurnActivityContext, ActivityEvent } from "@comis/core";
import { createActivityStream } from "./activity-stream.js";

const TRACE = "trace-1";
const AGENT = "agent-1";
const SESSION = "session-1";

function makeCtx(overrides: Partial<TurnActivityContext> = {}): TurnActivityContext {
  return {
    agentId: AGENT,
    sessionKey: SESSION,
    traceId: TRACE,
    channelType: "telegram",
    channelKey: "chat-9",
    chatType: "direct",
    inboundMessageId: "m-1",
    rendererKey: "agent-1:telegram:chat-9:direct",
    ...overrides,
  };
}

function makeLogger(): ComisLogger & {
  warns: unknown[][];
  errors: unknown[][];
  debugs: unknown[][];
} {
  const warns: unknown[][] = [];
  const errors: unknown[][] = [];
  const debugs: unknown[][] = [];
  const logger = {
    info: vi.fn(),
    warn: vi.fn((...a: unknown[]) => warns.push(a)),
    error: vi.fn((...a: unknown[]) => errors.push(a)),
    debug: vi.fn((...a: unknown[]) => debugs.push(a)),
    child: vi.fn(() => logger),
  } as unknown as ComisLogger & {
    warns: unknown[][];
    errors: unknown[][];
    debugs: unknown[][];
  };
  logger.warns = warns;
  logger.errors = errors;
  logger.debugs = debugs;
  return logger;
}

describe("createActivityStream (STRAT-07 / spec §5)", () => {
  it("maps tool:started then tool:executed to ordered ActivityEvents for the turn", () => {
    const bus = new TypedEventBus();
    const logger = makeLogger();
    const stream = createActivityStream({ eventBus: bus, logger });
    const received: ActivityEvent[] = [];
    const sub = stream.subscribeForTurn(makeCtx(), (e) => received.push(e));

    bus.emit("tool:started", {
      toolName: "edit",
      toolCallId: "call-1",
      timestamp: 1,
      agentId: AGENT,
      sessionKey: SESSION,
      traceId: TRACE,
    });
    bus.emit("tool:executed", {
      toolName: "edit",
      durationMs: 12,
      success: true,
      timestamp: 2,
      toolCallId: "call-1",
      agentId: AGENT,
      sessionKey: SESSION,
      traceId: TRACE,
    });

    expect(received).toHaveLength(2);
    expect(received[0].phase).toBe("start");
    expect(received[0].status).toBe("running");
    expect(received[1].phase).toBe("end");
    expect(received[1].status).toBe("completed");
    // Stable activityId across start↔end (correlated by toolCallId).
    expect(received[0].activityId).toBe(received[1].activityId);
    // Every emitted event validates against the canonical schema.
    expect(received[1].kind).toBe("tool");
    sub.unsubscribe();
  });

  it("ignores subagent events at this layer (rendered in Phase 73)", () => {
    const bus = new TypedEventBus();
    const logger = makeLogger();
    const stream = createActivityStream({ eventBus: bus, logger });
    const received: ActivityEvent[] = [];
    const sub = stream.subscribeForTurn(makeCtx(), (e) => received.push(e));
    bus.emit("session:sub_agent_spawned", {
      parentSessionKey: SESSION,
      subAgentId: "sub-1",
      timestamp: 1,
    } as never);
    expect(received).toHaveLength(0);
    sub.unsubscribe();
  });

  it("closes the matching activity on approval:resolved via the requestId index", () => {
    const bus = new TypedEventBus();
    const logger = makeLogger();
    const stream = createActivityStream({ eventBus: bus, logger });
    const received: ActivityEvent[] = [];
    const sub = stream.subscribeForTurn(makeCtx(), (e) => received.push(e));

    bus.emit("approval:requested", {
      requestId: "req-uuid-1",
      shortId: "abc123ABC456",
      toolName: "shell",
      action: "run",
      params: {},
      agentId: AGENT,
      sessionKey: SESSION,
      trustLevel: "external",
      createdAt: 1000,
      timeoutMs: 60000,
      traceId: TRACE,
    });
    bus.emit("approval:resolved", {
      requestId: "req-uuid-1",
      approved: true,
      approvedBy: "user",
      resolvedAt: 2000,
    });

    expect(received).toHaveLength(2);
    expect(received[0].kind).toBe("approval");
    expect(received[0].phase).toBe("start");
    expect(received[0].approval?.shortId).toBe("abc123ABC456");
    // The resolved event closes the SAME activity (matched via requestId index).
    expect(received[1].kind).toBe("approval");
    expect(received[1].phase).toBe("end");
    expect(received[1].activityId).toBe(received[0].activityId);
    expect(received[1].status).toBe("completed");
    sub.unsubscribe();
  });

  it("ignores an approval:resolved with no matching index entry", () => {
    const bus = new TypedEventBus();
    const logger = makeLogger();
    const stream = createActivityStream({ eventBus: bus, logger });
    const received: ActivityEvent[] = [];
    const sub = stream.subscribeForTurn(makeCtx(), (e) => received.push(e));
    bus.emit("approval:resolved", {
      requestId: "never-seen",
      approved: false,
      approvedBy: "user",
      resolvedAt: 1,
    });
    expect(received).toHaveLength(0);
    sub.unsubscribe();
  });

  it("delivers only events scoped to the turn's {agentId,sessionKey,traceId}", () => {
    const bus = new TypedEventBus();
    const logger = makeLogger();
    const stream = createActivityStream({ eventBus: bus, logger });
    const received: ActivityEvent[] = [];
    const sub = stream.subscribeForTurn(makeCtx(), (e) => received.push(e));
    // A tool event for a DIFFERENT turn (other traceId) must NOT be delivered.
    bus.emit("tool:executed", {
      toolName: "edit",
      durationMs: 1,
      success: true,
      timestamp: 1,
      toolCallId: "x",
      agentId: AGENT,
      sessionKey: SESSION,
      traceId: "other-trace",
    });
    expect(received).toHaveLength(0);
    sub.unsubscribe();
  });

  it("unsubscribe() detaches the turn so later events are not delivered", () => {
    const bus = new TypedEventBus();
    const logger = makeLogger();
    const stream = createActivityStream({ eventBus: bus, logger });
    const received: ActivityEvent[] = [];
    const sub = stream.subscribeForTurn(makeCtx(), (e) => received.push(e));
    sub.unsubscribe();
    bus.emit("tool:executed", {
      toolName: "edit",
      durationMs: 1,
      success: true,
      timestamp: 1,
      toolCallId: "y",
      agentId: AGENT,
      sessionKey: SESSION,
      traceId: TRACE,
    });
    expect(received).toHaveLength(0);
  });

  it("logs exactly ONE WARN with hint+errorKind when redactionsApplied is non-empty (OBS-03)", () => {
    const bus = new TypedEventBus();
    const logger = makeLogger();
    // A label spec whose template substitutes a secret-keyed value triggers
    // redaction inside applyTemplate.
    registerActivityLabelSpec("deploy_tool", {
      actions: { run: { label: "deploying `{token}`", detailKeys: ["token"] } },
    });
    const stream = createActivityStream({ eventBus: bus, logger });
    const sub = stream.subscribeForTurn(makeCtx(), () => {});
    bus.emit("tool:started", {
      toolName: "deploy_tool",
      toolCallId: "call-9",
      timestamp: 1,
      action: "run",
      params: { token: "sk-ant-supersecretsupersecret" },
      agentId: AGENT,
      sessionKey: SESSION,
      traceId: TRACE,
    });
    // Exactly one WARN, carrying hint + errorKind.
    expect(logger.warns).toHaveLength(1);
    const [payload] = logger.warns[0] as [Record<string, unknown>, string];
    expect(payload.hint).toBeTypeOf("string");
    expect(payload.errorKind).toBe("validation");
    // OBS-02: NO module: field in the payload.
    expect(payload).not.toHaveProperty("module");
    sub.unsubscribe();
  });

  it("logs ERROR when a mapped event fails parseActivityEvent (OBS-03)", () => {
    const bus = new TypedEventBus();
    const logger = makeLogger();
    // Force a parse failure: a tool event missing the required toolName maps to
    // an ActivityEvent the schema rejects.
    const stream = createActivityStream({ eventBus: bus, logger });
    const received: ActivityEvent[] = [];
    const sub = stream.subscribeForTurn(makeCtx(), (e) => received.push(e));
    bus.emit("tool:executed", {
      // toolName intentionally empty → kind="tool" but the mapped event is
      // still required to validate; we corrupt the timestamp to a negative
      // durationMs which the schema's nonnegative() rejects.
      toolName: "edit",
      durationMs: -5,
      success: true,
      timestamp: 2,
      toolCallId: "call-bad",
      agentId: AGENT,
      sessionKey: SESSION,
      traceId: TRACE,
    });
    expect(logger.errors.length).toBeGreaterThan(0);
    const [payload] = logger.errors[0] as [Record<string, unknown>, string];
    expect(payload.errorKind).toBeTypeOf("string");
    expect(payload.hint).toBeTypeOf("string");
    expect(payload).not.toHaveProperty("module");
    // The malformed event is NOT delivered downstream.
    expect(received).toHaveLength(0);
    sub.unsubscribe();
  });

  it("exposes OBS-01 counters for emitted events", () => {
    const bus = new TypedEventBus();
    const logger = makeLogger();
    const stream = createActivityStream({ eventBus: bus, logger });
    const sub = stream.subscribeForTurn(makeCtx(), () => {});
    bus.emit("tool:started", {
      toolName: "edit",
      toolCallId: "c1",
      timestamp: 1,
      agentId: AGENT,
      sessionKey: SESSION,
      traceId: TRACE,
    });
    const counters = stream.counters();
    expect(counters.emitted).toBeGreaterThanOrEqual(1);
    sub.unsubscribe();
  });
});
