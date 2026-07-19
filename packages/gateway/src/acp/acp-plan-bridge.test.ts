// SPDX-License-Identifier: Apache-2.0
/**
 * RED test for the ACP plan-bridge (spec §16.7 / §16.8).
 *
 * Fails on pre-patch code: `./acp-plan-bridge.js` does not exist (mirrors
 * `packages/observability/src/activity/plan-stream.test.ts:5`).
 *
 * Behavior under test (mirrors createPlanStream, then maps to the SDK Plan):
 *   - On `sep:plan_extracted` the bridge reads the live ExecutionPlan via a fake
 *     ExecutionPlanPort and emits ONE `sessionUpdate({ sessionId, update: {
 *     sessionUpdate: "plan", entries } })` whose entries map from
 *     `ExecutionPlan.steps` (priority:"medium"; SEP status → SDK PlanEntryStatus:
 *     pending→pending, in_progress→in_progress, done→completed).
 *   - SEP "skipped" maps to SDK "completed" (SDK has no "skipped") without
 *     dropping the entry (entries.length stays === steps.length).
 *   - On `tool:executed` WITH agentId+sessionKey the bridge re-reads the plan and
 *     re-emits the full entries list (checkbox transition after a step flips done).
 *   - On `tool:executed` WITHOUT agentId/sessionKey the bridge does NOT re-emit
 *     (optional ids skipped).
 *   - When `getCurrentPlan()` is undefined OR `plan.active === false` it no-ops (§16.7).
 *   - No raw params: a serialized frame contains only content/priority/status per
 *     entry — no rawInput/rawOutput/params (§19.6 M6 carried to the plan frame).
 *   - `unsubscribe()` detaches BOTH bus handlers (vi.spyOn(bus, "off") called twice).
 */
import { describe, it, expect, vi } from "vitest";
import type {
  ReadonlyExecutionPlan,
  ExecutionPlanPort,
  ComisLogger,
} from "@comis/core";
import { TypedEventBus, formatSessionKey } from "@comis/core";
import type {
  AgentSideConnection,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import { createAcpPlanBridge } from "./acp-plan-bridge.js";

/** Mutable fake ExecutionPlanPort (mirrors plan-stream.test.ts:21-32). */
function makePlanPort(plan: ReadonlyExecutionPlan | undefined): {
  port: ExecutionPlanPort;
  set: (p: ReadonlyExecutionPlan | undefined) => void;
} {
  let current = plan;
  return {
    port: { getCurrentPlan: () => current },
    set: (p) => {
      current = p;
    },
  };
}

/** Fake AgentSideConnection capturing the `plan` frames. */
function makeFakeConnection(): {
  conn: AgentSideConnection;
  frames: SessionNotification[];
} {
  const frames: SessionNotification[] = [];
  const conn = {
    sessionUpdate: vi.fn(async (p: SessionNotification) => {
      frames.push(p);
    }),
  } as unknown as AgentSideConnection;
  return { conn, frames };
}

// The server-owned ACP session map resolves this display label to the retained
// connection id; the bridge never recovers authority by parsing the label.
const ACP_SESSION_ID = "acp-session-1";
const SESSION_KEY = formatSessionKey({
  tenantId: "default",
  agentId: "a1",
  userId: "u1",
  channelId: "acp",
  peerId: ACP_SESSION_ID,
});

/** Flush microtasks so a discarded sessionUpdate promise settles before asserting. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("createAcpPlanBridge (§16.7 — SEP plan → SDK Plan, no new tool)", () => {
  it("emits a 3-step SDK Plan frame from sep:plan_extracted with mapped statuses", async () => {
    const bus = new TypedEventBus();
    const { port } = makePlanPort({
      active: true,
      request: "do the thing",
      completedCount: 1,
      steps: [
        { index: 1, description: "step one", status: "done", completedBy: ["c1"] },
        { index: 2, description: "step two", status: "in_progress" },
        { index: 3, description: "step three", status: "pending" },
      ],
    });
    const { conn, frames } = makeFakeConnection();
    const unsubscribe = createAcpPlanBridge({
      eventBus: bus,
      executionPlanPort: port,
      getConnection: (id) => (id === ACP_SESSION_ID ? conn : undefined),
      resolveAcpSessionId: () => ACP_SESSION_ID,
    });

    bus.emit("sep:plan_extracted", {
      agentId: "a1",
      sessionKey: SESSION_KEY,
      stepCount: 3,
      timestamp: Date.now(),
    });
    // sessionUpdate is async (awaited inside the bridge) — let the microtask run.
    await Promise.resolve();

    expect(frames).toHaveLength(1);
    expect(frames[0].sessionId).toBe(ACP_SESSION_ID);
    const update = frames[0].update as {
      sessionUpdate: string;
      entries: Array<{ content: string; priority: string; status: string }>;
    };
    expect(update.sessionUpdate).toBe("plan");
    expect(update.entries).toHaveLength(3);
    expect(update.entries[0]).toEqual({
      content: "step one",
      priority: "medium",
      status: "completed", // done → completed
    });
    expect(update.entries[1].status).toBe("in_progress");
    expect(update.entries[2].status).toBe("pending");
    // Every entry carries the constant medium priority.
    for (const e of update.entries) expect(e.priority).toBe("medium");

    unsubscribe();
  });

  it("maps SEP skipped → SDK completed without dropping the entry", async () => {
    const bus = new TypedEventBus();
    const { port } = makePlanPort({
      active: true,
      request: "do",
      completedCount: 1,
      steps: [
        { index: 1, description: "skip me", status: "skipped" },
        { index: 2, description: "next", status: "pending" },
      ],
    });
    const { conn, frames } = makeFakeConnection();
    const unsubscribe = createAcpPlanBridge({
      eventBus: bus,
      executionPlanPort: port,
      getConnection: () => conn,
      resolveAcpSessionId: () => ACP_SESSION_ID,
    });

    bus.emit("sep:plan_extracted", {
      agentId: "a1",
      sessionKey: SESSION_KEY,
      stepCount: 2,
      timestamp: 1,
    });
    await Promise.resolve();

    const update = frames[0].update as {
      entries: Array<{ status: string }>;
    };
    expect(update.entries).toHaveLength(2); // skipped NOT dropped
    expect(update.entries[0].status).toBe("completed"); // skipped → completed
    expect(update.entries[1].status).toBe("pending");

    unsubscribe();
  });

  it("re-emits the full entries list on tool:executed after a step flips to done", async () => {
    const bus = new TypedEventBus();
    const { port, set } = makePlanPort({
      active: true,
      request: "do",
      completedCount: 0,
      steps: [{ index: 1, description: "step one", status: "in_progress" }],
    });
    const { conn, frames } = makeFakeConnection();
    const unsubscribe = createAcpPlanBridge({
      eventBus: bus,
      executionPlanPort: port,
      getConnection: () => conn,
      resolveAcpSessionId: () => ACP_SESSION_ID,
    });

    bus.emit("sep:plan_extracted", {
      agentId: "a1",
      sessionKey: SESSION_KEY,
      stepCount: 1,
      timestamp: 1,
    });
    await Promise.resolve();
    // SEP marks the step done + correlates the toolCallId.
    set({
      active: true,
      request: "do",
      completedCount: 1,
      steps: [{ index: 1, description: "step one", status: "done", completedBy: ["call-1"] }],
    });
    bus.emit("tool:executed", {
      toolName: "edit",
      durationMs: 5,
      success: true,
      timestamp: 2,
      toolCallId: "call-1",
      agentId: "a1",
      sessionKey: SESSION_KEY,
      phase: "completed",
    });
    await Promise.resolve();

    expect(frames).toHaveLength(2);
    const second = frames[1].update as { entries: Array<{ status: string }> };
    expect(second.entries[0].status).toBe("completed");

    unsubscribe();
  });

  it("does NOT re-emit on tool:executed missing agentId/sessionKey", async () => {
    const bus = new TypedEventBus();
    const { port } = makePlanPort({
      active: true,
      request: "do",
      completedCount: 0,
      steps: [{ index: 1, description: "s", status: "pending" }],
    });
    const { conn, frames } = makeFakeConnection();
    const unsubscribe = createAcpPlanBridge({
      eventBus: bus,
      executionPlanPort: port,
      getConnection: () => conn,
      resolveAcpSessionId: () => ACP_SESSION_ID,
    });

    // No agentId / sessionKey → skipped before re-reading the plan.
    bus.emit("tool:executed", {
      toolName: "edit",
      durationMs: 1,
      success: true,
      timestamp: 1,
      toolCallId: "c",
      phase: "completed",
    });
    await Promise.resolve();

    expect(frames).toHaveLength(0);

    unsubscribe();
  });

  it("no-ops when SEP is inactive (getCurrentPlan undefined or plan.active false)", async () => {
    const busA = new TypedEventBus();
    const undefinedPort = makePlanPort(undefined);
    const a = makeFakeConnection();
    const unsubA = createAcpPlanBridge({
      eventBus: busA,
      executionPlanPort: undefinedPort.port,
      getConnection: () => a.conn,
      resolveAcpSessionId: () => ACP_SESSION_ID,
    });
    busA.emit("sep:plan_extracted", {
      agentId: "a1",
      sessionKey: SESSION_KEY,
      stepCount: 0,
      timestamp: 1,
    });
    await Promise.resolve();
    expect(a.frames).toHaveLength(0);
    unsubA();

    const busB = new TypedEventBus();
    const inactivePort = makePlanPort({
      active: false,
      request: "do",
      completedCount: 0,
      steps: [{ index: 1, description: "s", status: "pending" }],
    });
    const b = makeFakeConnection();
    const unsubB = createAcpPlanBridge({
      eventBus: busB,
      executionPlanPort: inactivePort.port,
      getConnection: () => b.conn,
      resolveAcpSessionId: () => ACP_SESSION_ID,
    });
    busB.emit("sep:plan_extracted", {
      agentId: "a1",
      sessionKey: SESSION_KEY,
      stepCount: 1,
      timestamp: 1,
    });
    await Promise.resolve();
    expect(b.frames).toHaveLength(0);
    unsubB();
  });

  it("no-ops when no connection is retained for the resolved acp session id", async () => {
    const bus = new TypedEventBus();
    const { port } = makePlanPort({
      active: true,
      request: "do",
      completedCount: 0,
      steps: [{ index: 1, description: "s", status: "pending" }],
    });
    const sessionUpdate = vi.fn();
    const unsubscribe = createAcpPlanBridge({
      eventBus: bus,
      executionPlanPort: port,
      getConnection: () => undefined, // dropped / unknown session
      resolveAcpSessionId: () => ACP_SESSION_ID,
    });
    bus.emit("sep:plan_extracted", {
      agentId: "a1",
      sessionKey: SESSION_KEY,
      stepCount: 1,
      timestamp: 1,
    });
    await Promise.resolve();
    expect(sessionUpdate).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("never leaks raw params into the plan frame (no rawInput/rawOutput/params)", async () => {
    const bus = new TypedEventBus();
    const { port } = makePlanPort({
      active: true,
      request: "do the thing",
      completedCount: 0,
      steps: [
        { index: 1, description: "step one", status: "in_progress", completedBy: ["c1"] },
      ],
    });
    const { conn, frames } = makeFakeConnection();
    const unsubscribe = createAcpPlanBridge({
      eventBus: bus,
      executionPlanPort: port,
      getConnection: () => conn,
      resolveAcpSessionId: () => ACP_SESSION_ID,
    });
    bus.emit("sep:plan_extracted", {
      agentId: "a1",
      sessionKey: SESSION_KEY,
      stepCount: 1,
      timestamp: 1,
    });
    await Promise.resolve();

    expect(frames).toHaveLength(1);
    const entry = (frames[0].update as { entries: Array<Record<string, unknown>> })
      .entries[0];
    // Only the three SDK PlanEntry fields are present.
    expect(Object.keys(entry).sort()).toEqual(["content", "priority", "status"]);
    const serialized = JSON.stringify(frames[0]);
    expect(serialized).not.toContain("rawInput");
    expect(serialized).not.toContain("rawOutput");
    expect(serialized).not.toContain("params");
    expect(serialized).not.toContain("completedBy");

    unsubscribe();
  });

  it("logs a rejected plan sessionUpdate and stays a non-throwing emitter (no unhandled rejection)", async () => {
    // The plan bridge fires `void connection.sessionUpdate(...)` per emit.
    // Pre-fix: a rejected sessionUpdate (IDE disconnects mid-turn) surfaces as
    // an unhandled rejection because nothing catches the discarded promise.
    const bus = new TypedEventBus();
    const { port } = makePlanPort({
      active: true,
      request: "do",
      completedCount: 0,
      steps: [{ index: 1, description: "s", status: "in_progress" }],
    });
    const sessionUpdate = vi
      .fn()
      .mockRejectedValue(new Error("ide plan panel closed"));
    const conn = {
      sessionUpdate,
    } as unknown as AgentSideConnection;

    const debugCalls: Array<{ fields: unknown; msg: string }> = [];
    const logger = {
      level: "debug",
      trace: vi.fn(),
      debug: vi.fn((fields: unknown, msg: string) => {
        debugCalls.push({ fields, msg });
      }),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      audit: vi.fn(),
      child: vi.fn(),
    } as unknown as ComisLogger;

    const unsubscribe = createAcpPlanBridge({
      eventBus: bus,
      executionPlanPort: port,
      getConnection: () => conn,
      resolveAcpSessionId: () => ACP_SESSION_ID,
      logger,
    });

    bus.emit("sep:plan_extracted", {
      agentId: "a1",
      sessionKey: SESSION_KEY,
      stepCount: 1,
      timestamp: 1,
    });
    // Drain the microtask queue so the discarded sessionUpdate promise settles.
    await flush();

    // (a) no unhandled rejection (the await of `flush()` would surface it),
    // (b) the rejection was logged with the canonical `err` field + context.
    expect(sessionUpdate).toHaveBeenCalledTimes(1);
    const errLog = debugCalls.find(
      (c) => (c.fields as { err?: unknown }).err !== undefined,
    );
    expect(errLog).toBeDefined();
    expect((errLog!.fields as { err?: Error }).err).toBeInstanceOf(Error);
    expect((errLog!.fields as { acpSessionId?: string }).acpSessionId).toBe(
      ACP_SESSION_ID,
    );

    unsubscribe();
  });

  it("unsubscribe() detaches both the sep:plan_extracted and tool:executed handlers", async () => {
    const bus = new TypedEventBus();
    const offSpy = vi.spyOn(bus, "off");
    const { port } = makePlanPort({
      active: true,
      request: "do",
      completedCount: 0,
      steps: [{ index: 1, description: "s", status: "pending" }],
    });
    const { conn, frames } = makeFakeConnection();
    const unsubscribe = createAcpPlanBridge({
      eventBus: bus,
      executionPlanPort: port,
      getConnection: () => conn,
      resolveAcpSessionId: () => ACP_SESSION_ID,
    });

    unsubscribe();
    // Both sep:plan_extracted and tool:executed handlers detached (no leak).
    expect(offSpy).toHaveBeenCalledTimes(2);

    // After unsubscribe neither event reaches the bridge.
    bus.emit("sep:plan_extracted", {
      agentId: "a1",
      sessionKey: SESSION_KEY,
      stepCount: 1,
      timestamp: 1,
    });
    bus.emit("tool:executed", {
      toolName: "edit",
      durationMs: 1,
      success: true,
      timestamp: 2,
      toolCallId: "c",
      agentId: "a1",
      sessionKey: SESSION_KEY,
      phase: "completed",
    });
    await Promise.resolve();
    expect(frames).toHaveLength(0);
  });
});
