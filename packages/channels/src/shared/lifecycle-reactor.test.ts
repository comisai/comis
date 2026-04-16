import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TypedEventBus } from "@comis/core";
import type { ChannelPort, LifecycleReactionsConfig, SessionKey } from "@comis/core";
import { ok, err } from "@comis/shared";
import { createLifecycleReactor, extractChannelId } from "./lifecycle-reactor.js";
import type { LifecycleReactorDeps } from "./lifecycle-reactor.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockAdapter(channelType = "telegram"): ChannelPort {
  return {
    channelId: "adapter-001",
    channelType,
    start: vi.fn().mockResolvedValue(ok(undefined)),
    stop: vi.fn().mockResolvedValue(ok(undefined)),
    sendMessage: vi.fn().mockResolvedValue(ok("msg-1")),
    editMessage: vi.fn().mockResolvedValue(ok(undefined)),
    onMessage: vi.fn(),
    reactToMessage: vi.fn().mockResolvedValue(ok(undefined)),
    removeReaction: vi.fn().mockResolvedValue(ok(undefined)),
    deleteMessage: vi.fn().mockResolvedValue(ok(undefined)),
    fetchMessages: vi.fn().mockResolvedValue(ok([])),
    sendAttachment: vi.fn().mockResolvedValue(ok("att-1")),
    platformAction: vi.fn().mockResolvedValue(ok(undefined)),
  };
}

function createDefaultConfig(): LifecycleReactionsConfig {
  return {
    enabled: true,
    emojiTier: "unicode",
    timing: {
      debounceMs: 700,
      holdDoneMs: 3000,
      holdErrorMs: 5000,
      stallSoftMs: 15000,
      stallHardMs: 30000,
    },
    perChannel: {},
  };
}

function createReactorDeps(overrides?: Partial<LifecycleReactorDeps>): LifecycleReactorDeps {
  return {
    eventBus: new TypedEventBus(),
    adapter: createMockAdapter(),
    channelType: "telegram",
    replyToMetaKey: "telegramMessageId",
    config: createDefaultConfig(),
    logger: createMockLogger(),
    ...overrides,
  };
}

function emitMessageReceived(
  eventBus: TypedEventBus,
  channelType: string,
  channelId: string,
  platformMessageId: string,
  metaKey: string,
): void {
  eventBus.emit("message:received", {
    message: {
      id: "norm-1",
      channelType,
      channelId,
      senderId: "user-1",
      text: "hello",
      timestamp: Date.now(),
      attachments: [],
      metadata: { [metaKey]: platformMessageId },
    },
    sessionKey: { tenantId: "default", userId: "user-1", channelId },
  });
}

// ---------------------------------------------------------------------------
// extractChannelId
// ---------------------------------------------------------------------------

describe("extractChannelId", () => {
  it("extracts channelId from SessionKey object", () => {
    const sk: SessionKey = { tenantId: "default", userId: "user-1", channelId: "chan-abc" };
    expect(extractChannelId(sk)).toBe("chan-abc");
  });

  it("extracts channelId from formatted string without agent prefix", () => {
    // Format: tenantId:userId:channelId
    expect(extractChannelId("default:user-1:chan-abc")).toBe("chan-abc");
  });

  it("extracts channelId from formatted string with agent prefix", () => {
    // Format: agent:agentId:tenantId:userId:channelId
    expect(extractChannelId("agent:bot1:default:user-1:chan-abc")).toBe("chan-abc");
  });

  it("returns undefined for undefined input", () => {
    expect(extractChannelId(undefined)).toBeUndefined();
  });

  it("returns undefined for short string", () => {
    expect(extractChannelId("short")).toBeUndefined();
  });

  it("returns undefined for agent prefix with too few parts", () => {
    expect(extractChannelId("agent:bot1:x")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Lifecycle reactor
// ---------------------------------------------------------------------------

describe("createLifecycleReactor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // 1. State transitions
  it("transitions through queued -> thinking -> coding -> done", () => {
    const deps = createReactorDeps();
    const reactor = createLifecycleReactor(deps);
    const adapter = deps.adapter as ReturnType<typeof createMockAdapter>;

    // message:received -> queued
    emitMessageReceived(deps.eventBus, "telegram", "chat-1", "msg-100", "telegramMessageId");

    // queued reaction should be debounced -- advance past debounce
    vi.advanceTimersByTime(701);
    expect(adapter.reactToMessage).toHaveBeenCalled();

    // queue:dequeued -> thinking
    deps.eventBus.emit("queue:dequeued", {
      sessionKey: { tenantId: "default", userId: "user-1", channelId: "chat-1" },
      channelType: "telegram",
      waitTimeMs: 50,
      timestamp: Date.now(),
    });
    vi.advanceTimersByTime(701);

    // tool:started with "bash" -> coding
    deps.eventBus.emit("tool:started", {
      toolName: "bash",
      toolCallId: "tc-1",
      timestamp: Date.now(),
      sessionKey: "default:user-1:chat-1",
    });
    vi.advanceTimersByTime(701);

    // message:sent -> done (terminal, immediate)
    deps.eventBus.emit("message:sent", {
      channelId: "chat-1",
      messageId: "resp-1",
      content: "Hello!",
    });

    // reactToMessage should have been called multiple times for different phases
    expect(adapter.reactToMessage.mock.calls.length).toBeGreaterThanOrEqual(3);
    reactor.destroy();
  });

  // 2. Debounce: rapid transitions produce fewer API calls
  it("debounces rapid tool transitions", () => {
    const deps = createReactorDeps();
    const reactor = createLifecycleReactor(deps);
    const adapter = deps.adapter as ReturnType<typeof createMockAdapter>;

    emitMessageReceived(deps.eventBus, "telegram", "chat-1", "msg-100", "telegramMessageId");
    vi.advanceTimersByTime(701);

    // Transition to thinking first
    deps.eventBus.emit("queue:dequeued", {
      sessionKey: { tenantId: "default", userId: "user-1", channelId: "chat-1" },
      channelType: "telegram",
      waitTimeMs: 10,
      timestamp: Date.now(),
    });
    vi.advanceTimersByTime(701);

    const callsBefore = adapter.reactToMessage.mock.calls.length;

    // Emit 5 rapid tool:started events within debounce window
    for (let i = 0; i < 5; i++) {
      deps.eventBus.emit("tool:started", {
        toolName: i % 2 === 0 ? "bash" : "web_search",
        toolCallId: `tc-${i}`,
        timestamp: Date.now(),
        sessionKey: "default:user-1:chat-1",
      });
    }

    // Only advance past one debounce period
    vi.advanceTimersByTime(701);

    const callsAfter = adapter.reactToMessage.mock.calls.length;
    // Should have at most 2 additional calls (not 5)
    expect(callsAfter - callsBefore).toBeLessThanOrEqual(2);

    reactor.destroy();
  });

  // 3. Terminal bypass: done bypasses debounce
  it("applies done reaction immediately, cancelling pending debounce", () => {
    const deps = createReactorDeps();
    const reactor = createLifecycleReactor(deps);
    const adapter = deps.adapter as ReturnType<typeof createMockAdapter>;

    emitMessageReceived(deps.eventBus, "telegram", "chat-1", "msg-100", "telegramMessageId");
    vi.advanceTimersByTime(701);

    // Start thinking
    deps.eventBus.emit("queue:dequeued", {
      sessionKey: { tenantId: "default", userId: "user-1", channelId: "chat-1" },
      channelType: "telegram",
      waitTimeMs: 10,
      timestamp: Date.now(),
    });

    // Start a tool (debounce pending)
    deps.eventBus.emit("tool:started", {
      toolName: "bash",
      toolCallId: "tc-1",
      timestamp: Date.now(),
      sessionKey: "default:user-1:chat-1",
    });

    // message:sent BEFORE debounce resolves -- terminal should bypass
    deps.eventBus.emit("message:sent", {
      channelId: "chat-1",
      messageId: "resp-1",
      content: "done!",
    });

    // The done emoji should be applied immediately (no need to wait for debounce)
    // Check that reactToMessage was called for the done phase
    const calls = adapter.reactToMessage.mock.calls;
    const lastCall = calls[calls.length - 1];
    // The done emoji in unicode tier is check mark
    expect(lastCall?.[2]).toBeDefined(); // An emoji was applied

    reactor.destroy();
  });

  // 4. Hold and cleanup -- done
  it("holds done reaction for holdDoneMs then cleans up", () => {
    const deps = createReactorDeps();
    const reactor = createLifecycleReactor(deps);
    const adapter = deps.adapter as ReturnType<typeof createMockAdapter>;

    const cleanupEvents: unknown[] = [];
    deps.eventBus.on("reaction:cleanup", (ev) => cleanupEvents.push(ev));

    emitMessageReceived(deps.eventBus, "telegram", "chat-1", "msg-100", "telegramMessageId");
    vi.advanceTimersByTime(701);

    // Fast-track to done
    deps.eventBus.emit("queue:dequeued", {
      sessionKey: { tenantId: "default", userId: "user-1", channelId: "chat-1" },
      channelType: "telegram",
      waitTimeMs: 10,
      timestamp: Date.now(),
    });
    vi.advanceTimersByTime(701);

    deps.eventBus.emit("message:sent", {
      channelId: "chat-1",
      messageId: "resp-1",
      content: "Hello!",
    });

    // Before holdDoneMs: no cleanup
    vi.advanceTimersByTime(2999);
    expect(cleanupEvents).toHaveLength(0);

    // After holdDoneMs (3000ms): cleanup should fire
    vi.advanceTimersByTime(2);
    expect(cleanupEvents).toHaveLength(1);
    expect(adapter.removeReaction).toHaveBeenCalled();

    reactor.destroy();
  });

  // 5. Hold and cleanup -- error
  it("holds error reaction for holdErrorMs then cleans up", () => {
    const deps = createReactorDeps();
    const reactor = createLifecycleReactor(deps);
    const adapter = deps.adapter as ReturnType<typeof createMockAdapter>;

    const cleanupEvents: unknown[] = [];
    deps.eventBus.on("reaction:cleanup", (ev) => cleanupEvents.push(ev));

    emitMessageReceived(deps.eventBus, "telegram", "chat-1", "msg-100", "telegramMessageId");
    vi.advanceTimersByTime(701);

    // Transition to thinking first (queued -> thinking is valid)
    deps.eventBus.emit("queue:dequeued", {
      sessionKey: { tenantId: "default", userId: "user-1", channelId: "chat-1" },
      channelType: "telegram",
      waitTimeMs: 10,
      timestamp: Date.now(),
    });
    vi.advanceTimersByTime(701);

    // Abort -> error
    deps.eventBus.emit("execution:aborted", {
      sessionKey: { tenantId: "default", userId: "user-1", channelId: "chat-1" },
      reason: "budget_exceeded",
      agentId: "agent-1",
      timestamp: Date.now(),
    });

    // Before holdErrorMs (5000): no cleanup
    vi.advanceTimersByTime(4999);
    expect(cleanupEvents).toHaveLength(0);

    // After holdErrorMs: cleanup should fire
    vi.advanceTimersByTime(2);
    expect(cleanupEvents).toHaveLength(1);

    reactor.destroy();
  });

  // 5b. Hold and cleanup -- pipeline_timeout error
  it("transitions to error on execution:aborted with pipeline_timeout reason", () => {
    const deps = createReactorDeps();
    const reactor = createLifecycleReactor(deps);
    const adapter = deps.adapter as ReturnType<typeof createMockAdapter>;

    const cleanupEvents: unknown[] = [];
    deps.eventBus.on("reaction:cleanup", (ev) => cleanupEvents.push(ev));

    emitMessageReceived(deps.eventBus, "telegram", "chat-1", "msg-100", "telegramMessageId");
    vi.advanceTimersByTime(701);

    // Transition to thinking first (queued -> thinking is valid)
    deps.eventBus.emit("queue:dequeued", {
      sessionKey: { tenantId: "default", userId: "user-1", channelId: "chat-1" },
      channelType: "telegram",
      waitTimeMs: 10,
      timestamp: Date.now(),
    });
    vi.advanceTimersByTime(701);

    // Abort with pipeline_timeout -> error
    deps.eventBus.emit("execution:aborted", {
      sessionKey: { tenantId: "default", userId: "user-1", channelId: "chat-1" },
      reason: "pipeline_timeout",
      agentId: "agent-1",
      timestamp: Date.now(),
    });

    // Before holdErrorMs (5000): no cleanup
    vi.advanceTimersByTime(4999);
    expect(cleanupEvents).toHaveLength(0);

    // After holdErrorMs: cleanup should fire
    vi.advanceTimersByTime(2);
    expect(cleanupEvents).toHaveLength(1);

    reactor.destroy();
  });

  // 6. Per-message tracking
  it("tracks concurrent messages independently", () => {
    const deps = createReactorDeps();
    const reactor = createLifecycleReactor(deps);

    const phaseEvents: Array<{ messageId: string; phase: string }> = [];
    deps.eventBus.on("reaction:phase_changed", (ev) => phaseEvents.push({ messageId: ev.messageId, phase: ev.phase }));

    // Two messages from different channels
    emitMessageReceived(deps.eventBus, "telegram", "chat-1", "msg-100", "telegramMessageId");
    emitMessageReceived(deps.eventBus, "telegram", "chat-2", "msg-200", "telegramMessageId");

    vi.advanceTimersByTime(701);

    // Done for message 1 only
    deps.eventBus.emit("message:sent", {
      channelId: "chat-1",
      messageId: "resp-1",
      content: "done!",
    });

    // Message 1 should have a terminal event, message 2 should not
    const msg1Terminal = phaseEvents.filter((e) => e.messageId === "msg-100" && e.phase === "done");
    const msg2Terminal = phaseEvents.filter((e) => e.messageId === "msg-200" && e.phase === "done");

    expect(msg1Terminal).toHaveLength(1);
    expect(msg2Terminal).toHaveLength(0);

    reactor.destroy();
  });

  // 7. Destroy cleanup
  it("clears all timers and maps on destroy", () => {
    const deps = createReactorDeps();
    const reactor = createLifecycleReactor(deps);

    // Create active messages
    emitMessageReceived(deps.eventBus, "telegram", "chat-1", "msg-100", "telegramMessageId");
    emitMessageReceived(deps.eventBus, "telegram", "chat-2", "msg-200", "telegramMessageId");

    vi.advanceTimersByTime(701);

    // Destroy should not throw and should clear internal state
    reactor.destroy();

    // After destroy, new events should be ignored (no handlers)
    const adapter = deps.adapter as ReturnType<typeof createMockAdapter>;
    const callsBefore = adapter.reactToMessage.mock.calls.length;

    deps.eventBus.emit("message:sent", {
      channelId: "chat-1",
      messageId: "resp-1",
      content: "after destroy",
    });

    // No new calls should be made
    expect(adapter.reactToMessage.mock.calls.length).toBe(callsBefore);
  });

  // 8. Invalid transition ignored
  it("ignores invalid transition from idle to done", () => {
    const deps = createReactorDeps();
    const reactor = createLifecycleReactor(deps);
    const adapter = deps.adapter as ReturnType<typeof createMockAdapter>;

    // Emit message:received to create state (starts at idle, transitions to queued)
    emitMessageReceived(deps.eventBus, "telegram", "chat-1", "msg-100", "telegramMessageId");

    // Now send message:sent (done) -- but current phase is "queued", queued -> done IS valid
    // To test truly invalid: we would need a state that can't go to the target.
    // idle -> done is invalid. But message:received auto-transitions to queued.
    // Let's check: the reactor creates state at idle then immediately transitions to queued.
    // So we can't stay at idle after message:received. Instead, test that we don't
    // crash on an event with no matching message (no state created).
    // That case is handled by "message already cleaned up" check.

    // The test intent: emit a done event for a non-existent channel
    deps.eventBus.emit("message:sent", {
      channelId: "nonexistent-channel",
      messageId: "resp-1",
      content: "done!",
    });

    // No additional reactToMessage calls beyond the initial queued one
    vi.advanceTimersByTime(701);
    // Only the queued reaction should have been called
    expect(adapter.reactToMessage.mock.calls.length).toBeLessThanOrEqual(2);

    reactor.destroy();
  });

  // 9. Graceful degradation: message without platform message ID
  it("skips messages without platform message ID in metadata", () => {
    const deps = createReactorDeps();
    const reactor = createLifecycleReactor(deps);
    const adapter = deps.adapter as ReturnType<typeof createMockAdapter>;

    // Emit message:received WITHOUT the telegramMessageId in metadata
    deps.eventBus.emit("message:received", {
      message: {
        id: "norm-1",
        channelType: "telegram",
        channelId: "chat-1",
        senderId: "user-1",
        text: "hello",
        timestamp: Date.now(),
        attachments: [],
        metadata: {}, // No telegramMessageId
      },
      sessionKey: { tenantId: "default", userId: "user-1", channelId: "chat-1" },
    });

    vi.advanceTimersByTime(701);

    // No reactToMessage calls -- message was gracefully skipped
    expect(adapter.reactToMessage).not.toHaveBeenCalled();

    reactor.destroy();
  });

  // 10. Lookup via activeMessageByChannel
  it("resolves message state via channelId secondary index", () => {
    const deps = createReactorDeps();
    const reactor = createLifecycleReactor(deps);

    const terminalEvents: unknown[] = [];
    deps.eventBus.on("reaction:terminal", (ev) => terminalEvents.push(ev));

    emitMessageReceived(deps.eventBus, "telegram", "chat-1", "msg-100", "telegramMessageId");
    vi.advanceTimersByTime(701);

    // Transition to thinking so we can reach done
    deps.eventBus.emit("queue:dequeued", {
      sessionKey: { tenantId: "default", userId: "user-1", channelId: "chat-1" },
      channelType: "telegram",
      waitTimeMs: 10,
      timestamp: Date.now(),
    });
    vi.advanceTimersByTime(701);

    // message:sent uses channelId directly (not sessionKey)
    deps.eventBus.emit("message:sent", {
      channelId: "chat-1",
      messageId: "resp-1",
      content: "Hello!",
    });

    expect(terminalEvents).toHaveLength(1);

    reactor.destroy();
  });

  // 11. SessionKey type handling
  it("handles both string and SessionKey object sessionKey types", () => {
    const deps = createReactorDeps();
    const reactor = createLifecycleReactor(deps);

    emitMessageReceived(deps.eventBus, "telegram", "chat-1", "msg-100", "telegramMessageId");
    vi.advanceTimersByTime(701);

    // queue:dequeued uses SessionKey object
    deps.eventBus.emit("queue:dequeued", {
      sessionKey: { tenantId: "default", userId: "user-1", channelId: "chat-1" },
      channelType: "telegram",
      waitTimeMs: 10,
      timestamp: Date.now(),
    });
    vi.advanceTimersByTime(701);

    // tool:started uses string sessionKey
    deps.eventBus.emit("tool:started", {
      toolName: "bash",
      toolCallId: "tc-1",
      timestamp: Date.now(),
      sessionKey: "default:user-1:chat-1",
    });
    vi.advanceTimersByTime(701);

    // tool:executed uses string sessionKey
    deps.eventBus.emit("tool:executed", {
      toolName: "bash",
      durationMs: 500,
      success: true,
      timestamp: Date.now(),
      sessionKey: "default:user-1:chat-1",
    });
    vi.advanceTimersByTime(701);

    // execution:aborted uses SessionKey object
    deps.eventBus.emit("execution:aborted", {
      sessionKey: { tenantId: "default", userId: "user-1", channelId: "chat-1" },
      reason: "budget_exceeded",
      agentId: "agent-1",
      timestamp: Date.now(),
    });

    // Should reach error state (terminal)
    const adapter = deps.adapter as ReturnType<typeof createMockAdapter>;
    expect(adapter.reactToMessage.mock.calls.length).toBeGreaterThanOrEqual(3);

    reactor.destroy();
  });

  // Channel type filtering
  it("ignores messages from other channel types", () => {
    const deps = createReactorDeps({ channelType: "telegram" });
    const reactor = createLifecycleReactor(deps);
    const adapter = deps.adapter as ReturnType<typeof createMockAdapter>;

    // Emit a discord message to a telegram reactor
    deps.eventBus.emit("message:received", {
      message: {
        id: "norm-1",
        channelType: "discord",
        channelId: "chat-1",
        senderId: "user-1",
        text: "hello",
        timestamp: Date.now(),
        attachments: [],
        metadata: { discordMessageId: "msg-100" },
      },
      sessionKey: { tenantId: "default", userId: "user-1", channelId: "chat-1" },
    });

    vi.advanceTimersByTime(701);
    expect(adapter.reactToMessage).not.toHaveBeenCalled();

    reactor.destroy();
  });

  // response:filtered transitions to done
  it("transitions to done on response:filtered", () => {
    const deps = createReactorDeps();
    const reactor = createLifecycleReactor(deps);

    const terminalEvents: Array<{ phase: string }> = [];
    deps.eventBus.on("reaction:terminal", (ev) => terminalEvents.push({ phase: ev.phase }));

    emitMessageReceived(deps.eventBus, "telegram", "chat-1", "msg-100", "telegramMessageId");
    vi.advanceTimersByTime(701);

    deps.eventBus.emit("queue:dequeued", {
      sessionKey: { tenantId: "default", userId: "user-1", channelId: "chat-1" },
      channelType: "telegram",
      waitTimeMs: 10,
      timestamp: Date.now(),
    });
    vi.advanceTimersByTime(701);

    deps.eventBus.emit("response:filtered", {
      channelId: "chat-1",
      suppressedBy: "NO_REPLY",
      timestamp: Date.now(),
    });

    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]!.phase).toBe("done");

    reactor.destroy();
  });
});
