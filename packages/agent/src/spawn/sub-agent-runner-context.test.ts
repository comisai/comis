// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createConversationLocator,
  createDeliveryOrigin,
  getContext,
  runWithContext,
  type ClockPort,
  type RequestContext,
  type TimerHandle,
  type TimerPort,
} from "@comis/core";
import { ok } from "@comis/shared";
import {
  createSubAgentRunner,
  type SubAgentRunnerDeps,
} from "./sub-agent-runner.js";

function wrapTimerHandle(timer: NodeJS.Timeout): TimerHandle {
  let cancelled = false;
  let unrefCalled = false;
  return {
    get cancelled() {
      return cancelled;
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      clearTimeout(timer);
    },
    unref() {
      if (cancelled || unrefCalled) return;
      unrefCalled = true;
      timer.unref();
    },
  };
}

const testClock: ClockPort = {
  now: () => Date.now(),
  nowDate: () => new Date(),
};

const testTimers: TimerPort = {
  setTimeout: (callback, delayMs) => wrapTimerHandle(setTimeout(callback, delayMs)),
  setInterval: (callback, delayMs) => wrapTimerHandle(setInterval(callback, delayMs)),
};

function successResult(response = "done") {
  return {
    response,
    tokensUsed: { total: 10 },
    cost: { total: 0.001 },
    finishReason: "stop",
    stepsExecuted: 1,
  };
}

function createDeps(
  executeAgent: SubAgentRunnerDeps["executeAgent"],
  subagentContext?: { maxChildrenPerAgent: number; maxQueuedPerAgent: number },
): SubAgentRunnerDeps {
  return {
    sessionStore: {
      save: vi.fn(() => ok(undefined)),
      delete: vi.fn(() => ok(false)),
      loadByRef: vi.fn(() => ok(undefined)),
    },
    executeAgent,
    sendToChannel: vi.fn().mockResolvedValue(true),
    eventBus: { emit: vi.fn() } as unknown as SubAgentRunnerDeps["eventBus"],
    config: {
      enabled: true,
      maxPingPongTurns: 3,
      allowAgents: [],
      subAgentRetentionMs: 3_600_000,
      waitTimeoutMs: 60_000,
      subAgentMaxSteps: 50,
      subAgentToolGroups: ["coding"],
      ...(subagentContext ? { subagentContext } : {}),
    },
    tenantId: "tenant_a",
    clock: testClock,
    timers: testTimers,
  };
}

function parentContext(
  trustLevel: RequestContext["trustLevel"],
  overrides: Partial<RequestContext> = {},
): RequestContext {
  const endpoint = {
    channelType: "telegram",
    channelInstanceId: "test-instance",
    conversationId: "chat_a",
    conversationKind: "direct" as const,
  };
  return {
    traceId: "10000000-0000-4000-8000-000000000001",
    tenantId: "tenant_a",
    userId: "user_a",
    sessionKey: "tenant_a:user_a:telegram:chat_a",
    agentId: "parent-agent",
    startedAt: Date.now() - 5_000,
    trustLevel,
    channelType: "telegram",
    turnScope: {
      conversation: {
        tenantId: "tenant_a",
        agentId: "parent-agent",
        partition: {
          kind: "endpoint-conversation-principal",
          endpoint,
          principalId: "user_a",
        },
      },
      principal: { principalId: "user_a" },
      endpoint,
    },
    ...overrides,
  };
}

function parentConversation(parent: RequestContext) {
  const locator = createConversationLocator(parent.turnScope!.conversation);
  if (!locator.ok) throw locator.error;
  return locator.value;
}

async function flushExecution(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
  }
  await vi.advanceTimersByTimeAsync(0);
}

describe("sub-agent request context", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T10:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("inherits caller trust and delivery origin while stamping child identity", async () => {
    const captured: RequestContext[] = [];
    const deps = createDeps(async () => {
      captured.push(getContext());
      return successResult();
    });
    const runner = createSubAgentRunner(deps);
    const deliveryOrigin = createDeliveryOrigin({
      channelType: "telegram",
      channelId: "chat_a",
      userId: "user_a",
      threadId: "topic_a",
      tenantId: "tenant_a",
    });
    const parent = parentContext("user", { deliveryOrigin });

    const runId = runWithContext(parent, () => runner.spawn({
      task: "inspect the deployment",
      agentId: "child-agent",
      callerSessionKey: parent.sessionKey,
      callerConversation: parentConversation(parent),
      callerAgentId: parent.agentId,
      requesterOrigin: deliveryOrigin,
    }));

    await flushExecution();

    const child = captured[0];
    const run = runner.getRunStatus(runId);
    expect(child).toBeDefined();
    expect(child?.trustLevel).toBe("user");
    expect(child?.agentId).toBe("child-agent");
    expect(child?.tenantId).toBe("tenant_a");
    expect(child?.userId).toBe("user_a");
    expect(child?.sessionKey).toBe(run?.sessionKey);
    expect(child?.channelType).toBe("telegram");
    expect(child?.deliveryOrigin).toEqual(deliveryOrigin);
    expect(Object.isFrozen(child?.deliveryOrigin)).toBe(true);
    expect(Reflect.set(child!, "trustLevel", "admin")).toBe(false);
    expect(Reflect.set(child!, "agentId", "forged-agent")).toBe(false);
    expect(child?.traceId).not.toBe(parent.traceId);
    expect(child?.startedAt).toBe(Date.now());
    expect(child?.startedAt).not.toBe(parent.startedAt);

    await runner.shutdown();
  });

  it("rejects an announcement route that differs from the authenticated requester", async () => {
    const captured: RequestContext[] = [];
    const deps = createDeps(async () => {
      captured.push(getContext());
      return successResult();
    });
    const warn = vi.fn();
    deps.logger = { warn } as unknown as NonNullable<SubAgentRunnerDeps["logger"]>;
    const runner = createSubAgentRunner(deps);
    const requesterOrigin = createDeliveryOrigin({
      channelType: "telegram",
      channelId: "chat_a",
      userId: "user_a",
      threadId: "topic_a",
      tenantId: "tenant_a",
    });
    const parent = parentContext("user", { deliveryOrigin: requesterOrigin });

    expect(() => runWithContext(parent, () => runner.spawn({
        task: "announce on a different route",
        agentId: "child-agent",
        callerSessionKey: parent.sessionKey,
        callerConversation: parentConversation(parent),
        callerAgentId: parent.agentId,
        requesterOrigin,
        announceChannelType: "telegram",
        announceChannelId: "chat_b",
      })))
      .toThrow(/caller principal|announcement route/i);

    await flushExecution();

    expect(captured).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "announcement_route_mismatch",
        hint: expect.stringMatching(/omit.*announcement route/i),
      }),
      "Sub-agent spawn rejected: announcement route mismatch",
    );

    await runner.shutdown();
  });

  it("rejects a direct spawn whose caller session differs from the ambient principal", async () => {
    const deps = createDeps(vi.fn(async () => successResult()));
    const runner = createSubAgentRunner(deps);
    const requesterOrigin = createDeliveryOrigin({
      channelType: "telegram",
      channelId: "chat_a",
      userId: "user_a",
      tenantId: "tenant_a",
    });
    const parent = parentContext("user", { deliveryOrigin: requesterOrigin });

    expect(() => runWithContext(parent, () => runner.spawn({
      task: "use a forged parent chat",
      agentId: "child-agent",
      callerSessionKey: "tenant_a:user_a:telegram:attacker_chat",
      callerAgentId: parent.agentId,
      requesterOrigin,
      announceChannelType: "telegram",
      announceChannelId: "chat_a",
    }))).toThrow(/caller principal/i);

    expect(deps.sessionStore.save).not.toHaveBeenCalled();
    expect(deps.executeAgent).not.toHaveBeenCalled();
    await runner.shutdown();
  });

  it("rejects a direct spawn whose requester origin differs from the ambient origin", async () => {
    const runner = createSubAgentRunner(createDeps(async () => successResult()));
    const ambientOrigin = createDeliveryOrigin({
      channelType: "telegram",
      channelId: "chat_a",
      userId: "user_a",
      tenantId: "tenant_a",
    });
    const forgedOrigin = createDeliveryOrigin({
      channelType: "telegram",
      channelId: "attacker_chat",
      userId: "user_a",
      tenantId: "tenant_a",
    });
    const parent = parentContext("user", { deliveryOrigin: ambientOrigin });

    expect(() => runWithContext(parent, () => runner.spawn({
      task: "use a forged announcement origin",
      agentId: "child-agent",
      callerSessionKey: parent.sessionKey,
      callerConversation: parentConversation(parent),
      callerAgentId: parent.agentId,
      requesterOrigin: forgedOrigin,
      announceChannelType: "telegram",
      announceChannelId: "attacker_chat",
    }))).toThrow(/caller principal/i);

    await runner.shutdown();
  });

  it("rejects an incomplete direct caller identity when ambient identity exists", async () => {
    const runner = createSubAgentRunner(createDeps(async () => successResult()));
    const parent = parentContext("user");

    expect(() => runWithContext(parent, () => runner.spawn({
      task: "omit the caller agent",
      agentId: "child-agent",
      callerSessionKey: parent.sessionKey,
    }))).toThrow(/caller principal/i);

    await runner.shutdown();
  });

  it("rejects a direct reused session belonging to another ambient user", async () => {
    const deps = createDeps(vi.fn(async () => successResult()));
    vi.mocked(deps.sessionStore.loadByRef).mockReturnValue(ok(undefined));
    const runner = createSubAgentRunner(deps);
    const parent = parentContext("user");

    expect(() => runWithContext(parent, () => runner.spawn({
      task: "reuse another user's session",
      agentId: "child-agent",
      callerSessionKey: parent.sessionKey,
      callerAgentId: parent.agentId,
      reuseSessionKey: "tenant_a:other_user:persistent_session",
    }))).toThrow(/caller principal/i);

    expect(deps.executeAgent).not.toHaveBeenCalled();
    await runner.shutdown();
  });

  it("allows an exact agent continuation to omit announcement routing", async () => {
    const captured: RequestContext[] = [];
    const runner = createSubAgentRunner(createDeps(async () => {
      captured.push(getContext());
      return successResult();
    }));
    const deliveryOrigin = createDeliveryOrigin({
      channelType: "telegram",
      channelId: "chat_a",
      userId: "user_a",
      tenantId: "tenant_a",
    });
    const parent = parentContext("user", { deliveryOrigin });

    const runId = runWithContext(parent, () => runner.spawn({
      task: "continue without an outward announcement",
      agentId: "child-agent",
      callerType: "agent",
      callerSessionKey: parent.sessionKey,
      callerConversation: parentConversation(parent),
      callerAgentId: parent.agentId,
    }));

    await flushExecution();

    expect(runner.getRunStatus(runId)?.status).toBe("completed");
    expect(captured[0]?.deliveryOrigin).toBeUndefined();

    await runner.shutdown();
  });

  it("uses guest trust when a direct spawn has no parent request context", async () => {
    const captured: RequestContext[] = [];
    const runner = createSubAgentRunner(createDeps(async () => {
      captured.push(getContext());
      return successResult();
    }));

    runner.spawn({
      task: "background inspection",
      agentId: "child-agent",
    });

    await flushExecution();

    expect(captured[0]?.trustLevel).toBe("guest");
    expect(captured[0]?.agentId).toBe("child-agent");

    await runner.shutdown();
  });

  it("rejects an explicitly agent-origin spawn when request context is absent", async () => {
    const deps = createDeps(vi.fn(async () => successResult()));
    const runner = createSubAgentRunner(deps);

    expect(() => runner.spawn({
      task: "spawn with detached agent identity",
      agentId: "child-agent",
      callerType: "agent",
      callerSessionKey: "tenant_a:user_a:telegram:chat_a",
      callerAgentId: "parent-agent",
    })).toThrow(/caller principal/i);

    expect(deps.executeAgent).not.toHaveBeenCalled();
    await runner.shutdown();
  });

  it("allows an explicitly authenticated control-plane spawn inside unrelated gateway ALS", async () => {
    const captured: RequestContext[] = [];
    const runner = createSubAgentRunner(createDeps(async () => {
      captured.push(getContext());
      return successResult();
    }));

    const runId = runWithContext(parentContext("admin"), () => runner.spawn({
      task: "operator-directed background inspection",
      agentId: "child-agent",
      callerType: "control-plane",
      announceChannelType: "telegram",
      announceChannelId: "operator_chat",
    }));

    await flushExecution();

    expect(runner.getRunStatus(runId)?.status).toBe("completed");
    expect(captured[0]?.agentId).toBe("child-agent");
    expect(captured[0]?.trustLevel).toBe("admin");

    await runner.shutdown();
  });

  it("uses the graph trust snapshot and graph trace for a graph child", async () => {
    const captured: RequestContext[] = [];
    const runner = createSubAgentRunner(createDeps(async () => {
      captured.push(getContext());
      return successResult();
    }));
    const graphTraceId = "30000000-0000-4000-8000-000000000003";

    runner.spawn({
      task: "execute graph node",
      agentId: "graph-child",
      callerType: "graph",
      callerTrustLevel: "user",
      graphTraceId,
      graphId: "graph_a",
      nodeId: "node_a",
    });

    await flushExecution();

    expect(captured[0]?.trustLevel).toBe("user");
    expect(captured[0]?.traceId).toBe(graphTraceId);
    expect(captured[0]?.agentId).toBe("graph-child");

    await runner.shutdown();
  });

  it("keeps graph-coordinator spawns independent from an unrelated ambient principal", async () => {
    const captured: RequestContext[] = [];
    const runner = createSubAgentRunner(createDeps(async () => {
      captured.push(getContext());
      return successResult();
    }));

    const runId = runWithContext(parentContext("admin"), () => runner.spawn({
      task: "execute an independently authorized graph node",
      agentId: "graph-child",
      callerType: "graph",
      callerTrustLevel: "user",
      callerSessionKey: "tenant_a:graph_user:graph_session",
      callerAgentId: "graph-coordinator",
      graphId: "graph_a",
      nodeId: "node_a",
    }));

    await flushExecution();

    expect(runner.getRunStatus(runId)?.status).toBe("completed");
    expect(captured[0]?.agentId).toBe("graph-child");
    expect(captured[0]?.trustLevel).toBe("user");

    await runner.shutdown();
  });

  it("retains accepted caller trust when a queued spawn is promoted later", async () => {
    const captured: RequestContext[] = [];
    let releaseFirst!: () => void;
    let invocation = 0;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const runner = createSubAgentRunner(createDeps(async () => {
      captured.push(getContext());
      invocation++;
      if (invocation === 1) await firstPending;
      return successResult(`done-${invocation}`);
    }, {
      maxChildrenPerAgent: 1,
      maxQueuedPerAgent: 2,
    }));
    const callerSessionKey = "tenant_a:user_a:telegram:chat_a";

    const adminParent = parentContext("admin");
    runWithContext(adminParent, () => runner.spawn({
      task: "occupy the only child slot",
      agentId: "first-child",
      callerSessionKey,
      callerConversation: parentConversation(adminParent),
      callerAgentId: "parent-agent",
    }));
    const userParent = parentContext("user");
    const queuedRunId = runWithContext(userParent, () => runner.spawn({
      task: "wait for the child slot",
      agentId: "queued-child",
      callerSessionKey,
      callerConversation: parentConversation(userParent),
      callerAgentId: "parent-agent",
    }));

    expect(runner.getRunStatus(queuedRunId)?.status).toBe("queued");
    releaseFirst();
    await flushExecution();

    expect(captured).toHaveLength(2);
    expect(captured[1]?.trustLevel).toBe("user");
    expect(captured[1]?.agentId).toBe("queued-child");

    await runner.shutdown();
  });
});
