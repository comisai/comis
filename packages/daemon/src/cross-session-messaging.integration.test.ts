/**
 * Integration tests for cross-session messaging.
 * Exercises createCrossSessionSender with real module instances and controlled
 * mock boundaries (session store, executeInSession, sendToChannel, EventBus).
 * Covers:
 * - Fire-and-forget mode (message injected, no execution)
 * - Wait mode (target agent executed, response returned)
 * - Ping-pong mode (alternating turns between sessions)
 * - Ping-pong early exit on ANNOUNCE_SKIP
 * - Self-targeting deadlock detection (wait/ping-pong rejected)
 * - Self-targeting fire-and-forget (allowed)
 * - Channel announcement with stats
 * - ANNOUNCE_SKIP suppresses channel send
 * - Event emission for all modes
 * - Stats accumulation across ping-pong turns
 * @module
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createCrossSessionSender,
  type CrossSessionSenderDeps,
} from "./cross-session-sender.js";

// ---------------------------------------------------------------------------
// Test helper: builds deps with real-ish in-memory session store
// ---------------------------------------------------------------------------

function buildDeps(overrides?: Partial<CrossSessionSenderDeps>): CrossSessionSenderDeps {
  const sessionData = new Map<
    string,
    { messages: unknown[]; metadata: Record<string, unknown> }
  >();

  // Pre-populate two sessions with different keys
  sessionData.set("default:alice:ch-alpha", {
    messages: [{ role: "user", content: "prior message", timestamp: 1000 }],
    metadata: { createdAt: 1000 },
  });

  sessionData.set("default:bob:ch-beta", {
    messages: [],
    metadata: { createdAt: 2000 },
  });

  const sessionStore: CrossSessionSenderDeps["sessionStore"] = {
    loadByFormattedKey: vi.fn((key: string) => {
      const entry = sessionData.get(key);
      if (!entry) return undefined;
      // Return a shallow copy so repeated loads reflect prior saves
      return { messages: [...entry.messages], metadata: { ...entry.metadata } };
    }),
    save: vi.fn(
      (
        key: { tenantId: string; userId: string; channelId: string },
        messages: unknown[],
        metadata: Record<string, unknown>,
      ) => {
        const formatted = `${key.tenantId}:${key.userId}:${key.channelId}`;
        sessionData.set(formatted, { messages: [...messages], metadata: { ...metadata } });
      },
    ),
  };

  return {
    sessionStore,
    executeInSession: vi.fn().mockResolvedValue({
      response: "hello from target",
      tokensUsed: { total: 50 },
      cost: { total: 0.005 },
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
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("cross-session messaging integration", () => {
  let deps: CrossSessionSenderDeps;

  beforeEach(() => {
    deps = buildDeps();
  });

  // -------------------------------------------------------------------------
  // 1. Fire-and-forget: message injected, no execution triggered
  // -------------------------------------------------------------------------

  it("fire-and-forget: message injected into session store, no execution triggered", async () => {
    const sender = createCrossSessionSender(deps);

    const result = await sender.send({
      targetSessionKey: "default:alice:ch-alpha",
      text: "cross-session ping",
      mode: "fire-and-forget",
      callerSessionKey: "default:bob:ch-beta",
    });

    // Result: sent with no response
    expect(result.sent).toBe(true);
    expect(result.response).toBeUndefined();

    // Session store save was called with appended message
    expect(deps.sessionStore.save).toHaveBeenCalledTimes(1);
    const saveCall = vi.mocked(deps.sessionStore.save).mock.calls[0]!;
    const savedMessages = saveCall[1] as Array<{
      role: string;
      content: string;
      metadata: { crossSession: boolean; fromSession: string };
    }>;

    // Original message + new cross-session message
    expect(savedMessages).toHaveLength(2);
    const injected = savedMessages[1]!;
    expect(injected.role).toBe("user");
    expect(injected.content).toBe("cross-session ping");
    expect(injected.metadata.crossSession).toBe(true);
    expect(injected.metadata.fromSession).toBe("default:bob:ch-beta");

    // executeInSession NOT called
    expect(deps.executeInSession).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 2. Wait mode: target agent executed and response returned
  // -------------------------------------------------------------------------

  it("wait mode: executes target agent and returns response with stats", async () => {
    const sender = createCrossSessionSender(deps);

    const result = await sender.send({
      targetSessionKey: "default:alice:ch-alpha",
      text: "need info",
      mode: "wait",
      callerSessionKey: "default:bob:ch-beta",
    });

    // executeInSession called once with correct params
    expect(deps.executeInSession).toHaveBeenCalledTimes(1);
    expect(deps.executeInSession).toHaveBeenCalledWith(
      "default", // agentId from parsed key
      { tenantId: "default", userId: "alice", channelId: "ch-alpha" },
      "need info",
    );

    // Result includes response and stats
    expect(result.sent).toBe(true);
    expect(result.response).toBe("hello from target");
    expect(result.stats).toBeDefined();
    expect(result.stats!.totalTokens).toBe(50);
    expect(result.stats!.totalCost).toBe(0.005);
    expect(result.stats!.runtimeMs).toBeGreaterThanOrEqual(0);
  });

  // -------------------------------------------------------------------------
  // 3. Ping-pong: two turns alternating between sessions
  // -------------------------------------------------------------------------

  it("ping-pong: alternates between sessions for N turns", async () => {
    let callCount = 0;
    vi.mocked(deps.executeInSession).mockImplementation(async () => {
      callCount++;
      return {
        response: `response-${callCount}`,
        tokensUsed: { total: 100 },
        cost: { total: 0.01 },
      };
    });

    const sender = createCrossSessionSender(deps);

    const result = await sender.send({
      targetSessionKey: "default:alice:ch-alpha",
      text: "start conversation",
      mode: "ping-pong",
      maxTurns: 2,
      callerSessionKey: "default:bob:ch-beta",
    });

    // 1 initial execution + 2 ping-pong turns = 3 total calls
    expect(deps.executeInSession).toHaveBeenCalledTimes(3);
    expect(result.turnsCompleted).toBe(2);

    // session:ping_pong_turn emitted twice
    const pingPongCalls = vi
      .mocked(deps.eventBus.emit)
      .mock.calls.filter(([event]) => event === "session:ping_pong_turn");
    expect(pingPongCalls).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // 4. Ping-pong early exit on ANNOUNCE_SKIP
  // -------------------------------------------------------------------------

  it("ping-pong: exits early when ANNOUNCE_SKIP appears in response", async () => {
    // Initial execution returns response with ANNOUNCE_SKIP
    vi.mocked(deps.executeInSession).mockResolvedValue({
      response: "done ANNOUNCE_SKIP",
      tokensUsed: { total: 50 },
      cost: { total: 0.005 },
    });

    const sender = createCrossSessionSender(deps);

    const result = await sender.send({
      targetSessionKey: "default:alice:ch-alpha",
      text: "start",
      mode: "ping-pong",
      maxTurns: 5,
      callerSessionKey: "default:bob:ch-beta",
    });

    // Only the initial execution (no ping-pong turns because first response has ANNOUNCE_SKIP)
    expect(deps.executeInSession).toHaveBeenCalledTimes(1);
    expect(result.turnsCompleted).toBe(0);

    // ANNOUNCE_SKIP stripped from response
    expect(result.response).not.toContain("ANNOUNCE_SKIP");
    expect(result.response).toBe("done");
  });

  // -------------------------------------------------------------------------
  // 5. Self-targeting in wait mode throws deadlock error
  // -------------------------------------------------------------------------

  it("self-targeting in wait mode throws deadlock error", async () => {
    const sender = createCrossSessionSender(deps);

    await expect(
      sender.send({
        targetSessionKey: "default:alice:ch-alpha",
        text: "talk to myself",
        mode: "wait",
        callerSessionKey: "default:alice:ch-alpha",
      }),
    ).rejects.toThrow(/deadlock|own session/);
  });

  // -------------------------------------------------------------------------
  // 6. Self-targeting in fire-and-forget succeeds
  // -------------------------------------------------------------------------

  it("self-targeting in fire-and-forget succeeds without error", async () => {
    const sender = createCrossSessionSender(deps);

    const result = await sender.send({
      targetSessionKey: "default:alice:ch-alpha",
      text: "note to self",
      mode: "fire-and-forget",
      callerSessionKey: "default:alice:ch-alpha",
    });

    expect(result.sent).toBe(true);
    // No error thrown, message was injected
    expect(deps.sessionStore.save).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 7. Announce sends result to channel
  // -------------------------------------------------------------------------

  it("announce sends response to channel with correct type, id, and text", async () => {
    const sender = createCrossSessionSender(deps);

    const result = await sender.send({
      targetSessionKey: "default:alice:ch-alpha",
      text: "query",
      mode: "wait",
      callerSessionKey: "default:bob:ch-beta",
      announceChannelType: "telegram",
      announceChannelId: "chat-789",
    });

    expect(result.announced).toBe(true);
    expect(deps.sendToChannel).toHaveBeenCalledTimes(1);
    expect(deps.sendToChannel).toHaveBeenCalledWith(
      "telegram",
      "chat-789",
      "hello from target",
    );
  });

  // -------------------------------------------------------------------------
  // 8. ANNOUNCE_SKIP suppresses channel send
  // -------------------------------------------------------------------------

  it("ANNOUNCE_SKIP suppresses channel announcement", async () => {
    vi.mocked(deps.executeInSession).mockResolvedValue({
      response: "silent result ANNOUNCE_SKIP",
      tokensUsed: { total: 30 },
      cost: { total: 0.003 },
    });

    const sender = createCrossSessionSender(deps);

    const result = await sender.send({
      targetSessionKey: "default:alice:ch-alpha",
      text: "do quietly",
      mode: "wait",
      callerSessionKey: "default:bob:ch-beta",
      announceChannelType: "discord",
      announceChannelId: "guild-42",
    });

    // sendToChannel NOT called
    expect(deps.sendToChannel).not.toHaveBeenCalled();
    expect(result.announced).toBe(false);
    // ANNOUNCE_SKIP stripped
    expect(result.response).toBe("silent result");
  });

  // -------------------------------------------------------------------------
  // 9. Event emission for all modes
  // -------------------------------------------------------------------------

  it("emits session:cross_send event for each mode", async () => {
    const sender = createCrossSessionSender(deps);

    // Fire-and-forget
    await sender.send({
      targetSessionKey: "default:alice:ch-alpha",
      text: "ff",
      mode: "fire-and-forget",
      callerSessionKey: "default:bob:ch-beta",
    });

    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      "session:cross_send",
      expect.objectContaining({ mode: "fire-and-forget" }),
    );

    // Wait
    await sender.send({
      targetSessionKey: "default:alice:ch-alpha",
      text: "w",
      mode: "wait",
      callerSessionKey: "default:bob:ch-beta",
    });

    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      "session:cross_send",
      expect.objectContaining({ mode: "wait" }),
    );

    // Ping-pong
    await sender.send({
      targetSessionKey: "default:alice:ch-alpha",
      text: "pp",
      mode: "ping-pong",
      maxTurns: 1,
      callerSessionKey: "default:bob:ch-beta",
    });

    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      "session:cross_send",
      expect.objectContaining({ mode: "ping-pong" }),
    );

    // All three cross_send events emitted
    const crossSendCalls = vi
      .mocked(deps.eventBus.emit)
      .mock.calls.filter(([event]) => event === "session:cross_send");
    expect(crossSendCalls).toHaveLength(3);
  });

  // -------------------------------------------------------------------------
  // 10. Multiple ping-pong turns accumulate stats correctly
  // -------------------------------------------------------------------------

  it("ping-pong stats accumulate correctly across all turns", async () => {
    vi.mocked(deps.executeInSession).mockResolvedValue({
      response: "turn response",
      tokensUsed: { total: 100 },
      cost: { total: 0.01 },
    });

    const sender = createCrossSessionSender(deps);

    const result = await sender.send({
      targetSessionKey: "default:alice:ch-alpha",
      text: "accumulate",
      mode: "ping-pong",
      maxTurns: 3,
      callerSessionKey: "default:bob:ch-beta",
    });

    // 1 initial + 3 turns = 4 total executions
    expect(deps.executeInSession).toHaveBeenCalledTimes(4);
    expect(result.turnsCompleted).toBe(3);

    // Stats accumulated: 4 * 100 tokens, 4 * 0.01 cost
    expect(result.stats!.totalTokens).toBe(400);
    expect(result.stats!.totalCost).toBeCloseTo(0.04);
  });
});
