// SPDX-License-Identifier: Apache-2.0
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
import { createConversationLocator } from "@comis/core";
import { ok } from "@comis/shared";
import {
  createCrossSessionSender,
  type CrossSessionSenderDeps,
} from "../cross-session/cross-session-sender.js";

// ---------------------------------------------------------------------------
// Test helper: builds deps with real-ish in-memory session store
// ---------------------------------------------------------------------------

function conversation(principalId: string, conversationId: string) {
  const endpoint = {
    channelType: "test",
    channelInstanceId: "cross-session-integration",
    conversationId,
    conversationKind: "direct" as const,
  };
  const locator = createConversationLocator({
    tenantId: "default",
    agentId: "default",
    partition: {
      kind: "endpoint-conversation-principal",
      endpoint,
      principalId,
    },
  });
  if (!locator.ok) throw locator.error;
  return locator.value;
}

const ALICE = conversation("alice", "ch-alpha");
const BOB = conversation("bob", "ch-beta");
const ALICE_QUERY = { tenantId: "default", agentId: "default", conversationRef: ALICE.conversationRef };
const BOB_QUERY = { tenantId: "default", agentId: "default", conversationRef: BOB.conversationRef };

function buildDeps(overrides?: Partial<CrossSessionSenderDeps>): CrossSessionSenderDeps {
  const sessionData = new Map<
    string,
    { messages: unknown[]; metadata: Record<string, unknown>; locator: typeof ALICE }
  >();

  // Pre-populate two sessions with different keys
  sessionData.set(ALICE.conversationRef, {
    messages: [{ role: "user", content: "prior message", timestamp: 1000 }],
    metadata: { createdAt: 1000 },
    locator: ALICE,
  });

  sessionData.set(BOB.conversationRef, {
    messages: [],
    metadata: { createdAt: 2000 },
    locator: BOB,
  });

  const sessionStore: CrossSessionSenderDeps["sessionStore"] = {
    loadByRef: vi.fn((_scope, conversationRef) => {
      const entry = sessionData.get(conversationRef);
      if (!entry) return ok(undefined);
      // Return a shallow copy so repeated loads reflect prior saves
      return ok({
        ...entry.locator,
        messages: [...entry.messages],
        metadata: { ...entry.metadata },
        createdAt: Number(entry.metadata.createdAt ?? 0),
        updatedAt: Number(entry.metadata.createdAt ?? 0),
      });
    }),
    save: vi.fn(
      (
        scope,
        messages: unknown[],
        metadata: Record<string, unknown>,
      ) => {
        const locator = scope.partition.kind === "endpoint-conversation-principal"
          && scope.partition.principalId === "alice" ? ALICE : BOB;
        sessionData.set(locator.conversationRef, { messages: [...messages], metadata: { ...metadata }, locator });
        return ok(undefined);
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
      target: ALICE_QUERY,
      text: "cross-session ping",
      mode: "fire-and-forget",
      caller: BOB_QUERY,
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
      metadata: { crossSession: boolean; fromConversationRef: string };
    }>;

    // Original message + new cross-session message
    expect(savedMessages).toHaveLength(2);
    const injected = savedMessages[1]!;
    expect(injected.role).toBe("user");
    expect(injected.content).toBe("cross-session ping");
    expect(injected.metadata.crossSession).toBe(true);
    expect(injected.metadata.fromConversationRef).toBe(BOB.conversationRef);

    // executeInSession NOT called
    expect(deps.executeInSession).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 2. Wait mode: target agent executed and response returned
  // -------------------------------------------------------------------------

  it("wait mode: executes target agent and returns response with stats", async () => {
    const sender = createCrossSessionSender(deps);

    const result = await sender.send({
      target: ALICE_QUERY,
      text: "need info",
      mode: "wait",
      caller: BOB_QUERY,
    });

    // executeInSession called once with correct params
    expect(deps.executeInSession).toHaveBeenCalledTimes(1);
    expect(deps.executeInSession).toHaveBeenCalledWith(
      "default",
      { tenantId: "default", agentId: "default", userId: "alice", channelId: "test:cross-session-integration:ch-alpha", peerId: "alice" },
      ALICE,
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
      target: ALICE_QUERY,
      text: "start conversation",
      mode: "ping-pong",
      maxTurns: 2,
      caller: BOB_QUERY,
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
      target: ALICE_QUERY,
      text: "start",
      mode: "ping-pong",
      maxTurns: 5,
      caller: BOB_QUERY,
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
        target: ALICE_QUERY,
        text: "talk to myself",
        mode: "wait",
        caller: ALICE_QUERY,
      }),
    ).rejects.toThrow(/deadlock|own session/);
  });

  // -------------------------------------------------------------------------
  // 6. Self-targeting in fire-and-forget succeeds
  // -------------------------------------------------------------------------

  it("self-targeting in fire-and-forget succeeds without error", async () => {
    const sender = createCrossSessionSender(deps);

    const result = await sender.send({
      target: ALICE_QUERY,
      text: "note to self",
      mode: "fire-and-forget",
      caller: ALICE_QUERY,
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
      target: ALICE_QUERY,
      text: "query",
      mode: "wait",
      caller: BOB_QUERY,
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
      target: ALICE_QUERY,
      text: "do quietly",
      mode: "wait",
      caller: BOB_QUERY,
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
      target: ALICE_QUERY,
      text: "ff",
      mode: "fire-and-forget",
      caller: BOB_QUERY,
    });

    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      "session:cross_send",
      expect.objectContaining({ mode: "fire-and-forget" }),
    );

    // Wait
    await sender.send({
      target: ALICE_QUERY,
      text: "w",
      mode: "wait",
      caller: BOB_QUERY,
    });

    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      "session:cross_send",
      expect.objectContaining({ mode: "wait" }),
    );

    // Ping-pong
    await sender.send({
      target: ALICE_QUERY,
      text: "pp",
      mode: "ping-pong",
      maxTurns: 1,
      caller: BOB_QUERY,
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
      target: ALICE_QUERY,
      text: "accumulate",
      mode: "ping-pong",
      maxTurns: 3,
      caller: BOB_QUERY,
    });

    // 1 initial + 3 turns = 4 total executions
    expect(deps.executeInSession).toHaveBeenCalledTimes(4);
    expect(result.turnsCompleted).toBe(3);

    // Stats accumulated: 4 * 100 tokens, 4 * 0.01 cost
    expect(result.stats!.totalTokens).toBe(400);
    expect(result.stats!.totalCost).toBeCloseTo(0.04);
  });
});
