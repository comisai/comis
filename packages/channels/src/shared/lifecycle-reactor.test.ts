// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runWithContext, systemNowMs, TypedEventBus } from "@comis/core";
import type { ChannelPort, EventMap, LifecycleReactionsConfig, SessionKey } from "@comis/core";
import { ok, err } from "@comis/shared";
import { createLifecycleReactor, extractChannelId } from "./lifecycle-reactor.js";
import type { LifecycleReactorDeps } from "./lifecycle-reactor.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const DEFAULT_TRACE_ID = "550e8400-e29b-41d4-a716-446655440001";

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
    sendAttachment: vi.fn().mockResolvedValue(ok({ kind: "tracked", messageId: "att-1" })),
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
  options: { sourceMessageId?: string; traceId?: string } = {},
): void {
  const sourceMessageId = options.sourceMessageId ?? `source-${platformMessageId}`;
  const traceId = options.traceId ?? DEFAULT_TRACE_ID;
  eventBus.emit("message:received", {
    message: {
      id: sourceMessageId,
      channelType,
      channelId,
      senderId: "user-1",
      text: "hello",
      timestamp: Date.now(),
      attachments: [],
      metadata: {
        [metaKey]: platformMessageId,
        traceId,
      },
    },
    sessionKey: { tenantId: "default", userId: "user-1", channelId },
  });
}

function emitMessageTerminal(
  eventBus: TypedEventBus,
  channelType: string,
  channelId: string,
  sourceMessageId: string,
  outcome: EventMap["message:terminal"]["outcome"] = "success",
): void {
  eventBus.emit("message:terminal", {
    channelType,
    channelId,
    sourceMessageId,
    outcome,
    reason: "execution_completed",
    timestamp: Date.now(),
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

  it("extracts a colon-containing channelId without consuming tagged suffixes", () => {
    expect(extractChannelId("default:user-1:sub-agent:run-1:peer:user-2"))
      .toBe("sub-agent:run-1");
  });

  it("returns undefined for undefined input", () => {
    expect(extractChannelId(undefined)).toBeUndefined();
  });

  it("returns undefined for short string", () => {
    expect(extractChannelId("short")).toBeUndefined();
  });

  it("returns undefined when a tagged suffix starts before the channelId", () => {
    expect(extractChannelId("default:user-1:peer:user-2")).toBeUndefined();
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

  it("contains a synchronous terminal reaction throw so hold cleanup still runs", () => {
    const credential = `xoxb-${"a".repeat(32)}`;
    const adapter = createMockAdapter();
    adapter.reactToMessage = vi.fn(() => {
      throw new Error(`platform reaction threw synchronously ${credential}`);
    });
    const deps = createReactorDeps({ adapter });
    const terminalObserver = vi.fn();
    const cleanupObserver = vi.fn();
    deps.eventBus.on("reaction:terminal", terminalObserver);
    deps.eventBus.on("reaction:cleanup", cleanupObserver);
    const reactor = createLifecycleReactor(deps);

    emitMessageReceived(
      deps.eventBus,
      "telegram",
      "chat-sync-reaction",
      "platform-sync-reaction",
      "telegramMessageId",
      { sourceMessageId: "source-sync-reaction" },
    );

    expect(() => emitMessageTerminal(
      deps.eventBus,
      "telegram",
      "chat-sync-reaction",
      "source-sync-reaction",
    )).not.toThrow();
    expect(terminalObserver).toHaveBeenCalledOnce();

    expect(() => vi.advanceTimersByTime(3_001)).not.toThrow();
    expect(cleanupObserver).toHaveBeenCalledOnce();
    expect(JSON.stringify(deps.logger.warn.mock.calls)).not.toContain(credential);
    reactor.destroy();
  });

  it("contains a synchronous hold removal throw so state cleanup still runs", () => {
    const adapter = createMockAdapter();
    adapter.removeReaction = vi.fn(() => {
      throw new Error("platform removal threw synchronously");
    });
    const deps = createReactorDeps({ adapter });
    const cleanupObserver = vi.fn();
    deps.eventBus.on("reaction:cleanup", cleanupObserver);
    const reactor = createLifecycleReactor(deps);

    emitMessageReceived(
      deps.eventBus,
      "telegram",
      "chat-sync-removal",
      "platform-sync-removal",
      "telegramMessageId",
      { sourceMessageId: "source-sync-removal" },
    );
    emitMessageTerminal(
      deps.eventBus,
      "telegram",
      "chat-sync-removal",
      "source-sync-removal",
    );

    expect(() => vi.advanceTimersByTime(3_001)).not.toThrow();
    expect(cleanupObserver).toHaveBeenCalledOnce();
    reactor.destroy();
  });

  it("consumes the canonical terminal outcome for the exact source identity", () => {
    const deps = createReactorDeps();
    const reactor = createLifecycleReactor(deps);
    const terminals: Array<{ messageId: string; phase: string }> = [];
    deps.eventBus.on("reaction:terminal", (event) => {
      terminals.push({ messageId: event.messageId, phase: event.phase });
    });

    emitMessageReceived(
      deps.eventBus,
      "telegram",
      "chat:one",
      "platform-first",
      "telegramMessageId",
      { sourceMessageId: "source:first" },
    );
    emitMessageReceived(
      deps.eventBus,
      "telegram",
      "chat",
      "one:platform-first",
      "telegramMessageId",
      { sourceMessageId: "source:second" },
    );

    emitMessageTerminal(
      deps.eventBus,
      "telegram",
      "chat:one",
      "source:first",
      "filtered",
    );

    expect(terminals).toEqual([{ messageId: "platform-first", phase: "done" }]);
    reactor.destroy();
  });

  it("terminalizes the source message instead of the newest message in the same chat", () => {
    const deps = createReactorDeps();
    const reactor = createLifecycleReactor(deps);
    const terminalMessages: string[] = [];
    deps.eventBus.on("reaction:terminal", (event) => terminalMessages.push(event.messageId));

    emitMessageReceived(
      deps.eventBus,
      "telegram",
      "chat-1",
      "platform-first",
      "telegramMessageId",
      { sourceMessageId: "source-first", traceId: "550e8400-e29b-41d4-a716-446655440101" },
    );
    emitMessageReceived(
      deps.eventBus,
      "telegram",
      "chat-1",
      "platform-second",
      "telegramMessageId",
      { sourceMessageId: "source-second", traceId: "550e8400-e29b-41d4-a716-446655440102" },
    );

    emitMessageTerminal(deps.eventBus, "telegram", "chat-1", "source-first");

    expect(terminalMessages).toEqual(["platform-first"]);
    reactor.destroy();
  });

  it("treats repeated reception of one platform message as one reactor lifecycle", () => {
    const deps = createReactorDeps();
    const reactor = createLifecycleReactor(deps);
    const phases: Array<{ messageId: string; phase: string }> = [];
    deps.eventBus.on("reaction:phase_changed", (event) => {
      phases.push({ messageId: event.messageId, phase: event.phase });
    });

    emitMessageReceived(
      deps.eventBus,
      "telegram",
      "chat-1",
      "same-platform-message",
      "telegramMessageId",
      { sourceMessageId: "source-first", traceId: "550e8400-e29b-41d4-a716-446655440141" },
    );
    emitMessageReceived(
      deps.eventBus,
      "telegram",
      "chat-1",
      "same-platform-message",
      "telegramMessageId",
      { sourceMessageId: "source-second", traceId: "550e8400-e29b-41d4-a716-446655440142" },
    );

    expect(phases.filter((event) => event.phase === "queued")).toEqual([
      { messageId: "same-platform-message", phase: "queued" },
    ]);
    emitMessageTerminal(deps.eventBus, "telegram", "chat-1", "source-first");
    emitMessageTerminal(deps.eventBus, "telegram", "chat-1", "source-second");
    expect(phases.filter((event) => event.phase === "done")).toHaveLength(1);
    reactor.destroy();
  });

  it("keeps the first platform lifecycle for a repeated source identity", () => {
    const deps = createReactorDeps();
    const reactor = createLifecycleReactor(deps);
    const phases: Array<{ messageId: string; phase: string }> = [];
    deps.eventBus.on("reaction:phase_changed", (event) => {
      phases.push({ messageId: event.messageId, phase: event.phase });
    });

    emitMessageReceived(
      deps.eventBus,
      "telegram",
      "chat-1",
      "platform-first",
      "telegramMessageId",
      {
        sourceMessageId: "source-shared",
        traceId: "550e8400-e29b-41d4-a716-446655440144",
      },
    );
    emitMessageReceived(
      deps.eventBus,
      "telegram",
      "chat-1",
      "platform-conflict",
      "telegramMessageId",
      {
        sourceMessageId: "source-shared",
        traceId: "550e8400-e29b-41d4-a716-446655440145",
      },
    );
    emitMessageTerminal(deps.eventBus, "telegram", "chat-1", "source-shared");

    expect(phases).toEqual([
      { messageId: "platform-first", phase: "queued" },
      { messageId: "platform-first", phase: "done" },
    ]);
    reactor.destroy();
  });

  it("restarts a platform lifecycle received during the prior terminal hold", () => {
    const deps = createReactorDeps();
    const reactor = createLifecycleReactor(deps);
    const phases: string[] = [];
    deps.eventBus.on("reaction:phase_changed", (event) => {
      if (event.messageId === "reused-platform-message") phases.push(event.phase);
    });

    emitMessageReceived(
      deps.eventBus,
      "telegram",
      "chat-1",
      "reused-platform-message",
      "telegramMessageId",
      { sourceMessageId: "source-first" },
    );
    emitMessageTerminal(deps.eventBus, "telegram", "chat-1", "source-first");

    vi.advanceTimersByTime(1_000);
    emitMessageReceived(
      deps.eventBus,
      "telegram",
      "chat-1",
      "reused-platform-message",
      "telegramMessageId",
      {
        sourceMessageId: "source-second",
        traceId: "550e8400-e29b-41d4-a716-446655440143",
      },
    );

    expect(phases).toEqual(["queued", "done", "queued"]);
    expect(deps.adapter.removeReaction).toHaveBeenCalledTimes(1);

    // Cross the first lifecycle's original hold deadline. Its cancelled timer
    // must not delete the replacement state or consume the second terminal.
    vi.advanceTimersByTime(2_001);
    expect(deps.adapter.removeReaction).toHaveBeenCalledTimes(1);
    emitMessageTerminal(deps.eventBus, "telegram", "chat-1", "source-second");

    expect(phases).toEqual(["queued", "done", "queued", "done"]);
    expect(deps.adapter.removeReaction).toHaveBeenCalledTimes(2);
    reactor.destroy();
  });

  it("contains reaction observers so terminal hold cleanup still runs", async () => {
    const deps = createReactorDeps();
    const laterObserver = vi.fn();
    deps.eventBus.on("reaction:terminal", () => {
      throw new Error("sync reaction observer failed");
    });
    deps.eventBus.on("reaction:terminal", async () => {
      await Promise.resolve();
      throw new Error("async reaction observer failed");
    });
    deps.eventBus.on("reaction:terminal", laterObserver);
    const reactor = createLifecycleReactor(deps);

    emitMessageReceived(
      deps.eventBus,
      "telegram",
      "chat-1",
      "platform-safe-observers",
      "telegramMessageId",
      { sourceMessageId: "source-safe-observers" },
    );
    emitMessageTerminal(
      deps.eventBus,
      "telegram",
      "chat-1",
      "source-safe-observers",
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(laterObserver).toHaveBeenCalledOnce();
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "reaction:terminal",
        subscriberFailurePhase: "sync",
        firstListenerIndex: 0,
      }),
      "Observational event subscriber failed",
    );
    expect(JSON.stringify(deps.logger.warn.mock.calls)).not.toContain(
      "sync reaction observer failed",
    );
    vi.advanceTimersByTime(3_001);
    expect(deps.adapter.removeReaction).toHaveBeenCalled();
    reactor.destroy();
  });

  it("contains phase and stall observers while lifecycle timers continue", () => {
    const deps = createReactorDeps({
      config: {
        ...createDefaultConfig(),
        timing: {
          ...createDefaultConfig().timing,
          stallSoftMs: 100,
          stallHardMs: 200,
        },
      },
    });
    const laterPhaseObserver = vi.fn();
    const laterStallObserver = vi.fn();
    deps.eventBus.on("reaction:phase_changed", () => {
      throw new Error("phase observer failed");
    });
    deps.eventBus.on("reaction:phase_changed", laterPhaseObserver);
    deps.eventBus.on("reaction:stall_detected", () => {
      throw new Error("stall observer failed");
    });
    deps.eventBus.on("reaction:stall_detected", laterStallObserver);
    const reactor = createLifecycleReactor(deps);

    emitMessageReceived(
      deps.eventBus,
      "telegram",
      "chat-1",
      "platform-stall-observers",
      "telegramMessageId",
      { sourceMessageId: "source-stall-observers" },
    );
    expect(laterPhaseObserver).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "queued" }),
    );

    vi.advanceTimersByTime(101);

    expect(laterStallObserver).toHaveBeenCalledWith(
      expect.objectContaining({ severity: "soft" }),
    );
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "reaction:stall_detected",
        subscriberFailurePhase: "sync",
        firstListenerIndex: 0,
      }),
      "Observational event subscriber failed",
    );
    emitMessageTerminal(
      deps.eventBus,
      "telegram",
      "chat-1",
      "source-stall-observers",
    );
    expect(laterPhaseObserver).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "done" }),
    );
    reactor.destroy();
  });

  it("fails closed when a terminal event names an unknown source identity", () => {
    const deps = createReactorDeps();
    const reactor = createLifecycleReactor(deps);
    const terminalMessages: string[] = [];
    deps.eventBus.on("reaction:terminal", (event) => terminalMessages.push(event.messageId));

    emitMessageReceived(deps.eventBus, "telegram", "chat-1", "platform-first", "telegramMessageId");
    emitMessageTerminal(deps.eventBus, "telegram", "chat-1", "unknown-source");

    expect(terminalMessages).toEqual([]);
    reactor.destroy();
  });

  it("keeps tuple-shaped message identities distinct when ids contain colons", () => {
    const deps = createReactorDeps();
    const reactor = createLifecycleReactor(deps);
    const terminalMessages: string[] = [];
    deps.eventBus.on("reaction:terminal", (event) => terminalMessages.push(event.messageId));

    emitMessageReceived(deps.eventBus, "telegram", "chat:a", "message", "telegramMessageId", {
      sourceMessageId: "source-a",
    });
    emitMessageReceived(deps.eventBus, "telegram", "chat", "a:message", "telegramMessageId", {
      sourceMessageId: "source-b",
    });
    emitMessageTerminal(deps.eventBus, "telegram", "chat:a", "source-a");

    expect(terminalMessages).toEqual(["message"]);
    reactor.destroy();
  });

  it("routes tool phases by trace instead of the newest message in a chat", () => {
    const deps = createReactorDeps();
    const reactor = createLifecycleReactor(deps);
    const phaseEvents: Array<{ messageId: string; phase: string }> = [];
    deps.eventBus.on("reaction:phase_changed", (event) => {
      phaseEvents.push({ messageId: event.messageId, phase: event.phase });
    });

    emitMessageReceived(deps.eventBus, "telegram", "chat-1", "platform-first", "telegramMessageId", {
      sourceMessageId: "source-first",
      traceId: "550e8400-e29b-41d4-a716-446655440111",
    });
    emitMessageReceived(deps.eventBus, "telegram", "chat-1", "platform-second", "telegramMessageId", {
      sourceMessageId: "source-second",
      traceId: "550e8400-e29b-41d4-a716-446655440112",
    });
    runWithContext({
      traceId: "550e8400-e29b-41d4-a716-446655440111",
      startedAt: systemNowMs(),
      channelType: "telegram",
    }, () => deps.eventBus.emit("queue:dequeued", {
      sessionKey: { tenantId: "default", userId: "user-1", channelId: "chat-1" },
      channelType: "telegram",
      waitTimeMs: 1,
      timestamp: Date.now(),
    }));
    phaseEvents.length = 0;

    deps.eventBus.emit("tool:started", {
      toolName: "bash",
      toolCallId: "tool-first",
      sessionKey: "default:user-1:chat-1",
      traceId: "550e8400-e29b-41d4-a716-446655440111",
      timestamp: Date.now(),
    });

    expect(phaseEvents).toEqual([
      { messageId: "platform-first", phase: "coding" },
    ]);
    reactor.destroy();
  });

  it("does not apply another channel type's tool or terminal events for the same local chat id", () => {
    const eventBus = new TypedEventBus();
    const telegramReactor = createLifecycleReactor(createReactorDeps({
      eventBus,
      adapter: createMockAdapter("telegram"),
      channelType: "telegram",
      replyToMetaKey: "platformMessageId",
    }));
    const slackReactor = createLifecycleReactor(createReactorDeps({
      eventBus,
      adapter: createMockAdapter("slack"),
      channelType: "slack",
      replyToMetaKey: "platformMessageId",
    }));
    const phases: Array<{ channelType: string; messageId: string; phase: string }> = [];
    eventBus.on("reaction:phase_changed", (event) => phases.push(event));

    try {
      emitMessageReceived(eventBus, "telegram", "shared-chat", "telegram-message", "platformMessageId", {
        sourceMessageId: "telegram-source",
        traceId: "550e8400-e29b-41d4-a716-446655440121",
      });
      emitMessageReceived(eventBus, "slack", "shared-chat", "slack-message", "platformMessageId", {
        sourceMessageId: "slack-source",
        traceId: "550e8400-e29b-41d4-a716-446655440122",
      });
      runWithContext({
        traceId: "550e8400-e29b-41d4-a716-446655440121",
        startedAt: systemNowMs(),
        channelType: "telegram",
      }, () => eventBus.emit("queue:dequeued", {
        sessionKey: { tenantId: "default", userId: "user-1", channelId: "shared-chat" },
        channelType: "telegram",
        waitTimeMs: 1,
        timestamp: Date.now(),
      }));
      phases.length = 0;

      eventBus.emit("tool:started", {
        toolName: "bash",
        toolCallId: "telegram-tool",
        sessionKey: "default:user-1:shared-chat",
        traceId: "550e8400-e29b-41d4-a716-446655440121",
        timestamp: Date.now(),
      });
      emitMessageTerminal(
        eventBus,
        "telegram",
        "shared-chat",
        "telegram-source",
        "error",
      );

      expect(phases).toEqual([
        expect.objectContaining({ channelType: "telegram", messageId: "telegram-message", phase: "coding" }),
        expect.objectContaining({ channelType: "telegram", messageId: "telegram-message", phase: "error" }),
      ]);
    } finally {
      telegramReactor.destroy();
      slackReactor.destroy();
    }
  });

  it("applies an aborted terminal to its running source instead of the stop message", () => {
    const deps = createReactorDeps();
    const reactor = createLifecycleReactor(deps);
    const terminalMessages: string[] = [];
    const runningTraceId = "550e8400-e29b-41d4-a716-446655440131";
    const stopTraceId = "550e8400-e29b-41d4-a716-446655440132";
    deps.eventBus.on("reaction:terminal", (event) => terminalMessages.push(event.messageId));

    emitMessageReceived(deps.eventBus, "telegram", "chat-1", "running-message", "telegramMessageId", {
      sourceMessageId: "running-source",
      traceId: runningTraceId,
    });
    runWithContext({
      traceId: runningTraceId,
      startedAt: systemNowMs(),
      channelType: "telegram",
    }, () => deps.eventBus.emit("queue:dequeued", {
      sessionKey: { tenantId: "default", userId: "user-1", channelId: "chat-1" },
      channelType: "telegram",
      waitTimeMs: 1,
      timestamp: Date.now(),
    }));
    emitMessageReceived(deps.eventBus, "telegram", "chat-1", "stop-message", "telegramMessageId", {
      sourceMessageId: "stop-source",
      traceId: stopTraceId,
    });

    emitMessageTerminal(
      deps.eventBus,
      "telegram",
      "chat-1",
      "running-source",
      "aborted",
    );

    expect(terminalMessages).toEqual(["running-message"]);
    reactor.destroy();
  });

  it("terminalizes the exact filtered source message in a busy chat", () => {
    const deps = createReactorDeps();
    const reactor = createLifecycleReactor(deps);
    const terminalMessages: string[] = [];
    deps.eventBus.on("reaction:terminal", (event) => terminalMessages.push(event.messageId));

    emitMessageReceived(deps.eventBus, "telegram", "chat-1", "platform-first", "telegramMessageId", {
      sourceMessageId: "source-first",
    });
    emitMessageReceived(deps.eventBus, "telegram", "chat-1", "platform-second", "telegramMessageId", {
      sourceMessageId: "source-second",
    });
    emitMessageTerminal(
      deps.eventBus,
      "telegram",
      "chat-1",
      "source-first",
      "filtered",
    );

    expect(terminalMessages).toEqual(["platform-first"]);
    reactor.destroy();
  });

  it("finishes only the lifecycle reactor matching the terminal channel type", () => {
    const eventBus = new TypedEventBus();
    const telegramDeps = createReactorDeps({
      eventBus,
      adapter: createMockAdapter("telegram"),
      channelType: "telegram",
      replyToMetaKey: "platformMessageId",
    });
    const slackDeps = createReactorDeps({
      eventBus,
      adapter: createMockAdapter("slack"),
      channelType: "slack",
      replyToMetaKey: "platformMessageId",
    });
    const telegramReactor = createLifecycleReactor(telegramDeps);
    const slackReactor = createLifecycleReactor(slackDeps);
    try {
      const terminalEvents: Array<{ channelType: string; channelId: string }> = [];
      eventBus.on("reaction:terminal", (event) => terminalEvents.push(event));

      emitMessageReceived(eventBus, "telegram", "shared", "telegram-message", "platformMessageId");
      emitMessageReceived(eventBus, "slack", "shared", "slack-message", "platformMessageId");

      emitMessageTerminal(
        eventBus,
        "telegram",
        "shared",
        "source-telegram-message",
      );

      expect(terminalEvents).toEqual([
        expect.objectContaining({ channelType: "telegram", channelId: "shared" }),
      ]);
    } finally {
      telegramReactor.destroy();
      slackReactor.destroy();
    }
  });

  it("dequeues only the lifecycle reactor matching the queue channel type", () => {
    const eventBus = new TypedEventBus();
    const telegramReactor = createLifecycleReactor(createReactorDeps({
      eventBus,
      adapter: createMockAdapter("telegram"),
      channelType: "telegram",
      replyToMetaKey: "platformMessageId",
    }));
    const slackReactor = createLifecycleReactor(createReactorDeps({
      eventBus,
      adapter: createMockAdapter("slack"),
      channelType: "slack",
      replyToMetaKey: "platformMessageId",
    }));
    try {
      const phaseEvents: Array<{ channelType: string; phase: string }> = [];
      eventBus.on("reaction:phase_changed", (event) => phaseEvents.push(event));

      emitMessageReceived(eventBus, "telegram", "shared", "telegram-message", "platformMessageId");
      emitMessageReceived(eventBus, "slack", "shared", "slack-message", "platformMessageId");
      phaseEvents.length = 0;

      eventBus.emit("queue:dequeued", {
        sessionKey: { tenantId: "default", userId: "user-1", channelId: "shared" },
        channelType: "telegram",
        waitTimeMs: 10,
        timestamp: Date.now(),
      });

      expect(phaseEvents).toEqual([
        expect.objectContaining({ channelType: "telegram", phase: "thinking" }),
      ]);
    } finally {
      telegramReactor.destroy();
      slackReactor.destroy();
    }
  });

  it("finishes only the lifecycle reactor matching a filtered terminal channel type", () => {
    const eventBus = new TypedEventBus();
    const telegramReactor = createLifecycleReactor(createReactorDeps({
      eventBus,
      adapter: createMockAdapter("telegram"),
      channelType: "telegram",
      replyToMetaKey: "platformMessageId",
    }));
    const slackReactor = createLifecycleReactor(createReactorDeps({
      eventBus,
      adapter: createMockAdapter("slack"),
      channelType: "slack",
      replyToMetaKey: "platformMessageId",
    }));
    try {
      const terminalEvents: Array<{ channelType: string; channelId: string }> = [];
      eventBus.on("reaction:terminal", (event) => terminalEvents.push(event));

      emitMessageReceived(eventBus, "telegram", "shared", "telegram-message", "platformMessageId");
      emitMessageReceived(eventBus, "slack", "shared", "slack-message", "platformMessageId");

      emitMessageTerminal(
        eventBus,
        "telegram",
        "shared",
        "source-telegram-message",
        "filtered",
      );

      expect(terminalEvents).toEqual([
        expect.objectContaining({ channelType: "telegram", channelId: "shared" }),
      ]);
    } finally {
      telegramReactor.destroy();
      slackReactor.destroy();
    }
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
      traceId: DEFAULT_TRACE_ID,
    });
    vi.advanceTimersByTime(701);

    // Canonical terminal -> done (immediate)
    emitMessageTerminal(deps.eventBus, "telegram", "chat-1", "source-msg-100");

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
        traceId: DEFAULT_TRACE_ID,
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
      traceId: DEFAULT_TRACE_ID,
    });

    // Terminal outcome BEFORE debounce resolves -- terminal should bypass
    emitMessageTerminal(deps.eventBus, "telegram", "chat-1", "source-msg-100");

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

    emitMessageTerminal(deps.eventBus, "telegram", "chat-1", "source-msg-100");

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

    emitMessageTerminal(
      deps.eventBus,
      "telegram",
      "chat-1",
      "source-msg-100",
      "error",
    );

    // Before holdErrorMs (5000): no cleanup
    vi.advanceTimersByTime(4999);
    expect(cleanupEvents).toHaveLength(0);

    // After holdErrorMs: cleanup should fire
    vi.advanceTimersByTime(2);
    expect(cleanupEvents).toHaveLength(1);

    reactor.destroy();
  });

  // 5b. Hold and cleanup -- pipeline_timeout error
  it("transitions to error on a timeout terminal outcome", () => {
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

    emitMessageTerminal(
      deps.eventBus,
      "telegram",
      "chat-1",
      "source-msg-100",
      "timeout",
    );

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
    emitMessageTerminal(deps.eventBus, "telegram", "chat-1", "source-msg-100");

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

    emitMessageTerminal(deps.eventBus, "telegram", "chat-1", "source-msg-100");

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

    // A true idle -> done transition cannot be constructed through events:
    // message:received creates state at idle and immediately transitions it to
    // queued (and queued -> done IS valid). What CAN be exercised is the
    // no-matching-state path: a done event for a channel with no reactor state
    // must be ignored without crashing (the "message already cleaned up" check).

    // Emit a done event for a non-existent channel
    emitMessageTerminal(
      deps.eventBus,
      "telegram",
      "nonexistent-channel",
      "source-msg-100",
    );

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

  // 10. Lookup via normalized inbound source identity
  it("resolves terminal message state via normalized source identity", () => {
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

    // Canonical terminal identity uses channelId directly (not sessionKey).
    emitMessageTerminal(deps.eventBus, "telegram", "chat-1", "source-msg-100");

    expect(terminalEvents).toHaveLength(1);

    reactor.destroy();
  });

  // 11. SessionKey type handling
  it("handles object queue keys and string tool keys before a terminal outcome", () => {
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
      traceId: DEFAULT_TRACE_ID,
    });
    vi.advanceTimersByTime(701);

    // tool:executed uses string sessionKey
    deps.eventBus.emit("tool:executed", {
      toolName: "bash",
      toolCallId: "tc-1",
      durationMs: 500,
      success: true,
      timestamp: Date.now(),
      sessionKey: "default:user-1:chat-1",
      traceId: DEFAULT_TRACE_ID,
    });
    vi.advanceTimersByTime(701);

    emitMessageTerminal(
      deps.eventBus,
      "telegram",
      "chat-1",
      "source-msg-100",
      "error",
    );

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

  it("maps a filtered terminal outcome to done", () => {
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

    emitMessageTerminal(
      deps.eventBus,
      "telegram",
      "chat-1",
      "source-msg-100",
      "filtered",
    );

    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]!.phase).toBe("done");

    reactor.destroy();
  });
});
