// SPDX-License-Identifier: Apache-2.0
/**
 * Branch-gap tests for setupInboundExecution (inbound-setup.ts).
 *
 * Targets uncovered branches: ack reaction dispatch (success/failure/error),
 * channelType-specific typingMode override (irc/echo), group-vs-DM typing
 * gating, heartbeat suppression, instant mode start, refreshMs platform
 * default fallback.
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import type {
  ChannelPort,
  NormalizedMessage,
  SessionKey,
} from "@comis/core";
import { ok, err } from "@comis/shared";

import { setupInboundExecution } from "./inbound-setup.js";
import type { SetupDeps } from "./inbound-setup.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdapter(channelType = "telegram"): ChannelPort {
  return {
    channelId: "adapter-1",
    channelType,
    start: vi.fn(async () => ok(undefined)),
    stop: vi.fn(async () => ok(undefined)),
    sendMessage: vi.fn(async () => ok("msg-r1")),
    editMessage: vi.fn(async () => ok(undefined)),
    onMessage: vi.fn(),
    reactToMessage: vi.fn(async () => ok(undefined)),
    removeReaction: vi.fn(async () => ok(undefined)),
    deleteMessage: vi.fn(async () => ok(undefined)),
    fetchMessages: vi.fn(async () => ok([])),
    sendAttachment: vi.fn(async () => ok("att-1")),
    platformAction: vi.fn(async () => ok(undefined)),
  };
}

function makeMsg(overrides?: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    id: "msg-1",
    channelId: "chat-1",
    channelType: "telegram",
    senderId: "user-1",
    text: "hello",
    timestamp: Date.now(),
    attachments: [],
    metadata: { telegramMessageId: 42, telegramChatType: "private" },
    ...overrides,
  };
}

function makeSessionKey(): SessionKey {
  return {
    tenantId: "default",
    userId: "user-1",
    channelId: "chat-1",
  };
}

function makeDeps(overrides?: Partial<SetupDeps>): SetupDeps {
  const eventBus = {
    emit: vi.fn(() => true),
    on: vi.fn().mockReturnThis(),
    off: vi.fn().mockReturnThis(),
    once: vi.fn().mockReturnThis(),
    removeAllListeners: vi.fn().mockReturnThis(),
    listenerCount: vi.fn(() => 0),
    setMaxListeners: vi.fn().mockReturnThis(),
  };
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    eventBus: eventBus as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger: logger as any,
    ...overrides,
  } as SetupDeps;
}

// ---------------------------------------------------------------------------
// Ack reaction dispatch
// ---------------------------------------------------------------------------

describe("setupInboundExecution ack reaction dispatch", () => {
  it("invokes adapter.reactToMessage when ackReactionConfig enabled and channel supports reactions", async () => {
    const channelRegistry = {
      getCapabilities: vi.fn(() => ({
        features: { reactions: true },
        replyToMetaKey: "telegramMessageId",
      })),
      getChannelPlugins: vi.fn(() => []),
      register: vi.fn(),
      getByType: vi.fn(),
      getAllAdapters: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const deps = makeDeps({
      ackReactionConfig: { enabled: true, emoji: "👀" },
      channelRegistry,
    });
    const adapter = makeAdapter();
    setupInboundExecution(deps, adapter, makeMsg(), makeMsg(), makeSessionKey());

    expect(adapter.reactToMessage).toHaveBeenCalledWith(
      "chat-1",
      "42",
      "👀",
    );
  });

  it("skips ack reaction when ackReactionConfig.enabled is false", async () => {
    const channelRegistry = {
      getCapabilities: vi.fn(() => ({
        features: { reactions: true },
        replyToMetaKey: "telegramMessageId",
      })),
      getChannelPlugins: vi.fn(() => []),
      register: vi.fn(),
      getByType: vi.fn(),
      getAllAdapters: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const deps = makeDeps({
      ackReactionConfig: { enabled: false, emoji: "👀" },
      channelRegistry,
    });
    const adapter = makeAdapter();
    setupInboundExecution(deps, adapter, makeMsg(), makeMsg(), makeSessionKey());

    expect(adapter.reactToMessage).not.toHaveBeenCalled();
  });

  it("skips ack reaction when lifecycleReactionsEnabled is true (lifecycle reactor handles it)", async () => {
    const channelRegistry = {
      getCapabilities: vi.fn(() => ({
        features: { reactions: true },
        replyToMetaKey: "telegramMessageId",
      })),
      getChannelPlugins: vi.fn(() => []),
      register: vi.fn(),
      getByType: vi.fn(),
      getAllAdapters: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const deps = makeDeps({
      ackReactionConfig: { enabled: true, emoji: "👀" },
      lifecycleReactionsEnabled: true,
      channelRegistry,
    });
    const adapter = makeAdapter();
    setupInboundExecution(deps, adapter, makeMsg(), makeMsg(), makeSessionKey());

    expect(adapter.reactToMessage).not.toHaveBeenCalled();
  });

  it("skips ack reaction when channel does not support reactions", async () => {
    const channelRegistry = {
      getCapabilities: vi.fn(() => ({
        features: { reactions: false },
        replyToMetaKey: "telegramMessageId",
      })),
      getChannelPlugins: vi.fn(() => []),
      register: vi.fn(),
      getByType: vi.fn(),
      getAllAdapters: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const deps = makeDeps({
      ackReactionConfig: { enabled: true, emoji: "👀" },
      channelRegistry,
    });
    const adapter = makeAdapter();
    setupInboundExecution(deps, adapter, makeMsg(), makeMsg(), makeSessionKey());

    expect(adapter.reactToMessage).not.toHaveBeenCalled();
  });

  it("skips ack reaction when platform message ID is missing from metadata", async () => {
    const channelRegistry = {
      getCapabilities: vi.fn(() => ({
        features: { reactions: true },
        replyToMetaKey: "telegramMessageId",
      })),
      getChannelPlugins: vi.fn(() => []),
      register: vi.fn(),
      getByType: vi.fn(),
      getAllAdapters: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const deps = makeDeps({
      ackReactionConfig: { enabled: true, emoji: "👀" },
      channelRegistry,
    });
    const adapter = makeAdapter();
    // metadata.telegramMessageId is missing
    setupInboundExecution(
      deps,
      adapter,
      makeMsg({ metadata: {} }),
      makeMsg(),
      makeSessionKey(),
    );

    expect(adapter.reactToMessage).not.toHaveBeenCalled();
  });

  it("logs warning when ack reaction returns err result", async () => {
    const channelRegistry = {
      getCapabilities: vi.fn(() => ({
        features: { reactions: true },
        replyToMetaKey: "telegramMessageId",
      })),
      getChannelPlugins: vi.fn(() => []),
      register: vi.fn(),
      getByType: vi.fn(),
      getAllAdapters: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      child: vi.fn().mockReturnThis(),
    };
    const deps = makeDeps({
      ackReactionConfig: { enabled: true, emoji: "👀" },
      channelRegistry,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger: logger as any,
    });
    const adapter = makeAdapter();
    (adapter.reactToMessage as ReturnType<typeof vi.fn>).mockResolvedValue(
      err(new Error("reaction-failed")),
    );

    setupInboundExecution(deps, adapter, makeMsg(), makeMsg(), makeSessionKey());

    // Allow the fire-and-forget promise to resolve
    await new Promise((r) => setTimeout(r, 10));

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: expect.stringContaining("reactions"),
      }),
      "Ack reaction failed",
    );
  });
});

// ---------------------------------------------------------------------------
// Typing controller branches
// ---------------------------------------------------------------------------

describe("setupInboundExecution typing controller", () => {
  it("forces typingMode 'never' on IRC channel even when streamingConfig default is thinking", async () => {
    // Pass no streamingConfig — resolveStreamingConfig falls back to typingMode: "thinking" default
    const deps = makeDeps();
    const adapter = makeAdapter("irc");
    const result = setupInboundExecution(
      deps,
      adapter,
      makeMsg({ channelType: "irc" }),
      makeMsg({ channelType: "irc" }),
      makeSessionKey(),
    );

    expect(result.typingLifecycle).toBeUndefined();
  });

  it("forces typingMode 'never' on Echo channel even when streamingConfig default is thinking", async () => {
    const deps = makeDeps();
    const adapter = makeAdapter("echo");
    const result = setupInboundExecution(
      deps,
      adapter,
      makeMsg({ channelType: "echo" }),
      makeMsg({ channelType: "echo" }),
      makeSessionKey(),
    );

    expect(result.typingLifecycle).toBeUndefined();
  });

  it("suppresses typing controller on heartbeat-originated messages", async () => {
    const deps = makeDeps({});
    const adapter = makeAdapter("telegram");
    const result = setupInboundExecution(
      deps,
      adapter,
      makeMsg({ metadata: { isHeartbeat: true } }),
      makeMsg({ metadata: { isHeartbeat: true } }),
      makeSessionKey(),
    );

    expect(result.typingLifecycle).toBeUndefined();
  });

  it("starts typing immediately when typingMode is 'instant'", async () => {
    const eventBus = {
      emit: vi.fn(() => true),
      on: vi.fn().mockReturnThis(),
      off: vi.fn().mockReturnThis(),
      once: vi.fn().mockReturnThis(),
      removeAllListeners: vi.fn().mockReturnThis(),
      listenerCount: vi.fn(() => 0),
      setMaxListeners: vi.fn().mockReturnThis(),
    };
    const deps = makeDeps({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      eventBus: eventBus as any,
      streamingConfig: {
        defaultMode: "instant",
        perChannel: {
          telegram: {
            typingMode: "instant",
            typingRefreshMs: 4000,
            typingCircuitBreakerThreshold: 3,
            typingTtlMs: 30000,
          },
        },
      } as never,
    });
    const adapter = makeAdapter("telegram");
    const result = setupInboundExecution(
      deps,
      adapter,
      makeMsg(),
      makeMsg(),
      makeSessionKey(),
    );

    expect(result.typingLifecycle).toBeDefined();
    expect(eventBus.emit).toHaveBeenCalledWith(
      "typing:started",
      expect.objectContaining({ mode: "instant" }),
    );
  });

  it("suppresses typing in group chat when bot is not mentioned", async () => {
    const deps = makeDeps({});
    const adapter = makeAdapter("telegram");
    const result = setupInboundExecution(
      deps,
      adapter,
      makeMsg({ metadata: { telegramChatType: "group", isBotMentioned: false } }),
      makeMsg({ metadata: { telegramChatType: "group", isBotMentioned: false } }),
      makeSessionKey(),
    );

    expect(result.typingLifecycle).toBeUndefined();
  });

  it("enables typing in group chat when bot is mentioned", async () => {
    const deps = makeDeps({
      streamingConfig: {
        defaultMode: "thinking",
        perChannel: {
          telegram: {
            typingMode: "thinking",
            typingRefreshMs: 4000,
            typingCircuitBreakerThreshold: 3,
            typingTtlMs: 30000,
          },
        },
      } as never,
    });
    const adapter = makeAdapter("telegram");
    const result = setupInboundExecution(
      deps,
      adapter,
      makeMsg({
        metadata: { telegramChatType: "group", isBotMentioned: true },
      }),
      makeMsg({
        metadata: { telegramChatType: "group", isBotMentioned: true },
      }),
      makeSessionKey(),
    );

    expect(result.typingLifecycle).toBeDefined();
  });
});
