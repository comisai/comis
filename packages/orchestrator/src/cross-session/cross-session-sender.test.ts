// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { err, ok } from "@comis/shared";
import { createConversationLocator, conversationScopeToSessionKey, formatSessionKey } from "@comis/core";
import {
  createCrossSessionSender,
  type CrossSessionSenderDeps,
  type CrossSessionSendParams,
} from "./cross-session-sender.js";

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

function createMockDeps(): CrossSessionSenderDeps {
  const sessionData = new Map<string, ReturnType<typeof makeSessionData>>();

  function makeSessionData(locator: typeof TARGET_ONE, messages: unknown[], createdAt: number) {
    return {
      ...locator,
      messages,
      metadata: { createdAt },
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

  return {
    sessionStore: {
      loadByRef: vi.fn((_scope, conversationRef) => ok(sessionData.get(conversationRef))),
      save: vi.fn((scope, messages, metadata) => {
        const locator = scope.agentId === TARGET_ONE.conversationScope.agentId
          && scope.partition.kind === "endpoint-conversation-principal"
          && scope.partition.principalId === "user1"
          ? TARGET_ONE
          : TARGET_TWO;
        sessionData.set(locator.conversationRef, makeSessionData(locator, messages, Number(metadata.createdAt ?? 0)));
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
  it("announce sends to channel with correct params", async () => {
    const sender = createCrossSessionSender(deps);
    const params: CrossSessionSendParams = {
      target: QUERY_ONE,
      text: "question",
      mode: "wait",
      caller: QUERY_TWO,
      callerSessionKey: "default:user2:channel2",
      announceChannelType: "discord",
      announceChannelId: "guild-channel-42",
    };

    const result = await sender.send(params);

    expect(result.announced).toBe(true);
    expect(deps.sendToChannel).toHaveBeenCalledTimes(1);
    expect(deps.sendToChannel).toHaveBeenCalledWith("discord", "guild-channel-42", "test response");
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
      runId: "announce-tool-call-1",
      channelType: "discord",
      channelId: "guild-channel-42",
      text: "test response",
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
    expect(platformCalls).toEqual(["parent-agent:default:user2:channel2:announce-tool-call-1"]);
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
