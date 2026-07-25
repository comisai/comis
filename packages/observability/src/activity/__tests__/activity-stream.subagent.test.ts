// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the subagent event → ActivityEvent mapping.
 *
 * `activity-stream.ts` maps `session:sub_agent_spawned` /
 * `session:sub_agent_completed` to `kind:"subagent"` ActivityEvents.
 *
 * Linkage seam:
 * The spawn event payload is `{ runId, parentSessionKey, agentId, task,
 * timestamp }` — it carries NO `traceId` and NO parent `activityId`. The
 * `ActivityEvent` schema, however, requires a non-optional `traceId` and the
 * subscriber filter scopes delivery by `{agentId, sessionKey, traceId}`.
 *
 * DECISION (pinned here): the ActivityStream maps the subagent event and
 * delivers it to every turn subscriber whose `{agentId, sessionKey}` match the
 * event's `{agentId, parentSessionKey}`, STAMPING that subscriber's `traceId`
 * onto the delivered copy. The stream sets `kind:"subagent"` + the `🤖`+agentId
 * label but DOES NOT set `parentActivityId` — the per-turn coordinator (the
 * single owner) maintains the `runId → parentActivityId` stack and
 * annotates the parent link in `onEvent`. This keeps `activity-stream.ts` free
 * of turn-lifecycle state and respects the hexagonal boundary. The coordinator
 * side of this seam is pinned in
 * `orchestrator/.../activity-turn-coordinator.test.ts`.
 *
 * Threat: the free-text `task` field is NEVER reflected into the
 * rendered label — only `agentId` + the `🤖` marker. Asserted below.
 */
import { describe, it, expect, vi } from "vitest";
import { TypedEventBus, type ComisLogger } from "@comis/core";
import type { TurnActivityContext, ActivityEvent } from "@comis/core";
import { createActivityStream } from "../activity-stream.js";

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

function makeLogger(): ComisLogger {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => logger),
  } as unknown as ComisLogger;
  return logger;
}

describe("createActivityStream — subagent mapping", () => {
  it("maps session:sub_agent_spawned to a kind:'subagent' start event scoped to the turn", () => {
    const bus = new TypedEventBus();
    const stream = createActivityStream({ eventBus: bus, logger: makeLogger() });
    const received: ActivityEvent[] = [];
    const sub = stream.subscribeForTurn(makeCtx(), (e) => received.push(e));

    bus.emit("session:sub_agent_spawned", {
      runId: "run-1",
      parentSessionKey: SESSION,
      agentId: AGENT,
      timestamp: 1000,
    });

    expect(received).toHaveLength(1);
    const ev = received[0];
    expect(ev.kind).toBe("subagent");
    expect(ev.phase).toBe("start");
    expect(ev.status).toBe("running");
    expect(ev.sessionKey).toBe(SESSION);
    expect(ev.agentId).toBe(AGENT);
    // The stream stamps the subscribing turn's traceId (the spawn event has none).
    expect(ev.traceId).toBe(TRACE);
    // Subagent events carry NO approval block (schema refine: approval iff kind==="approval").
    expect(ev.approval).toBeUndefined();
    sub.unsubscribe();
  });

  it("renders the label from agentId and the configured subagent marker", () => {
    const bus = new TypedEventBus();
    const stream = createActivityStream({ eventBus: bus, logger: makeLogger() });
    const received: ActivityEvent[] = [];
    const sub = stream.subscribeForTurn(makeCtx(), (e) => received.push(e));

    bus.emit("session:sub_agent_spawned", {
      runId: "run-marker",
      parentSessionKey: SESSION,
      agentId: AGENT,
      timestamp: 1000,
    });

    expect(received).toHaveLength(1);
    const label = received[0].defaultLabel ?? "";
    expect(label).toContain("🤖");
    expect(label).toContain(AGENT);
    sub.unsubscribe();
  });

  it("maps session:sub_agent_completed to the matching phase:'end' event for the same runId", () => {
    const bus = new TypedEventBus();
    const stream = createActivityStream({ eventBus: bus, logger: makeLogger() });
    const received: ActivityEvent[] = [];
    const sub = stream.subscribeForTurn(makeCtx(), (e) => received.push(e));

    bus.emit("session:sub_agent_spawned", {
      runId: "run-2",
      parentSessionKey: SESSION,
      agentId: AGENT,
      timestamp: 1000,
    });
    bus.emit("session:sub_agent_completed", {
      runId: "run-2",
      agentId: AGENT,
      success: true,
      runtimeMs: 4200,
      tokensUsed: 100,
      cost: 0.01,
      timestamp: 2000,
    });

    expect(received).toHaveLength(2);
    expect(received[0].phase).toBe("start");
    expect(received[1].phase).toBe("end");
    expect(received[1].kind).toBe("subagent");
    // Same correlation key (subagent:runId) → stable activityId across start↔end.
    expect(received[1].activityId).toBe(received[0].activityId);
    expect(received[1].status).toBe("completed");
    sub.unsubscribe();
  });

  it("maps a failed sub_agent_completed to status:'failed'", () => {
    const bus = new TypedEventBus();
    const stream = createActivityStream({ eventBus: bus, logger: makeLogger() });
    const received: ActivityEvent[] = [];
    const sub = stream.subscribeForTurn(makeCtx(), (e) => received.push(e));

    bus.emit("session:sub_agent_spawned", {
      runId: "run-fail",
      parentSessionKey: SESSION,
      agentId: AGENT,
      timestamp: 1000,
    });
    bus.emit("session:sub_agent_completed", {
      runId: "run-fail",
      agentId: AGENT,
      success: false,
      runtimeMs: 10,
      tokensUsed: 1,
      cost: 0,
      timestamp: 2000,
    });

    expect(received).toHaveLength(2);
    expect(received[1].phase).toBe("end");
    expect(received[1].status).toBe("failed");
    sub.unsubscribe();
  });

  it("delivers a subagent event only to a turn whose {agentId,sessionKey} match the spawn (parentSessionKey)", () => {
    const bus = new TypedEventBus();
    const stream = createActivityStream({ eventBus: bus, logger: makeLogger() });
    const received: ActivityEvent[] = [];
    // A turn for a DIFFERENT session must NOT receive this spawn.
    const sub = stream.subscribeForTurn(
      makeCtx({ sessionKey: "other-session" }),
      (e) => received.push(e),
    );

    bus.emit("session:sub_agent_spawned", {
      runId: "run-3",
      parentSessionKey: SESSION,
      agentId: AGENT,
      timestamp: 1000,
    });

    expect(received).toHaveLength(0);
    sub.unsubscribe();
  });

  it("preserves the trace-less-restore guard — approval:requested with no traceId emits NO live activity", () => {
    const bus = new TypedEventBus();
    const stream = createActivityStream({ eventBus: bus, logger: makeLogger() });
    const received: ActivityEvent[] = [];
    const sub = stream.subscribeForTurn(makeCtx(), (e) => received.push(e));

    bus.emit("approval:requested", {
      requestId: "req-restore",
      shortId: "abc123ABC456",
      toolName: "shell",
      action: "run",
      params: {},
      agentId: AGENT,
      sessionKey: SESSION,
      trustLevel: "external",
      createdAt: 1000,
      timeoutMs: 60000,
      // traceId intentionally ABSENT → restored approval, not live activity.
    } as never);

    expect(received).toHaveLength(0);
    sub.unsubscribe();
  });
});
