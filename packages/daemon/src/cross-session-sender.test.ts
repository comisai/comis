import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createCrossSessionSender,
  type CrossSessionSenderDeps,
  type CrossSessionSendParams,
} from "./cross-session-sender.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockDeps(): CrossSessionSenderDeps {
  const sessionData = new Map<string, { messages: unknown[]; metadata: Record<string, unknown> }>();

  // Pre-populate a target session
  sessionData.set("default:user1:channel1", {
    messages: [{ role: "user", content: "hello", timestamp: 1000 }],
    metadata: { createdAt: 1000 },
  });

  // Pre-populate a second session for ping-pong
  sessionData.set("default:user2:channel2", {
    messages: [],
    metadata: { createdAt: 2000 },
  });

  return {
    sessionStore: {
      loadByFormattedKey: vi.fn((key: string) => sessionData.get(key)),
      save: vi.fn((key, messages, metadata) => {
        const formatted = `${key.tenantId}:${key.userId}:${key.channelId}`;
        sessionData.set(formatted, { messages, metadata });
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
  // Test 1: Fire-and-forget injects message and returns immediately
  // -----------------------------------------------------------------------
  it("fire-and-forget injects message and returns immediately", async () => {
    const sender = createCrossSessionSender(deps);
    const params: CrossSessionSendParams = {
      targetSessionKey: "default:user1:channel1",
      text: "cross-session hello",
      mode: "fire-and-forget",
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
  // Test 2: Wait mode executes target and returns response
  // -----------------------------------------------------------------------
  it("wait mode executes target and returns response", async () => {
    const sender = createCrossSessionSender(deps);
    const params: CrossSessionSendParams = {
      targetSessionKey: "default:user1:channel1",
      text: "need info",
      mode: "wait",
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
      { tenantId: "default", userId: "user1", channelId: "channel1" },
      "need info",
    );
  });

  // -----------------------------------------------------------------------
  // Test 3: Ping-pong mode completes N turns
  // -----------------------------------------------------------------------
  it("ping-pong mode completes N turns", async () => {
    const sender = createCrossSessionSender(deps);
    const params: CrossSessionSendParams = {
      targetSessionKey: "default:user1:channel1",
      text: "start conversation",
      mode: "ping-pong",
      maxTurns: 2,
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
  // Test 4: ANNOUNCE_SKIP suppresses announcement
  // -----------------------------------------------------------------------
  it("ANNOUNCE_SKIP suppresses announcement and is stripped from response", async () => {
    vi.mocked(deps.executeInSession).mockResolvedValue({
      response: "result text ANNOUNCE_SKIP",
      tokensUsed: { total: 50 },
      cost: { total: 0.005 },
    });

    const sender = createCrossSessionSender(deps);
    const params: CrossSessionSendParams = {
      targetSessionKey: "default:user1:channel1",
      text: "do something",
      mode: "wait",
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
  // Test 5: Self-targeting in wait mode throws
  // -----------------------------------------------------------------------
  it("self-targeting in wait mode throws deadlock error", async () => {
    const sender = createCrossSessionSender(deps);
    const params: CrossSessionSendParams = {
      targetSessionKey: "default:user1:channel1",
      text: "talk to myself",
      mode: "wait",
      callerSessionKey: "default:user1:channel1",
    };

    await expect(sender.send(params)).rejects.toThrow(
      "Cannot send to own session in wait/ping-pong mode (deadlock risk). Use fire-and-forget mode instead.",
    );
  });

  // -----------------------------------------------------------------------
  // Test 6: Self-targeting in fire-and-forget is allowed
  // -----------------------------------------------------------------------
  it("self-targeting in fire-and-forget is allowed", async () => {
    const sender = createCrossSessionSender(deps);
    const params: CrossSessionSendParams = {
      targetSessionKey: "default:user1:channel1",
      text: "note to self",
      mode: "fire-and-forget",
      callerSessionKey: "default:user1:channel1",
    };

    const result = await sender.send(params);

    expect(result.sent).toBe(true);
    // No error thrown
  });

  // -----------------------------------------------------------------------
  // Test 7: Ping-pong stops early on ANNOUNCE_SKIP
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
      targetSessionKey: "default:user1:channel1",
      text: "start",
      mode: "ping-pong",
      maxTurns: 5,
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
  // Test 8: Announce sends to channel
  // -----------------------------------------------------------------------
  it("announce sends to channel with correct params", async () => {
    const sender = createCrossSessionSender(deps);
    const params: CrossSessionSendParams = {
      targetSessionKey: "default:user1:channel1",
      text: "question",
      mode: "wait",
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
  // Test 9: Event emitted for each mode
  // -----------------------------------------------------------------------
  it("emits session:cross_send event for fire-and-forget mode", async () => {
    const sender = createCrossSessionSender(deps);

    await sender.send({
      targetSessionKey: "default:user1:channel1",
      text: "hello",
      mode: "fire-and-forget",
      callerSessionKey: "default:user2:channel2",
    });

    expect(deps.eventBus.emit).toHaveBeenCalledWith("session:cross_send", expect.objectContaining({
      fromSessionKey: "default:user2:channel2",
      toSessionKey: "default:user1:channel1",
      mode: "fire-and-forget",
    }));
  });

  it("emits session:cross_send event for wait mode", async () => {
    const sender = createCrossSessionSender(deps);

    await sender.send({
      targetSessionKey: "default:user1:channel1",
      text: "hello",
      mode: "wait",
      callerSessionKey: "default:user2:channel2",
    });

    expect(deps.eventBus.emit).toHaveBeenCalledWith("session:cross_send", expect.objectContaining({
      mode: "wait",
    }));
  });

  it("emits session:ping_pong_turn events for ping-pong mode", async () => {
    const sender = createCrossSessionSender(deps);

    await sender.send({
      targetSessionKey: "default:user1:channel1",
      text: "ping",
      mode: "ping-pong",
      maxTurns: 2,
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
  it("throws when target session key is invalid", async () => {
    const sender = createCrossSessionSender(deps);

    await expect(
      sender.send({
        targetSessionKey: "",
        text: "hello",
        mode: "fire-and-forget",
      }),
    ).rejects.toThrow("Invalid session key");
  });

  it("throws when target session not found", async () => {
    const sender = createCrossSessionSender(deps);

    await expect(
      sender.send({
        targetSessionKey: "default:nonexistent:user",
        text: "hello",
        mode: "fire-and-forget",
      }),
    ).rejects.toThrow("Session not found");
  });
});
