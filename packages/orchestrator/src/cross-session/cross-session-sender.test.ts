// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { err, ok, type Result } from "@comis/shared";
import {
  createConversationLocator,
  conversationScopeToSessionKey,
  createStableAnnouncementOperationId,
  formatSessionKey,
  SessionStoreError,
} from "@comis/core";
import {
  createCrossSessionSender,
  type CrossSessionSenderDeps,
  type CrossSessionSendParams,
} from "./cross-session-sender.js";

const ANNOUNCEMENT_TOOL_RESULT_RESPONSE_MAX_CHARS = 100_000;

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function conversation(userId: string, channelId: string, agentId = "default") {
  const endpoint = {
    channelType: "test",
    channelInstanceId: "cross-session-test",
    conversationId: channelId,
    conversationKind: "direct" as const,
  };
  const locator = createConversationLocator({
    tenantId: "default",
    agentId,
    partition: {
      kind: "endpoint-conversation-principal",
      endpoint,
      principalId: userId,
    },
  });
  if (!locator.ok) throw locator.error;
  return locator.value;
}

const TARGET_ONE = conversation("user1", "channel1");
const TARGET_TWO = conversation("user2", "channel2");
const TARGET_THREE = conversation("user3", "channel3");
const PARENT_TWO = conversation("user2", "channel2", "parent-agent");
const PARENT_TWO_ENDPOINT = {
  channelType: "discord",
  channelInstanceId: "cross-session-test",
  conversationId: "guild-channel-42",
  conversationKind: "shared" as const,
};
const QUERY_ONE = { tenantId: "default", agentId: "default", conversationRef: TARGET_ONE.conversationRef };
const QUERY_TWO = { tenantId: "default", agentId: "default", conversationRef: TARGET_TWO.conversationRef };
const QUERY_THREE = { tenantId: "default", agentId: "default", conversationRef: TARGET_THREE.conversationRef };
const projectedTargetOne = conversationScopeToSessionKey(TARGET_ONE.conversationScope);
if (!projectedTargetOne.ok) throw projectedTargetOne.error;
const TARGET_ONE_DISPLAY = formatSessionKey(projectedTargetOne.value);

function scopedProducerKey(toolCallId: string): string {
  return createStableAnnouncementOperationId(
    "parent-agent",
    "default:user2:channel2",
    toolCallId,
  );
}

function createMockDeps(): CrossSessionSenderDeps {
  const sessionData = new Map<string, ReturnType<typeof makeSessionData>>();

  function makeSessionData(
    locator: typeof TARGET_ONE,
    messages: unknown[],
    createdAt: number,
    metadata: Record<string, unknown> = { createdAt },
  ) {
    return {
      ...locator,
      messages,
      metadata,
      createdAt,
      updatedAt: createdAt,
    };
  }

  // Pre-populate a target session
  sessionData.set(TARGET_ONE.conversationRef, makeSessionData(
    TARGET_ONE,
    [{ role: "user", content: "hello", timestamp: 1000 }],
    1000,
  ));

  // Pre-populate a second session for ping-pong
  sessionData.set(TARGET_TWO.conversationRef, makeSessionData(TARGET_TWO, [], 2000));
  sessionData.set(PARENT_TWO.conversationRef, makeSessionData(PARENT_TWO, [], 2000));

  return {
    sessionStore: {
      loadByRef: vi.fn((_scope, conversationRef) => ok(sessionData.get(conversationRef))),
      save: vi.fn((scope, messages, metadata) => {
        const locator = scope.agentId === PARENT_TWO.conversationScope.agentId
          ? PARENT_TWO
          : scope.partition.kind === "endpoint-conversation-principal"
            && scope.partition.principalId === "user1"
            ? TARGET_ONE
            : TARGET_TWO;
        sessionData.set(locator.conversationRef, makeSessionData(
          locator,
          messages,
          Number(metadata.createdAt ?? 0),
          metadata,
        ));
        return ok(undefined);
      }),
    },
    executeInSession: vi.fn().mockResolvedValue({
      response: "test response",
      tokensUsed: { total: 100 },
      cost: { total: 0.01 },
    }),
    sendToChannel: vi.fn().mockResolvedValue(true),
    eventBus: { emit: vi.fn() } as unknown as CrossSessionSenderDeps["eventBus"],
    config: {
      enabled: true,
      maxPingPongTurns: 3,
      allowAgents: [],
      subAgentRetentionMs: 3_600_000,
      waitTimeoutMs: 60_000,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createCrossSessionSender", () => {
  let deps: CrossSessionSenderDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  // -----------------------------------------------------------------------
  // Fire-and-forget injects message and returns immediately
  // -----------------------------------------------------------------------
  it("fire-and-forget injects message and returns immediately", async () => {
    const sender = createCrossSessionSender(deps);
    const params: CrossSessionSendParams = {
      target: QUERY_ONE,
      text: "cross-session hello",
      mode: "fire-and-forget",
      caller: QUERY_TWO,
      callerSessionKey: "default:user2:channel2",
    };

    const result = await sender.send(params);

    expect(result.sent).toBe(true);
    expect(result.response).toBeUndefined();

    // Verify sessionStore.save was called with appended message
    expect(deps.sessionStore.save).toHaveBeenCalledTimes(1);
    const saveCall = vi.mocked(deps.sessionStore.save).mock.calls[0]!;
    const savedMessages = saveCall[1] as Array<{ role: string; content: string; metadata: { crossSession: boolean } }>;
    const lastMsg = savedMessages[savedMessages.length - 1]!;
    expect(lastMsg.role).toBe("user");
    expect(lastMsg.content).toBe("cross-session hello");
    expect(lastMsg.metadata.crossSession).toBe(true);

    // executeInSession should NOT be called for fire-and-forget
    expect(deps.executeInSession).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Wait mode executes target and returns response
  // -----------------------------------------------------------------------
  it("wait mode executes target and returns response", async () => {
    const sender = createCrossSessionSender(deps);
    const params: CrossSessionSendParams = {
      target: QUERY_ONE,
      text: "need info",
      mode: "wait",
      caller: QUERY_TWO,
      callerSessionKey: "default:user2:channel2",
    };

    const result = await sender.send(params);

    expect(result.sent).toBe(true);
    expect(result.response).toBe("test response");
    expect(result.stats).toBeDefined();
    expect(result.stats!.totalTokens).toBe(100);
    expect(result.stats!.totalCost).toBe(0.01);
    expect(result.stats!.runtimeMs).toBeGreaterThanOrEqual(0);

    expect(deps.executeInSession).toHaveBeenCalledTimes(1);
    expect(deps.executeInSession).toHaveBeenCalledWith(
      "default",
      expect.anything(),
      TARGET_ONE,
      "need info",
    );
  });

  // -----------------------------------------------------------------------
  // Ping-pong mode completes N turns
  // -----------------------------------------------------------------------
  it("ping-pong mode completes N turns", async () => {
    const sender = createCrossSessionSender(deps);
    const params: CrossSessionSendParams = {
      target: QUERY_ONE,
      text: "start conversation",
      mode: "ping-pong",
      maxTurns: 2,
      caller: QUERY_TWO,
      callerSessionKey: "default:user2:channel2",
    };

    const result = await sender.send(params);

    expect(result.sent).toBe(true);
    expect(result.turnsCompleted).toBe(2);
    // 1 initial execution + 2 ping-pong turns = 3 total calls
    expect(deps.executeInSession).toHaveBeenCalledTimes(3);
    expect(result.stats!.totalTokens).toBe(300); // 100 * 3
    expect(result.stats!.totalCost).toBeCloseTo(0.03); // 0.01 * 3
  });

  // -----------------------------------------------------------------------
  // ANNOUNCE_SKIP suppresses announcement
  // -----------------------------------------------------------------------
  it("ANNOUNCE_SKIP suppresses announcement and is stripped from response", async () => {
    vi.mocked(deps.executeInSession).mockResolvedValue({
      response: "result text ANNOUNCE_SKIP",
      tokensUsed: { total: 50 },
      cost: { total: 0.005 },
    });

    const sender = createCrossSessionSender(deps);
    const params: CrossSessionSendParams = {
      target: QUERY_ONE,
      text: "do something",
      mode: "wait",
      caller: QUERY_TWO,
      callerSessionKey: "default:user2:channel2",
      announceChannelType: "telegram",
      announceChannelId: "chat123",
    };

    const result = await sender.send(params);

    expect(result.sent).toBe(true);
    expect(result.response).toBe("result text");
    expect(result.announced).toBe(false);
    expect(deps.sendToChannel).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Self-targeting in wait mode throws
  // -----------------------------------------------------------------------
  it("self-targeting in wait mode throws deadlock error", async () => {
    const sender = createCrossSessionSender(deps);
    const params: CrossSessionSendParams = {
      target: QUERY_ONE,
      text: "talk to myself",
      mode: "wait",
      caller: QUERY_ONE,
      callerSessionKey: "default:user1:channel1",
    };

    await expect(sender.send(params)).rejects.toThrow(
      "Cannot send to own session in wait/ping-pong mode (deadlock risk). Use fire-and-forget mode instead.",
    );
  });

  // -----------------------------------------------------------------------
  // Self-targeting in fire-and-forget is allowed
  // -----------------------------------------------------------------------
  it("self-targeting in fire-and-forget is allowed", async () => {
    const sender = createCrossSessionSender(deps);
    const params: CrossSessionSendParams = {
      target: QUERY_ONE,
      text: "note to self",
      mode: "fire-and-forget",
      caller: QUERY_ONE,
      callerSessionKey: "default:user1:channel1",
    };

    const result = await sender.send(params);

    expect(result.sent).toBe(true);
    // No error thrown
  });

  // -----------------------------------------------------------------------
  // Ping-pong stops early on ANNOUNCE_SKIP
  // -----------------------------------------------------------------------
  it("ping-pong stops early on ANNOUNCE_SKIP", async () => {
    let callCount = 0;
    vi.mocked(deps.executeInSession).mockImplementation(async () => {
      callCount++;
      // First call (initial execution) returns normal response
      // Second call (turn 1) returns ANNOUNCE_SKIP
      if (callCount >= 2) {
        return {
          response: "done ANNOUNCE_SKIP",
          tokensUsed: { total: 50 },
          cost: { total: 0.005 },
        };
      }
      return {
        response: "continue conversation",
        tokensUsed: { total: 100 },
        cost: { total: 0.01 },
      };
    });

    const sender = createCrossSessionSender(deps);
    const params: CrossSessionSendParams = {
      target: QUERY_ONE,
      text: "start",
      mode: "ping-pong",
      maxTurns: 5,
      caller: QUERY_TWO,
      callerSessionKey: "default:user2:channel2",
    };

    const result = await sender.send(params);

    // Turn 1 completes, then turn 1 response has ANNOUNCE_SKIP so loop breaks
    expect(result.turnsCompleted).toBe(1);
    // 1 initial + 1 ping-pong turn = 2 total calls
    expect(deps.executeInSession).toHaveBeenCalledTimes(2);
    // ANNOUNCE_SKIP should be stripped
    expect(result.response).toBe("done");
    expect(result.announced).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Announce sends to channel
  // -----------------------------------------------------------------------
  it("announce uses the recoverable boundary with the authenticated route", async () => {
    const sendRecoverableAnnouncement = vi.fn(async () => ok({
      delivered: true as const,
      status: "accepted" as const,
    }));
    const reserveAnnouncementProducer = vi.fn(async () => ok({ status: "claimed" as const }));
    const releaseAnnouncementProducer = vi.fn(async () => ok(undefined));
    const recordAnnouncementProducerOutcome = vi.fn(async () => ok(undefined));
    const cancelAnnouncementProducer = vi.fn(async () => ok(undefined));
    const suppressAnnouncementProducer = vi.fn(async () => ok(true));
    const prepareAnnouncementRetirement = vi.fn(async () => ok(undefined));
    const sender = createCrossSessionSender({
      ...deps,
      sendRecoverableAnnouncement,
      reserveAnnouncementProducer,
      releaseAnnouncementProducer,
      recordAnnouncementProducerOutcome,
      cancelAnnouncementProducer,
      suppressAnnouncementProducer,
      prepareAnnouncementRetirement,
    });
    const params: CrossSessionSendParams = {
      target: QUERY_ONE,
      text: "question",
      mode: "wait",
      caller: QUERY_TWO,
      callerSessionKey: "default:user2:channel2",
      callerConversation: PARENT_TWO,
      callerEndpoint: PARENT_TWO_ENDPOINT,
      callerAgentId: "parent-agent",
      announceOperationId: "announce-tool-call-direct",
      announceChannelType: "discord",
      announceChannelId: "guild-channel-42",
    };

    const result = await sender.send(params);

    expect(result.announced).toBe(true);
    expect(sendRecoverableAnnouncement).toHaveBeenCalledWith(expect.objectContaining({
      runId: scopedProducerKey("announce-tool-call-direct"),
      channelType: "discord",
      channelId: "guild-channel-42",
      text: "test response",
    }));
    expect(prepareAnnouncementRetirement).toHaveBeenCalledWith(
      [scopedProducerKey("announce-tool-call-direct")],
      {
        kind: "tool_result",
        tenantId: PARENT_TWO.conversationScope.tenantId,
        agentId: PARENT_TWO.conversationScope.agentId,
        conversationRef: PARENT_TWO.conversationRef,
        toolCallId: "announce-tool-call-direct",
        operationId: scopedProducerKey("announce-tool-call-direct"),
      },
    );
    expect(prepareAnnouncementRetirement.mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(deps.executeInSession).mock.invocationCallOrder[0]!);
    expect(reserveAnnouncementProducer).toHaveBeenCalledWith(expect.objectContaining({
      runId: scopedProducerKey("announce-tool-call-direct"),
      retirementKeys: [scopedProducerKey("announce-tool-call-direct")],
      destinationEndpoint: PARENT_TWO_ENDPOINT,
      producer: {
        kind: "tool_result",
        tenantId: PARENT_TWO.conversationScope.tenantId,
        agentId: PARENT_TWO.conversationScope.agentId,
        conversationRef: PARENT_TWO.conversationRef,
        toolCallId: "announce-tool-call-direct",
        operationId: scopedProducerKey("announce-tool-call-direct"),
      },
    }));
    expect(recordAnnouncementProducerOutcome).toHaveBeenCalledWith(
      scopedProducerKey("announce-tool-call-direct"),
      expect.objectContaining({
        kind: "tool_result",
        response: "test response",
        announced: true,
      }),
    );
    expect(releaseAnnouncementProducer).toHaveBeenCalledWith(
      scopedProducerKey("announce-tool-call-direct"),
    );
    expect(deps.sendToChannel).not.toHaveBeenCalled();
  });

  it("does not repeat target side effects when recovery owns completion", async () => {
    const reserveAnnouncementProducer = vi.fn(async () => ok({
      status: "recovery_owned" as const,
      lifecycleState: "promotion_ready" as const,
      recoveryOutcome: {
        kind: "tool_result" as const,
        terminalReason: "completed" as const,
        completedAtMs: 1_234,
        response: "persisted response",
        turnsCompleted: 2,
        announced: true,
        stats: { runtimeMs: 41, totalTokens: 12, totalCost: 0.003 },
      },
    }));
    const releaseAnnouncementProducer = vi.fn(async () => ok(undefined));
    const recordAnnouncementProducerOutcome = vi.fn(async () => ok(undefined));
    const cancelAnnouncementProducer = vi.fn(async () => ok(undefined));
    const suppressAnnouncementProducer = vi.fn(async () => ok(true));
    const sender = createCrossSessionSender({
      ...deps,
      reserveAnnouncementProducer,
      releaseAnnouncementProducer,
      recordAnnouncementProducerOutcome,
      cancelAnnouncementProducer,
      suppressAnnouncementProducer,
    });

    const result = await sender.send({
      target: QUERY_ONE,
      text: "question",
      mode: "wait",
      caller: QUERY_TWO,
      callerSessionKey: "default:user2:channel2",
      callerConversation: PARENT_TWO,
      callerEndpoint: PARENT_TWO_ENDPOINT,
      callerAgentId: "parent-agent",
      announceOperationId: "recovered-tool-call",
      announceChannelType: "discord",
      announceChannelId: "guild-channel-42",
    });

    expect(result).toEqual({
      sent: true,
      response: "persisted response",
      turnsCompleted: 2,
      announced: true,
      stats: { runtimeMs: 41, totalTokens: 12, totalCost: 0.003 },
    });
    expect(deps.sessionStore.save).not.toHaveBeenCalled();
    expect(deps.executeInSession).not.toHaveBeenCalled();
    expect(releaseAnnouncementProducer).not.toHaveBeenCalled();
    expect(cancelAnnouncementProducer).not.toHaveBeenCalled();
  });

  it("reconciles an unsettled recovered announcement without target reexecution", async () => {
    const reserveAnnouncementProducer = vi.fn(async () => ok({
      status: "recovery_owned" as const,
      lifecycleState: "promotion_ready" as const,
      recoveryOutcome: {
        kind: "tool_result" as const,
        terminalReason: "completed" as const,
        completedAtMs: 1_234,
        response: "persisted response",
        stats: { runtimeMs: 41, totalTokens: 12, totalCost: 0.003 },
      },
    }));
    const sendRecoverableAnnouncement = vi.fn(async () => ok({
      delivered: true as const,
      status: "accepted" as const,
    }));
    const recordAnnouncementProducerOutcome = vi.fn(async () => ok(undefined));
    const releaseAnnouncementProducer = vi.fn(async () => ok(undefined));
    const sender = createCrossSessionSender({
      ...deps,
      reserveAnnouncementProducer,
      sendRecoverableAnnouncement,
      recordAnnouncementProducerOutcome,
      releaseAnnouncementProducer,
      cancelAnnouncementProducer: vi.fn(async () => ok(undefined)),
      suppressAnnouncementProducer: vi.fn(async () => ok(true)),
    });

    const result = await sender.send({
      target: QUERY_ONE,
      text: "question",
      mode: "wait",
      caller: QUERY_TWO,
      callerSessionKey: "default:user2:channel2",
      callerConversation: PARENT_TWO,
      callerEndpoint: PARENT_TWO_ENDPOINT,
      callerAgentId: "parent-agent",
      announceOperationId: "recovered-unsettled-tool-call",
      announceChannelType: "discord",
      announceChannelId: "guild-channel-42",
    });

    expect(result).toMatchObject({
      sent: true,
      response: "persisted response",
      announced: true,
    });
    expect(deps.sessionStore.save).toHaveBeenCalledOnce();
    expect(deps.executeInSession).not.toHaveBeenCalled();
    expect(sendRecoverableAnnouncement).toHaveBeenCalledOnce();
    expect(recordAnnouncementProducerOutcome).toHaveBeenCalledWith(
      scopedProducerKey("recovered-unsettled-tool-call"),
      expect.objectContaining({ announced: true }),
    );
    expect(releaseAnnouncementProducer).toHaveBeenCalledWith(
      scopedProducerKey("recovered-unsettled-tool-call"),
    );
  });

  it("retries completed outcome persistence without repeating target execution", async () => {
    const releaseAnnouncementProducer = vi.fn(async () => ok(undefined));
    const cancelAnnouncementProducer = vi.fn(async () => ok(undefined));
    const recordAnnouncementProducerOutcome = vi.fn()
      .mockResolvedValueOnce(err(new Error("outcome storage unavailable")))
      .mockResolvedValue(ok(undefined));
    const sendRecoverableAnnouncement = vi.fn(async () => ok({
      delivered: true as const,
      status: "accepted" as const,
    }));
    const sender = createCrossSessionSender({
      ...deps,
      reserveAnnouncementProducer: vi.fn(async () => ok({ status: "claimed" as const })),
      recordAnnouncementProducerOutcome,
      releaseAnnouncementProducer,
      cancelAnnouncementProducer,
      suppressAnnouncementProducer: vi.fn(async () => ok(true)),
      sendRecoverableAnnouncement,
    });

    const result = await sender.send({
      target: QUERY_ONE,
      text: "question",
      mode: "wait",
      caller: QUERY_TWO,
      callerSessionKey: "default:user2:channel2",
      callerConversation: PARENT_TWO,
      callerEndpoint: PARENT_TWO_ENDPOINT,
      callerAgentId: "parent-agent",
      announceOperationId: "outcome-storage-tool-call",
      announceChannelType: "discord",
      announceChannelId: "guild-channel-42",
    });

    expect(result).toMatchObject({ sent: true, response: "test response", announced: true });
    expect(deps.sessionStore.save).toHaveBeenCalledTimes(3);
    expect(deps.executeInSession).toHaveBeenCalledOnce();
    expect(sendRecoverableAnnouncement).toHaveBeenCalledOnce();
    expect(recordAnnouncementProducerOutcome).toHaveBeenCalledTimes(3);
    expect(releaseAnnouncementProducer).toHaveBeenCalledOnce();
    expect(cancelAnnouncementProducer).not.toHaveBeenCalled();
  });

  it("retains confirmed delivery until its returned outcome is durable", async () => {
    const releaseAnnouncementProducer = vi.fn(async () => ok(undefined));
    const cancelAnnouncementProducer = vi.fn(async () => ok(undefined));
    const recordAnnouncementProducerOutcome = vi.fn()
      .mockResolvedValueOnce(ok(undefined))
      .mockResolvedValueOnce(err(new Error("confirmed outcome storage unavailable")))
      .mockResolvedValue(ok(undefined));
    const sendRecoverableAnnouncement = vi.fn(async () => ok({
      delivered: true as const,
      status: "accepted" as const,
    }));
    const sender = createCrossSessionSender({
      ...deps,
      reserveAnnouncementProducer: vi.fn(async () => ok({ status: "claimed" as const })),
      recordAnnouncementProducerOutcome,
      releaseAnnouncementProducer,
      cancelAnnouncementProducer,
      suppressAnnouncementProducer: vi.fn(async () => ok(true)),
      sendRecoverableAnnouncement,
    });

    const result = await sender.send({
      target: QUERY_ONE,
      text: "question",
      mode: "wait",
      caller: QUERY_TWO,
      callerSessionKey: "default:user2:channel2",
      callerConversation: PARENT_TWO,
      callerEndpoint: PARENT_TWO_ENDPOINT,
      callerAgentId: "parent-agent",
      announceOperationId: "confirmed-outcome-tool-call",
      announceChannelType: "discord",
      announceChannelId: "guild-channel-42",
    });

    expect(result).toMatchObject({ sent: true, response: "test response", announced: true });
    expect(sendRecoverableAnnouncement).toHaveBeenCalledOnce();
    expect(recordAnnouncementProducerOutcome).toHaveBeenCalledTimes(3);
    expect(releaseAnnouncementProducer).toHaveBeenCalledOnce();
    expect(cancelAnnouncementProducer).not.toHaveBeenCalled();
  });

  it("stops shutdown retries only after preserving the completed tool result", async () => {
    const lifecycle = new AbortController();
    let observeAttempt: (() => void) | undefined;
    let finishAttempt: (() => void) | undefined;
    const attempted = new Promise<void>((resolve) => {
      observeAttempt = resolve;
    });
    const recordAnnouncementProducerOutcome = vi.fn(() => new Promise<Result<void, Error>>((resolve) => {
      observeAttempt?.();
      finishAttempt = () => resolve(err(new Error("outcome storage unavailable")));
    }));
    const releaseAnnouncementProducer = vi.fn(async () => ok(undefined));
    const cancelAnnouncementProducer = vi.fn(async () => ok(undefined));
    const sendRecoverableAnnouncement = vi.fn(async () => ok({
      delivered: true as const,
      status: "accepted" as const,
    }));
    const sender = createCrossSessionSender({
      ...deps,
      lifecycleSignal: lifecycle.signal,
      reserveAnnouncementProducer: vi.fn(async () => ok({ status: "claimed" as const })),
      recordAnnouncementProducerOutcome,
      releaseAnnouncementProducer,
      cancelAnnouncementProducer,
      suppressAnnouncementProducer: vi.fn(async () => ok(true)),
      sendRecoverableAnnouncement,
    });

    const pending = sender.send({
      target: QUERY_ONE,
      text: "question",
      mode: "wait",
      caller: QUERY_TWO,
      callerSessionKey: "default:user2:channel2",
      callerConversation: PARENT_TWO,
      callerEndpoint: PARENT_TWO_ENDPOINT,
      callerAgentId: "parent-agent",
      announceOperationId: "shutdown-outcome-tool-call",
      announceChannelType: "discord",
      announceChannelId: "guild-channel-42",
    });
    await attempted;
    lifecycle.abort();
    finishAttempt?.();

    await expect(pending).rejects.toThrow("interrupted after durable handoff");
    expect(deps.executeInSession).toHaveBeenCalledOnce();
    expect(sendRecoverableAnnouncement).not.toHaveBeenCalled();
    expect(releaseAnnouncementProducer).not.toHaveBeenCalled();
    expect(cancelAnnouncementProducer).not.toHaveBeenCalled();
    expect(vi.mocked(deps.sessionStore.save).mock.calls.some((call) => {
      const handoffs = call[2].announcementToolResultRecoveryHandoffs;
      return typeof handoffs === "object"
        && handoffs !== null
        && Object.keys(handoffs).includes(scopedProducerKey("shutdown-outcome-tool-call"));
    })).toBe(true);
  });

  it("refuses to replay an active cross-session operation", async () => {
    const sender = createCrossSessionSender({
      ...deps,
      reserveAnnouncementProducer: vi.fn(async () => ok({
        status: "recovery_owned" as const,
        lifecycleState: "active" as const,
      })),
      releaseAnnouncementProducer: vi.fn(async () => ok(undefined)),
      recordAnnouncementProducerOutcome: vi.fn(async () => ok(undefined)),
      cancelAnnouncementProducer: vi.fn(async () => ok(undefined)),
      suppressAnnouncementProducer: vi.fn(async () => ok(true)),
    });

    await expect(sender.send({
      target: QUERY_ONE,
      text: "question",
      mode: "wait",
      caller: QUERY_TWO,
      callerSessionKey: "default:user2:channel2",
      callerConversation: PARENT_TWO,
      callerEndpoint: PARENT_TWO_ENDPOINT,
      callerAgentId: "parent-agent",
      announceOperationId: "active-tool-call",
      announceChannelType: "discord",
      announceChannelId: "guild-channel-42",
    })).rejects.toThrow("already owned by an unresolved attempt");

    expect(deps.sessionStore.save).not.toHaveBeenCalled();
    expect(deps.executeInSession).not.toHaveBeenCalled();
  });

  it("durably records announce skip before consuming producer ownership", async () => {
    vi.mocked(deps.executeInSession).mockResolvedValue({
      response: "private result ANNOUNCE_SKIP",
      tokensUsed: { total: 50 },
      cost: { total: 0.005 },
    });
    const reserveAnnouncementProducer = vi.fn(async () => ok({ status: "claimed" as const }));
    const releaseAnnouncementProducer = vi.fn(async () => ok(undefined));
    const recordAnnouncementProducerOutcome = vi.fn(async () => ok(undefined));
    const cancelAnnouncementProducer = vi.fn(async () => ok(undefined));
    const suppressAnnouncementProducer = vi.fn(async () => ok(true));
    const sendRecoverableAnnouncement = vi.fn();
    const sender = createCrossSessionSender({
      ...deps,
      reserveAnnouncementProducer,
      releaseAnnouncementProducer,
      recordAnnouncementProducerOutcome,
      cancelAnnouncementProducer,
      suppressAnnouncementProducer,
      sendRecoverableAnnouncement,
    });

    const result = await sender.send({
      target: QUERY_ONE,
      text: "do something privately",
      mode: "wait",
      caller: QUERY_TWO,
      callerSessionKey: "default:user2:channel2",
      callerConversation: PARENT_TWO,
      callerEndpoint: PARENT_TWO_ENDPOINT,
      callerAgentId: "parent-agent",
      announceOperationId: "announce-tool-call-skip",
      announceChannelType: "discord",
      announceChannelId: "guild-channel-42",
    });

    expect(result).toMatchObject({ response: "private result", announced: false });
    expect(suppressAnnouncementProducer).toHaveBeenCalledWith(
      scopedProducerKey("announce-tool-call-skip"),
    );
    expect(sendRecoverableAnnouncement).not.toHaveBeenCalled();
    expect(releaseAnnouncementProducer).not.toHaveBeenCalled();
    expect(cancelAnnouncementProducer).not.toHaveBeenCalled();
  });

  it("retains producer ownership when announce skip finds no durable owner", async () => {
    vi.mocked(deps.executeInSession).mockResolvedValue({
      response: "private result ANNOUNCE_SKIP",
      tokensUsed: { total: 50 },
      cost: { total: 0.005 },
    });
    const reserveAnnouncementProducer = vi.fn(async () => ok({ status: "claimed" as const }));
    const releaseAnnouncementProducer = vi.fn(async () => ok(undefined));
    const recordAnnouncementProducerOutcome = vi.fn(async () => ok(undefined));
    const cancelAnnouncementProducer = vi.fn(async () => ok(undefined));
    const suppressAnnouncementProducer = vi.fn(async () => ok(false));
    const sender = createCrossSessionSender({
      ...deps,
      reserveAnnouncementProducer,
      releaseAnnouncementProducer,
      recordAnnouncementProducerOutcome,
      cancelAnnouncementProducer,
      suppressAnnouncementProducer,
    });

    await expect(sender.send({
      target: QUERY_ONE,
      text: "do something privately",
      mode: "wait",
      caller: QUERY_TWO,
      callerSessionKey: "default:user2:channel2",
      callerConversation: PARENT_TWO,
      callerEndpoint: PARENT_TWO_ENDPOINT,
      callerAgentId: "parent-agent",
      announceOperationId: "announce-tool-call-missing-suppression-owner",
      announceChannelType: "discord",
      announceChannelId: "guild-channel-42",
    })).rejects.toThrow("did not find durable ownership");

    expect(releaseAnnouncementProducer).not.toHaveBeenCalled();
    expect(cancelAnnouncementProducer).not.toHaveBeenCalled();
  });

  it("retains producer ownership when ping-pong fails after execution starts", async () => {
    const reserveAnnouncementProducer = vi.fn(async () => ok({ status: "claimed" as const }));
    const releaseAnnouncementProducer = vi.fn(async () => ok(undefined));
    const recordAnnouncementProducerOutcome = vi.fn(async () => ok(undefined));
    const cancelAnnouncementProducer = vi.fn(async () => ok(undefined));
    const suppressAnnouncementProducer = vi.fn(async () => ok(true));
    vi.mocked(deps.executeInSession)
      .mockResolvedValueOnce({
        response: "continue",
        tokensUsed: { total: 10 },
        cost: { total: 0.001 },
      })
      .mockRejectedValueOnce(new Error("ping-pong execution failed"));
    const sender = createCrossSessionSender({
      ...deps,
      reserveAnnouncementProducer,
      releaseAnnouncementProducer,
      recordAnnouncementProducerOutcome,
      cancelAnnouncementProducer,
      suppressAnnouncementProducer,
    });

    await expect(sender.send({
      target: QUERY_ONE,
      text: "question",
      mode: "ping-pong",
      caller: QUERY_TWO,
      callerSessionKey: "default:user2:channel2",
      callerConversation: PARENT_TWO,
      callerEndpoint: PARENT_TWO_ENDPOINT,
      callerAgentId: "parent-agent",
      announceOperationId: "failed-ping-pong-tool-call",
      announceChannelType: "discord",
      announceChannelId: "guild-channel-42",
    })).rejects.toThrow("ping-pong execution failed");

    expect(cancelAnnouncementProducer).not.toHaveBeenCalled();
    expect(releaseAnnouncementProducer).not.toHaveBeenCalled();
    expect(recordAnnouncementProducerOutcome).toHaveBeenCalledWith(
      scopedProducerKey("failed-ping-pong-tool-call"),
      expect.objectContaining({
        kind: "tool_result",
        terminalReason: "failed",
        errorKind: "internal",
        summary: "ping-pong execution failed",
      }),
    );
  });

  it("returns a persisted cross-session failure without repeating target work", async () => {
    const sender = createCrossSessionSender({
      ...deps,
      reserveAnnouncementProducer: vi.fn(async () => ok({
        status: "recovery_owned" as const,
        lifecycleState: "promotion_ready" as const,
        recoveryOutcome: {
          kind: "tool_result" as const,
          terminalReason: "failed" as const,
          completedAtMs: 1_234,
          errorKind: "timeout" as const,
          summary: "Cross-session wait timed out",
        },
      })),
      releaseAnnouncementProducer: vi.fn(async () => ok(undefined)),
      recordAnnouncementProducerOutcome: vi.fn(async () => ok(undefined)),
      cancelAnnouncementProducer: vi.fn(async () => ok(undefined)),
      suppressAnnouncementProducer: vi.fn(async () => ok(true)),
    });

    await expect(sender.send({
      target: QUERY_ONE,
      text: "question",
      mode: "wait",
      caller: QUERY_TWO,
      callerSessionKey: "default:user2:channel2",
      callerConversation: PARENT_TWO,
      callerEndpoint: PARENT_TWO_ENDPOINT,
      callerAgentId: "parent-agent",
      announceOperationId: "failed-recovery-tool-call",
      announceChannelType: "discord",
      announceChannelId: "guild-channel-42",
    })).rejects.toThrow("Cross-session wait timed out");

    expect(deps.sessionStore.save).not.toHaveBeenCalled();
    expect(deps.executeInSession).not.toHaveBeenCalled();
  });

  it("preserves the public response while bounding its durable recovery payload", async () => {
    const rawResponse = "x".repeat(ANNOUNCEMENT_TOOL_RESULT_RESPONSE_MAX_CHARS + 2_000);
    vi.mocked(deps.executeInSession).mockResolvedValue({
      response: rawResponse,
      tokensUsed: { total: 50 },
      cost: { total: 0.005 },
    });
    const recordAnnouncementProducerOutcome = vi.fn(async () => ok(undefined));
    const sender = createCrossSessionSender({
      ...deps,
      reserveAnnouncementProducer: vi.fn(async () => ok({ status: "claimed" as const })),
      releaseAnnouncementProducer: vi.fn(async () => ok(undefined)),
      recordAnnouncementProducerOutcome,
      cancelAnnouncementProducer: vi.fn(async () => ok(undefined)),
      suppressAnnouncementProducer: vi.fn(async () => ok(true)),
      sendRecoverableAnnouncement: vi.fn(async () => ok({
        delivered: true as const,
        status: "accepted" as const,
      })),
    });

    const result = await sender.send({
      target: QUERY_ONE,
      text: "question",
      mode: "wait",
      caller: QUERY_TWO,
      callerSessionKey: "default:user2:channel2",
      callerConversation: PARENT_TWO,
      callerEndpoint: PARENT_TWO_ENDPOINT,
      callerAgentId: "parent-agent",
      announceOperationId: "bounded-response-tool-call",
      announceChannelType: "discord",
      announceChannelId: "guild-channel-42",
    });

    expect(result.response).toBe(rawResponse);
    expect(recordAnnouncementProducerOutcome).toHaveBeenCalledWith(
      scopedProducerKey("bounded-response-tool-call"),
      expect.objectContaining({
        terminalReason: "completed",
        response: expect.stringMatching(/^x+\n\n\[Response truncated/),
        responseRef: {
          kind: "session_metadata",
          operationId: scopedProducerKey("bounded-response-tool-call"),
        },
      }),
    );
    const handoffSave = vi.mocked(deps.sessionStore.save).mock.calls.find((call) => {
      const handoffs = call[2].announcementToolResultRecoveryHandoffs;
      return typeof handoffs === "object" && handoffs !== null;
    });
    expect(handoffSave?.[2]).toMatchObject({
      announcementToolResultRecoveryHandoffs: {
        [scopedProducerKey("bounded-response-tool-call")]: {
          operationId: scopedProducerKey("bounded-response-tool-call"),
          toolCallId: "bounded-response-tool-call",
          response: rawResponse,
        },
      },
    });
    const persistedOutcome = recordAnnouncementProducerOutcome.mock.calls.at(-1)?.[1];
    if (persistedOutcome === undefined) throw new Error("Expected a durable recovery outcome");
    const recoverySender = createCrossSessionSender({
      ...deps,
      reserveAnnouncementProducer: vi.fn(async () => ok({
        status: "recovery_owned" as const,
        lifecycleState: "promotion_ready" as const,
        recoveryOutcome: persistedOutcome,
      })),
      releaseAnnouncementProducer: vi.fn(async () => ok(undefined)),
      recordAnnouncementProducerOutcome: vi.fn(async () => ok(undefined)),
      cancelAnnouncementProducer: vi.fn(async () => ok(undefined)),
      suppressAnnouncementProducer: vi.fn(async () => ok(true)),
    });
    const recovered = await recoverySender.send({
      target: QUERY_ONE,
      text: "question",
      mode: "wait",
      caller: QUERY_TWO,
      callerSessionKey: "default:user2:channel2",
      callerConversation: PARENT_TWO,
      callerEndpoint: PARENT_TWO_ENDPOINT,
      callerAgentId: "parent-agent",
      announceOperationId: "bounded-response-tool-call",
      announceChannelType: "discord",
      announceChannelId: "guild-channel-42",
    });
    expect(recovered.response).toBe(rawResponse);
    expect(deps.executeInSession).toHaveBeenCalledOnce();
  });

  it("surfaces producer cancellation failure before returning execution failure", async () => {
    const reserveAnnouncementProducer = vi.fn(async () => ok({ status: "claimed" as const }));
    const releaseAnnouncementProducer = vi.fn(async () => ok(undefined));
    const recordAnnouncementProducerOutcome = vi.fn(async () => ok(undefined));
    const cancelAnnouncementProducer = vi.fn(async () =>
      err(new Error("producer cancellation storage unavailable")));
    const suppressAnnouncementProducer = vi.fn(async () => ok(true));
    vi.mocked(deps.sessionStore.save).mockReturnValue(
      err(new SessionStoreError("target save failed", "resource")),
    );
    const sender = createCrossSessionSender({
      ...deps,
      reserveAnnouncementProducer,
      releaseAnnouncementProducer,
      recordAnnouncementProducerOutcome,
      cancelAnnouncementProducer,
      suppressAnnouncementProducer,
    });

    await expect(sender.send({
      target: QUERY_ONE,
      text: "question",
      mode: "ping-pong",
      caller: QUERY_TWO,
      callerSessionKey: "default:user2:channel2",
      callerConversation: PARENT_TWO,
      callerEndpoint: PARENT_TWO_ENDPOINT,
      callerAgentId: "parent-agent",
      announceOperationId: "failed-cancellation-tool-call",
      announceChannelType: "discord",
      announceChannelId: "guild-channel-42",
    })).rejects.toThrow("producer cancellation storage unavailable");

    expect(cancelAnnouncementProducer).toHaveBeenCalledWith(
      scopedProducerKey("failed-cancellation-tool-call"),
    );
    expect(releaseAnnouncementProducer).not.toHaveBeenCalled();
  });

  it("surfaces producer release failure over an otherwise completed send", async () => {
    const sendRecoverableAnnouncement = vi.fn(async () => ok({
      delivered: true as const,
      status: "accepted" as const,
    }));
    const recordAnnouncementProducerOutcome = vi.fn(async () => ok(undefined));
    const cancelAnnouncementProducer = vi.fn(async () => ok(undefined));
    const releaseAnnouncementProducer = vi.fn(async () =>
      err(new Error("producer release storage unavailable")));
    const sender = createCrossSessionSender({
      ...deps,
      sendRecoverableAnnouncement,
      reserveAnnouncementProducer: vi.fn(async () => ok({ status: "claimed" as const })),
      recordAnnouncementProducerOutcome,
      releaseAnnouncementProducer,
      cancelAnnouncementProducer,
      suppressAnnouncementProducer: vi.fn(async () => ok(true)),
    });

    // The send itself completes and announces; an unsettled reservation still
    // takes precedence, because no retry can reconcile the durable ownership.
    await expect(sender.send({
      target: QUERY_ONE,
      text: "question",
      mode: "wait",
      caller: QUERY_TWO,
      callerSessionKey: "default:user2:channel2",
      callerConversation: PARENT_TWO,
      callerEndpoint: PARENT_TWO_ENDPOINT,
      callerAgentId: "parent-agent",
      announceOperationId: "failed-release-tool-call",
      announceChannelType: "discord",
      announceChannelId: "guild-channel-42",
    })).rejects.toThrow("producer release storage unavailable");

    expect(sendRecoverableAnnouncement).toHaveBeenCalledOnce();
    expect(recordAnnouncementProducerOutcome).toHaveBeenCalledWith(
      scopedProducerKey("failed-release-tool-call"),
      expect.objectContaining({ announced: true }),
    );
    expect(releaseAnnouncementProducer).toHaveBeenCalledWith(
      scopedProducerKey("failed-release-tool-call"),
    );
    expect(cancelAnnouncementProducer).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Event emitted for each mode
  // -----------------------------------------------------------------------
  it("emits session:cross_send event for fire-and-forget mode", async () => {
    const sender = createCrossSessionSender(deps);

    await sender.send({
      target: QUERY_ONE,
      text: "hello",
      mode: "fire-and-forget",
      caller: QUERY_TWO,
      callerSessionKey: "default:user2:channel2",
    });

    expect(deps.eventBus.emit).toHaveBeenCalledWith("session:cross_send", expect.objectContaining({
      fromSessionKey: "default:user2:channel2",
      toSessionKey: TARGET_ONE_DISPLAY,
      mode: "fire-and-forget",
    }));
  });

  it("emits session:cross_send event for wait mode", async () => {
    const sender = createCrossSessionSender(deps);

    await sender.send({
      target: QUERY_ONE,
      text: "hello",
      mode: "wait",
      caller: QUERY_TWO,
      callerSessionKey: "default:user2:channel2",
    });

    expect(deps.eventBus.emit).toHaveBeenCalledWith("session:cross_send", expect.objectContaining({
      mode: "wait",
    }));
  });

  it("emits session:ping_pong_turn events for ping-pong mode", async () => {
    const sender = createCrossSessionSender(deps);

    await sender.send({
      target: QUERY_ONE,
      text: "ping",
      mode: "ping-pong",
      maxTurns: 2,
      caller: QUERY_TWO,
      callerSessionKey: "default:user2:channel2",
    });

    // Should have cross_send + 2 ping_pong_turn events
    expect(deps.eventBus.emit).toHaveBeenCalledWith("session:cross_send", expect.objectContaining({
      mode: "ping-pong",
    }));
    expect(deps.eventBus.emit).toHaveBeenCalledWith("session:ping_pong_turn", expect.objectContaining({
      turnNumber: 1,
      totalTurns: 2,
    }));
    expect(deps.eventBus.emit).toHaveBeenCalledWith("session:ping_pong_turn", expect.objectContaining({
      turnNumber: 2,
      totalTurns: 2,
    }));
  });

  // -----------------------------------------------------------------------
  // Error cases
  // -----------------------------------------------------------------------
  it("propagates a typed target conversation lookup failure", async () => {
    vi.mocked(deps.sessionStore.loadByRef).mockReturnValue(err(new Error("target lookup failed")) as never);
    const sender = createCrossSessionSender(deps);

    await expect(
      sender.send({
        target: QUERY_ONE,
        text: "hello",
        mode: "fire-and-forget",
      }),
    ).rejects.toThrow("target lookup failed");
  });

  it("throws when target conversation is not found under explicit authority", async () => {
    const sender = createCrossSessionSender(deps);

    await expect(
      sender.send({
        target: QUERY_THREE,
        text: "hello",
        mode: "fire-and-forget",
      }),
    ).rejects.toThrow("Target conversation not found");
  });
});

describe("createCrossSessionSender uses the governed announcement port", () => {
  let deps: CrossSessionSenderDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  const ledgeredParams: CrossSessionSendParams = {
    target: QUERY_ONE,
    text: "question",
    mode: "wait",
    caller: QUERY_TWO,
    callerSessionKey: "default:user2:channel2",
    callerConversation: PARENT_TWO,
    callerEndpoint: PARENT_TWO_ENDPOINT,
    callerAgentId: "parent-agent",
    announceOperationId: "announce-tool-call-1",
    announceChannelType: "discord",
    announceChannelId: "guild-channel-42",
  };

  it("reports a receipt-committed governed send as announced", async () => {
    const sendGovernedAnnouncement = vi.fn(async () => ok({
      delivered: true as const,
      identity: { agentId: "parent-agent", rootRunId: "root-user2", stepIndex: 7 },
    }));
    const sender = createCrossSessionSender({
      ...deps,
      sendGovernedAnnouncement,
    });

    const result = await sender.send(ledgeredParams);

    expect(result.announced).toBe(true);
    expect(sendGovernedAnnouncement).toHaveBeenCalledWith({
      agentId: "parent-agent",
      callerSessionKey: "default:user2:channel2",
      callerConversation: PARENT_TWO,
      destinationEndpoint: PARENT_TWO_ENDPOINT,
      runId: scopedProducerKey("announce-tool-call-1"),
      channelType: "discord",
      channelId: "guild-channel-42",
      text: "test response",
      completionKeys: [scopedProducerKey("announce-tool-call-1")],
    });
    expect(deps.sendToChannel).not.toHaveBeenCalled();
  });

  it("does not raw-send after a governed adapter rejection", async () => {
    const sendGovernedAnnouncement = vi.fn(async () => ok({
      delivered: false as const,
      identity: { agentId: "parent-agent", rootRunId: "root-user2", stepIndex: 7 },
      failure: "transport_rejected" as const,
    }));
    const sender = createCrossSessionSender({
      ...deps,
      sendGovernedAnnouncement,
    });

    const result = await sender.send(ledgeredParams);

    expect(result.announced).toBe(false);
    expect(sendGovernedAnnouncement).toHaveBeenCalledOnce();
    expect(deps.sendToChannel).not.toHaveBeenCalled();
  });

  it("reports a retained receipt-unknown ledgerless send without raw replay", async () => {
    const sendRecoverableAnnouncement = vi.fn(async () => ok({
      delivered: false as const,
      status: "unknown" as const,
    }));
    const sender = createCrossSessionSender({
      ...deps,
      sendRecoverableAnnouncement,
    });

    const result = await sender.send(ledgeredParams);

    expect(result.announced).toBe(false);
    expect(sendRecoverableAnnouncement).toHaveBeenCalledOnce();
    expect(deps.sendToChannel).not.toHaveBeenCalled();
  });

  it("reports a terminally confirmed ledgerless delivery as announced", async () => {
    const sendRecoverableAnnouncement = vi.fn(async () => ok({
      delivered: false as const,
      terminalDecision: "delivered" as const,
    }));
    const sender = createCrossSessionSender({
      ...deps,
      sendRecoverableAnnouncement,
    });

    const result = await sender.send(ledgeredParams);

    expect(result.announced).toBe(true);
    expect(sendRecoverableAnnouncement).toHaveBeenCalledOnce();
    expect(deps.sendToChannel).not.toHaveBeenCalled();
  });

  it("passes the authenticated topic to governed announcement delivery", async () => {
    const sendGovernedAnnouncement = vi.fn(async () => ok({
      delivered: true as const,
      identity: { agentId: "parent-agent", rootRunId: "root-user2", stepIndex: 7 },
    }));
    const callerEndpoint = { ...PARENT_TWO_ENDPOINT, threadId: "topic-17" };
    const sender = createCrossSessionSender({
      ...deps,
      sendGovernedAnnouncement,
    });

    const result = await sender.send({ ...ledgeredParams, callerEndpoint });

    expect(result.announced).toBe(true);
    expect(sendGovernedAnnouncement).toHaveBeenCalledWith(expect.objectContaining({
      destinationEndpoint: callerEndpoint,
      options: { threadId: "topic-17" },
    }));
  });

  it("reports an operator-confirmed terminal delivery as announced", async () => {
    const sendGovernedAnnouncement = vi.fn(async () => ok({
      delivered: false as const,
      terminalDecision: "delivered" as const,
    }));
    const sender = createCrossSessionSender({
      ...deps,
      sendGovernedAnnouncement,
    });

    const result = await sender.send(ledgeredParams);

    expect(result.announced).toBe(true);
    expect(deps.sendToChannel).not.toHaveBeenCalled();
  });

  it("does not raw-send when the governed boundary loses its response", async () => {
    const sendGovernedAnnouncement = vi.fn(async () => Promise.reject(
      new Error("platform response unavailable"),
    ));
    const sender = createCrossSessionSender({
      ...deps,
      sendGovernedAnnouncement,
    });

    const result = await sender.send(ledgeredParams);

    expect(result.announced).toBe(false);
    expect(deps.sendToChannel).not.toHaveBeenCalled();
  });

  it("reuses the stable originating operation on duplicate invocation", async () => {
    const seen = new Set<string>();
    const platformCalls: string[] = [];
    const sendGovernedAnnouncement: NonNullable<CrossSessionSenderDeps["sendGovernedAnnouncement"]> = vi.fn(async (request) => {
      const operation = `${request.agentId}:${request.callerSessionKey}:${request.runId}`;
      if (!seen.has(operation)) {
        seen.add(operation);
        platformCalls.push(operation);
      }
      return ok({
        delivered: true as const,
        identity: { agentId: request.agentId, rootRunId: "root-user2", stepIndex: 7 },
      });
    });
    const sender = createCrossSessionSender({ ...deps, sendGovernedAnnouncement });

    const first = await sender.send(ledgeredParams);
    const second = await sender.send(ledgeredParams);

    expect(first.announced).toBe(true);
    expect(second.announced).toBe(true);
    expect(platformCalls).toEqual([
      `parent-agent:default:user2:channel2:${scopedProducerKey("announce-tool-call-1")}`,
    ]);
    expect(sendGovernedAnnouncement).toHaveBeenCalledTimes(2);
    expect(vi.mocked(sendGovernedAnnouncement).mock.calls[0]).toEqual(
      vi.mocked(sendGovernedAnnouncement).mock.calls[1],
    );
    expect(deps.sendToChannel).not.toHaveBeenCalled();
  });

  it("fails closed when governed delivery lacks an authenticated caller", async () => {
    const sendGovernedAnnouncement = vi.fn();
    const sender = createCrossSessionSender({
      ...deps,
      sendGovernedAnnouncement,
    });

    const result = await sender.send({
      target: QUERY_ONE,
      text: "question",
      mode: "wait",
      announceChannelType: "discord",
      announceChannelId: "guild-channel-42",
    });

    expect(result.announced).toBe(false);
    expect(sendGovernedAnnouncement).not.toHaveBeenCalled();
    expect(deps.sendToChannel).not.toHaveBeenCalled();
  });

  it("fails closed when governed delivery lacks a stable operation identity", async () => {
    const sendGovernedAnnouncement = vi.fn();
    const sender = createCrossSessionSender({
      ...deps,
      sendGovernedAnnouncement,
    });

    const result = await sender.send({
      ...ledgeredParams,
      announceOperationId: undefined,
    });

    expect(result.announced).toBe(false);
    expect(sendGovernedAnnouncement).not.toHaveBeenCalled();
    expect(deps.sendToChannel).not.toHaveBeenCalled();
  });

  it("keeps governed boundary errors content-safe", async () => {
    const sendGovernedAnnouncement = vi.fn(async () => err(
      new Error("lookup failed token=private-value"),
    ));
    const error = vi.fn();
    const sender = createCrossSessionSender({
      ...deps,
      sendGovernedAnnouncement,
      logger: { error },
    });

    const result = await sender.send(ledgeredParams);

    expect(result.announced).toBe(false);
    expect(deps.sendToChannel).not.toHaveBeenCalled();
    expect(JSON.stringify(error.mock.calls)).not.toContain("private-value");
  });
});
