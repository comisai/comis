// SPDX-License-Identifier: Apache-2.0
import type { AgentExecutor, MessageRouter, SessionManager, CommandQueue } from "@comis/agent";
import type { ChannelPort, NormalizedMessage, MessageHandler } from "@comis/core";
import { ok, err } from "@comis/shared";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { createChannelManager, type ChannelManagerDeps } from "./channel-manager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(overrides?: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    channelId: "12345",
    channelType: "telegram",
    senderId: "user-1",
    text: "Hello agent!",
    timestamp: Date.now(),
    attachments: [],
    metadata: { telegramMessageId: 42, telegramChatType: "private" },
    ...overrides,
  };
}

function makeAdapter(
  overrides?: Partial<ChannelPort>,
): ChannelPort & { _handlers: MessageHandler[] } {
  const handlers: MessageHandler[] = [];
  return {
    _handlers: handlers,
    channelId: "telegram-123",
    channelType: "telegram",
    start: vi.fn(async () => ok(undefined)),
    stop: vi.fn(async () => ok(undefined)),
    sendMessage: vi.fn(async () => ok("msg-99")),
    editMessage: vi.fn(async () => ok(undefined)),
    onMessage: vi.fn((handler: MessageHandler) => {
      handlers.push(handler);
    }),
    ...overrides,
  } as any;
}

function makeExecutor(overrides?: Partial<AgentExecutor>): AgentExecutor {
  return {
    execute: vi.fn(async () => ({
      response: "Agent response text",
      sessionKey: { tenantId: "default", userId: "user-1", channelId: "12345" },
      tokensUsed: { input: 100, output: 50, total: 150 },
      cost: { total: 0.001 },
      stepsExecuted: 0,
      finishReason: "stop" as const,
    })),
    ...overrides,
  };
}

function makeRouter(): MessageRouter {
  return {
    resolve: vi.fn(() => "agent-default"),
    updateConfig: vi.fn(),
  };
}

function makeSessionManager(): SessionManager {
  return {
    loadOrCreate: vi.fn(() => []),
    save: vi.fn(),
    isExpired: vi.fn(() => false),
    expire: vi.fn(() => true),
    cleanStale: vi.fn(() => 0),
  };
}

function makeEventBus() {
  return {
    emit: vi.fn(() => true),
    on: vi.fn().mockReturnThis(),
    off: vi.fn().mockReturnThis(),
    once: vi.fn().mockReturnThis(),
    removeAllListeners: vi.fn().mockReturnThis(),
    listenerCount: vi.fn(() => 0),
    setMaxListeners: vi.fn().mockReturnThis(),
  } as any;
}

function makeDeps(overrides?: Partial<ChannelManagerDeps>): ChannelManagerDeps {
  const executor = makeExecutor();
  return {
    eventBus: makeEventBus(),
    messageRouter: makeRouter(),
    sessionManager: makeSessionManager(),
    createExecutor: vi.fn(() => executor),
    adapters: [makeAdapter()],
    logger: createMockLogger(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createChannelManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("startAll()", () => {
    it("calls start() on all adapters", async () => {
      const adapter1 = makeAdapter();
      const adapter2 = makeAdapter({ channelId: "telegram-456" });
      const deps = makeDeps({ adapters: [adapter1, adapter2] });
      const manager = createChannelManager(deps);

      await manager.startAll();

      expect(adapter1.start).toHaveBeenCalled();
      expect(adapter2.start).toHaveBeenCalled();
    });

    it("registers message handlers on all adapters", async () => {
      const adapter1 = makeAdapter();
      const adapter2 = makeAdapter({ channelId: "telegram-456" });
      const deps = makeDeps({ adapters: [adapter1, adapter2] });
      const manager = createChannelManager(deps);

      await manager.startAll();

      expect(adapter1.onMessage).toHaveBeenCalled();
      expect(adapter2.onMessage).toHaveBeenCalled();
    });

    it("increments activeCount for successfully started adapters", async () => {
      const deps = makeDeps();
      const manager = createChannelManager(deps);

      expect(manager.activeCount).toBe(0);
      await manager.startAll();
      expect(manager.activeCount).toBe(1);
    });

    it("logs and skips failed adapter start (does not block others)", async () => {
      const failAdapter = makeAdapter({
        channelId: "telegram-fail",
        start: vi.fn(async () => err(new Error("Connection failed"))),
      });
      const goodAdapter = makeAdapter({ channelId: "telegram-good" });
      const deps = makeDeps({ adapters: [failAdapter, goodAdapter] });
      const manager = createChannelManager(deps);

      await manager.startAll();

      expect(manager.activeCount).toBe(1);
      expect(deps.logger.error).toHaveBeenCalled();
    });
  });

  describe("message handling", () => {
    it("triggers event bus emit, router resolve, executor execute, sendMessage", async () => {
      const adapter = makeAdapter();
      const executor = makeExecutor();
      const deps = makeDeps({
        adapters: [adapter],
        createExecutor: vi.fn(() => executor),
      });
      const manager = createChannelManager(deps);
      await manager.startAll();

      // Trigger message handler
      const msg = makeMessage();
      await adapter._handlers[0](msg);

      expect(deps.eventBus.emit).toHaveBeenCalledWith(
        "message:received",
        expect.objectContaining({ message: msg }),
      );
      expect(deps.messageRouter.resolve).toHaveBeenCalledWith(
        expect.objectContaining({
          channelType: "telegram",
          channelId: "12345",
          senderId: "user-1",
        }),
      );
      expect(executor.execute).toHaveBeenCalled();
      expect(adapter.sendMessage).toHaveBeenCalled();
    });

    it("builds correct SessionKey from NormalizedMessage", async () => {
      const adapter = makeAdapter();
      const executor = makeExecutor();
      const deps = makeDeps({
        adapters: [adapter],
        createExecutor: vi.fn(() => executor),
      });
      const manager = createChannelManager(deps);
      await manager.startAll();

      const msg = makeMessage({ senderId: "user-42", channelId: "chat-99" });
      await adapter._handlers[0](msg);

      expect(executor.execute).toHaveBeenCalledWith(
        msg,
        expect.objectContaining({
          tenantId: "default",
          userId: "user-42",
          channelId: "chat-99",
          peerId: "user-42",
        }),
        undefined, // no assembleToolsForAgent provided
        expect.any(Function), // onDelta
        "agent-default", // agentId from messageRouter.resolve()
        undefined, // no directives
        undefined, // prevTimestamp
        { operationType: "interactive" }, // overrides
      );
    });

    it("passes assembled tools to executor.execute when assembleToolsForAgent is provided", async () => {
      const adapter = makeAdapter();
      const executor = makeExecutor();
      const mockTools = [{ name: "memory_search" }, { name: "read" }];
      const assembleToolsForAgent = vi.fn(async () => mockTools);
      const deps = makeDeps({
        adapters: [adapter],
        createExecutor: vi.fn(() => executor),
        assembleToolsForAgent,
      });
      const manager = createChannelManager(deps);
      await manager.startAll();

      const msg = makeMessage();
      await adapter._handlers[0](msg);

      expect(assembleToolsForAgent).toHaveBeenCalledWith(
        "agent-default",
        expect.objectContaining({ sessionKey: expect.any(Object) }),
      );
      expect(executor.execute).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(Object),
        mockTools, // tools should be passed
        expect.any(Function), // onDelta
        "agent-default",
        undefined, // no directives
        undefined, // prevTimestamp
        { operationType: "interactive" }, // overrides
      );
    });

    it("delivers response via block streaming (sendMessage per chunk)", async () => {
      const adapter = makeAdapter();
      // Mock executor that calls onDelta during execution
      const executor = makeExecutor({
        execute: vi.fn(async (_msg, _sk, _tools, onDelta) => {
          if (onDelta) {
            onDelta("Hello");
            onDelta(" world");
            onDelta("!");
          }
          return {
            response: "Hello world!",
            sessionKey: { tenantId: "default", userId: "user-1", channelId: "12345" },
            tokensUsed: { input: 50, output: 20, total: 70 },
            cost: { total: 0.0005 },
            stepsExecuted: 0,
            finishReason: "stop" as const,
          };
        }),
      });
      const deps = makeDeps({
        adapters: [adapter],
        createExecutor: vi.fn(() => executor),
      });
      const manager = createChannelManager(deps);
      await manager.startAll();

      const msg = makeMessage({
        metadata: { telegramMessageId: 42, telegramChatType: "group", isBotMentioned: true },
      });
      await adapter._handlers[0](msg);

      // Block streaming sends chunks via sendMessage (no placeholder "...")
      expect(adapter.sendMessage).toHaveBeenCalled();
      // First block should include replyTo
      const firstCall = vi.mocked(adapter.sendMessage).mock.calls[0];
      expect(firstCall[2]).toEqual(expect.objectContaining({ replyTo: "42" }));
    });

    it("sends full response via block delivery after execution completes", async () => {
      const adapter = makeAdapter();
      const executor = makeExecutor({
        execute: vi.fn(async (_msg, _sk, _tools, onDelta) => {
          if (onDelta) onDelta("Final text");
          return {
            response: "Final text",
            sessionKey: { tenantId: "default", userId: "user-1", channelId: "12345" },
            tokensUsed: { input: 50, output: 20, total: 70 },
            cost: { total: 0.0005 },
            stepsExecuted: 0,
            finishReason: "stop" as const,
          };
        }),
      });
      const deps = makeDeps({
        adapters: [adapter],
        createExecutor: vi.fn(() => executor),
      });
      const manager = createChannelManager(deps);
      await manager.startAll();

      await adapter._handlers[0](makeMessage());

      // Block streaming delivers via sendMessage (not editMessage)
      const sendCalls = vi.mocked(adapter.sendMessage).mock.calls;
      const sentTexts = sendCalls.map((c) => c[1]);
      expect(sentTexts.join("")).toBe("Final text");
    });

    it("warns and skips when no executor is configured for agent", async () => {
      const adapter = makeAdapter();
      const deps = makeDeps({
        adapters: [adapter],
        createExecutor: vi.fn(() => undefined),
      });
      const manager = createChannelManager(deps);
      await manager.startAll();

      await adapter._handlers[0](makeMessage());

      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "agent-default" }),
        expect.stringContaining("No executor"),
      );
    });

    it("catches and logs errors in executor.execute (does not crash)", async () => {
      const adapter = makeAdapter();
      const executor = makeExecutor({
        execute: vi.fn(async () => {
          throw new Error("Execution failed");
        }),
      });
      const deps = makeDeps({
        adapters: [adapter],
        createExecutor: vi.fn(() => executor),
      });
      const manager = createChannelManager(deps);
      await manager.startAll();

      // Should not throw
      await adapter._handlers[0](makeMessage());

      expect(deps.logger.error).toHaveBeenCalled();
    });

    it("chunks long responses into multiple blocks via sendMessage", async () => {
      const adapter = makeAdapter();
      const longResponse = "A".repeat(5000);
      const executor = makeExecutor({
        execute: vi.fn(async (_msg, _sk, _tools, onDelta) => {
          if (onDelta) onDelta(longResponse);
          return {
            response: longResponse,
            sessionKey: { tenantId: "default", userId: "user-1", channelId: "12345" },
            tokensUsed: { input: 50, output: 500, total: 550 },
            cost: { total: 0.005 },
            stepsExecuted: 0,
            finishReason: "stop" as const,
          };
        }),
      });
      const deps = makeDeps({
        adapters: [adapter],
        createExecutor: vi.fn(() => executor),
      });
      const manager = createChannelManager(deps);
      await manager.startAll();

      await adapter._handlers[0](makeMessage());

      // Block streaming chunks long responses into multiple sendMessage calls
      const sendCalls = vi.mocked(adapter.sendMessage).mock.calls;
      expect(sendCalls.length).toBeGreaterThanOrEqual(1);
      // Total sent characters should equal the full response
      const totalSent = sendCalls.map((c) => c[1] as string).join("").length;
      expect(totalSent).toBe(5000);
    });

    it("emits message:received and message:sent events", async () => {
      const adapter = makeAdapter();
      const deps = makeDeps({ adapters: [adapter] });
      const manager = createChannelManager(deps);
      await manager.startAll();

      const msg = makeMessage();
      await adapter._handlers[0](msg);

      expect(deps.eventBus.emit).toHaveBeenCalledWith(
        "message:received",
        expect.objectContaining({ message: msg }),
      );
      expect(deps.eventBus.emit).toHaveBeenCalledWith(
        "message:sent",
        expect.objectContaining({
          channelId: "12345",
          messageId: "block-delivery",
          content: "Agent response text",
        }),
      );
    });

    it("handles sendMessage failure gracefully during block delivery", async () => {
      const adapter = makeAdapter({
        sendMessage: vi.fn(async () => err(new Error("Rate limited"))),
      });
      const executor = makeExecutor();
      const deps = makeDeps({
        adapters: [adapter],
        createExecutor: vi.fn(() => executor),
      });
      const manager = createChannelManager(deps);
      await manager.startAll();

      // Should not throw
      await adapter._handlers[0](makeMessage());

      // Executor should still have been called
      expect(executor.execute).toHaveBeenCalled();
    });
  });

  describe("preprocessMessage integration", () => {
    it("calls preprocessMessage before executor.execute when provided", async () => {
      const adapter = makeAdapter();
      const executor = makeExecutor();
      const mockPreprocess = vi.fn(async (msg: NormalizedMessage) => ({
        ...msg,
        text: `[Transcription]: hello\n\n${msg.text}`,
      }));
      const deps = makeDeps({
        adapters: [adapter],
        createExecutor: vi.fn(() => executor),
        preprocessMessage: mockPreprocess,
      });
      const manager = createChannelManager(deps);
      await manager.startAll();

      const msg = makeMessage({ text: "original text" });
      await adapter._handlers[0](msg);

      // preprocessMessage should have been called with the original message
      expect(mockPreprocess).toHaveBeenCalledWith(msg);

      // executor should receive the enriched message
      const executeCall = vi.mocked(executor.execute).mock.calls[0];
      expect(executeCall[0].text).toBe("[Transcription]: hello\n\noriginal text");
    });

    it("uses original message when preprocessMessage is not provided", async () => {
      const adapter = makeAdapter();
      const executor = makeExecutor();
      // No preprocessMessage in deps
      const deps = makeDeps({
        adapters: [adapter],
        createExecutor: vi.fn(() => executor),
      });
      const manager = createChannelManager(deps);
      await manager.startAll();

      const msg = makeMessage({ text: "untouched text" });
      await adapter._handlers[0](msg);

      // executor should receive the original message text
      const executeCall = vi.mocked(executor.execute).mock.calls[0];
      expect(executeCall[0].text).toBe("untouched text");
    });

    it("uses original message when preprocessMessage throws", async () => {
      const adapter = makeAdapter();
      const executor = makeExecutor();
      const mockPreprocess = vi.fn(async () => {
        throw new Error("Transcription service unavailable");
      });
      const deps = makeDeps({
        adapters: [adapter],
        createExecutor: vi.fn(() => executor),
        preprocessMessage: mockPreprocess,
      });
      const manager = createChannelManager(deps);
      await manager.startAll();

      const msg = makeMessage({ text: "fallback text" });
      await adapter._handlers[0](msg);

      // executor should receive the original message text (graceful degradation)
      const executeCall = vi.mocked(executor.execute).mock.calls[0];
      expect(executeCall[0].text).toBe("fallback text");

      // logger.warn should have been called about the preprocessing failure
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ channelId: "12345" }),
        "Media preprocessing failed, using original message",
      );
    });
  });

  describe("block streaming delivery", () => {
    async function triggerMessageForPlatform(
      channelType: NormalizedMessage["channelType"],
      metadata?: Record<string, unknown>,
    ) {
      const adapter = makeAdapter({ channelType });
      const executor = makeExecutor({
        execute: vi.fn(async (_msg, _sk, _tools, onDelta) => {
          if (onDelta) onDelta("response");
          return {
            response: "response",
            sessionKey: { tenantId: "default", userId: "user-1", channelId: "12345" },
            tokensUsed: { input: 50, output: 20, total: 70 },
            cost: { total: 0.0005 },
            stepsExecuted: 0,
            finishReason: "stop" as const,
          };
        }),
      });
      const deps = makeDeps({
        adapters: [adapter],
        createExecutor: vi.fn(() => executor),
      });
      const manager = createChannelManager(deps);
      await manager.startAll();

      const msg = makeMessage({ channelType, metadata: metadata ?? {} });
      await adapter._handlers[0](msg);

      return { adapter, executor, deps };
    }

    it("delivers response via sendMessage for all platforms", async () => {
      const { adapter } = await triggerMessageForPlatform("telegram", {
        telegramMessageId: 42,
      });
      // Block streaming delivers via sendMessage (not editMessage)
      expect(adapter.sendMessage).toHaveBeenCalled();
    });

    it("chunks long responses at default 4096 maxChars", async () => {
      const longResponse = "A".repeat(5000);
      const adapter = makeAdapter({ channelType: "discord" });
      const executor = makeExecutor({
        execute: vi.fn(async (_msg, _sk, _tools, onDelta) => {
          if (onDelta) onDelta(longResponse);
          return {
            response: longResponse,
            sessionKey: { tenantId: "default", userId: "user-1", channelId: "12345" },
            tokensUsed: { input: 50, output: 500, total: 550 },
            cost: { total: 0.005 },
            stepsExecuted: 0,
            finishReason: "stop" as const,
          };
        }),
      });
      const deps = makeDeps({
        adapters: [adapter],
        createExecutor: vi.fn(() => executor),
      });
      const manager = createChannelManager(deps);
      await manager.startAll();

      await adapter._handlers[0](makeMessage({ channelType: "discord", metadata: {} }));

      // Block streaming chunks at maxChars boundary, multiple sends expected
      const sendCalls = vi.mocked(adapter.sendMessage).mock.calls;
      expect(sendCalls.length).toBeGreaterThan(1);
    });

    it("delivers short response as single block", async () => {
      const shortResponse = "Short message.";
      const adapter = makeAdapter({ channelType: "whatsapp" });
      const executor = makeExecutor({
        execute: vi.fn(async (_msg, _sk, _tools, onDelta) => {
          if (onDelta) onDelta(shortResponse);
          return {
            response: shortResponse,
            sessionKey: { tenantId: "default", userId: "user-1", channelId: "12345" },
            tokensUsed: { input: 50, output: 20, total: 70 },
            cost: { total: 0.0005 },
            stepsExecuted: 0,
            finishReason: "stop" as const,
          };
        }),
      });
      const deps = makeDeps({
        adapters: [adapter],
        createExecutor: vi.fn(() => executor),
      });
      const manager = createChannelManager(deps);
      await manager.startAll();

      await adapter._handlers[0](makeMessage({ channelType: "whatsapp", metadata: {} }));

      // Short response fits in a single block
      const sendCalls = vi.mocked(adapter.sendMessage).mock.calls;
      expect(sendCalls.length).toBe(1);
      expect(sendCalls[0][1]).toBe("Short message.");
    });

    it("works for unmapped channel types with default config", async () => {
      const { adapter } = await triggerMessageForPlatform("gateway");
      // All platforms use block streaming with defaults
      expect(adapter.sendMessage).toHaveBeenCalled();
    });
  });

  describe("platform-aware replyTo extraction", () => {
    it("extracts replyTo from telegramMessageId for telegram", async () => {
      const adapter = makeAdapter({ channelType: "telegram" });
      const deps = makeDeps({ adapters: [adapter] });
      const manager = createChannelManager(deps);
      await manager.startAll();

      const msg = makeMessage({
        channelType: "telegram",
        metadata: { telegramMessageId: 42, telegramChatType: "group", isBotMentioned: true },
      });
      await adapter._handlers[0](msg);

      // First block sent with replyTo from platform metadata
      expect(adapter.sendMessage).toHaveBeenCalledWith("12345", "Agent response text", {
        replyTo: "42",
      });
    });

    it("extracts replyTo from discordMessageId for discord", async () => {
      const adapter = makeAdapter({ channelType: "discord" });
      const deps = makeDeps({ adapters: [adapter] });
      const manager = createChannelManager(deps);
      await manager.startAll();

      const msg = makeMessage({
        channelType: "discord",
        metadata: { discordMessageId: "1234567890", guildId: "test-guild", isBotMentioned: true },
      });
      await adapter._handlers[0](msg);

      expect(adapter.sendMessage).toHaveBeenCalledWith("12345", "Agent response text", {
        replyTo: "1234567890",
      });
    });

    it("extracts replyTo from slackTs for slack", async () => {
      const adapter = makeAdapter({ channelType: "slack" });
      const deps = makeDeps({ adapters: [adapter] });
      const manager = createChannelManager(deps);
      await manager.startAll();

      const msg = makeMessage({
        channelType: "slack",
        metadata: { slackTs: "1706789012.123456", slackChannelType: "channel", isBotMentioned: true },
      });
      await adapter._handlers[0](msg);

      expect(adapter.sendMessage).toHaveBeenCalledWith("12345", "Agent response text", {
        replyTo: "1706789012.123456",
      });
    });

    it("extracts replyTo from whatsappMessageId for whatsapp", async () => {
      const adapter = makeAdapter({ channelType: "whatsapp" });
      const deps = makeDeps({ adapters: [adapter] });
      const manager = createChannelManager(deps);
      await manager.startAll();

      const msg = makeMessage({
        channelType: "whatsapp",
        metadata: { whatsappMessageId: "ABCDEF123", isGroup: true, isBotMentioned: true },
      });
      await adapter._handlers[0](msg);

      expect(adapter.sendMessage).toHaveBeenCalledWith("12345", "Agent response text", {
        replyTo: "ABCDEF123",
      });
    });

    it("returns undefined replyTo when metadata key is absent", async () => {
      const adapter = makeAdapter({ channelType: "discord" });
      const deps = makeDeps({ adapters: [adapter] });
      const manager = createChannelManager(deps);
      await manager.startAll();

      const msg = makeMessage({
        channelType: "discord",
        metadata: {}, // No discordMessageId
      });
      await adapter._handlers[0](msg);

      expect(adapter.sendMessage).toHaveBeenCalledWith("12345", "Agent response text", {
        replyTo: undefined,
      });
    });
  });

  describe("stopAll()", () => {
    it("calls stop() on all adapters", async () => {
      const adapter1 = makeAdapter();
      const adapter2 = makeAdapter({ channelId: "telegram-456" });
      const deps = makeDeps({ adapters: [adapter1, adapter2] });
      const manager = createChannelManager(deps);
      await manager.startAll();

      await manager.stopAll();

      expect(adapter1.stop).toHaveBeenCalled();
      expect(adapter2.stop).toHaveBeenCalled();
    });

    it("resets activeCount to 0", async () => {
      const deps = makeDeps();
      const manager = createChannelManager(deps);
      await manager.startAll();
      expect(manager.activeCount).toBe(1);

      await manager.stopAll();
      expect(manager.activeCount).toBe(0);
    });

    it("logs errors from stop but does not throw", async () => {
      const adapter = makeAdapter({
        stop: vi.fn(async () => err(new Error("Stop failed"))),
      });
      const deps = makeDeps({ adapters: [adapter] });
      const manager = createChannelManager(deps);
      await manager.startAll();

      // Should not throw
      await manager.stopAll();

      expect(deps.logger.error).toHaveBeenCalled();
    });
  });

  describe("injectMessage()", () => {
    it("invokes onMessageProcessed after successful injection", async () => {
      const onMessageProcessed = vi.fn();
      const adapter = makeAdapter();
      const deps = makeDeps({ adapters: [adapter], onMessageProcessed });
      const manager = createChannelManager(deps);
      await manager.startAll();

      const msg = makeMessage();
      await manager.injectMessage("telegram", msg);

      expect(onMessageProcessed).toHaveBeenCalledTimes(1);
      expect(onMessageProcessed).toHaveBeenCalledWith(msg, "telegram");
    });

    it("does not invoke onMessageProcessed for graph-report intercept", async () => {
      const onMessageProcessed = vi.fn();
      const onGraphReportRequest = vi.fn(async () => {});
      const adapter = makeAdapter();
      const deps = makeDeps({ adapters: [adapter], onMessageProcessed, onGraphReportRequest });
      const manager = createChannelManager(deps);
      await manager.startAll();

      const msg = makeMessage({
        text: "graph:report:abc123",
        metadata: { telegramMessageId: 42, isButtonCallback: true },
      });
      await manager.injectMessage("telegram", msg);

      expect(onGraphReportRequest).toHaveBeenCalledTimes(1);
      expect(onMessageProcessed).not.toHaveBeenCalled();
    });

    it("does not invoke onMessageProcessed when adapter is missing", async () => {
      const onMessageProcessed = vi.fn();
      const deps = makeDeps({ adapters: [], onMessageProcessed });
      const manager = createChannelManager(deps);
      await manager.startAll();

      await manager.injectMessage("nonexistent", makeMessage());

      expect(onMessageProcessed).not.toHaveBeenCalled();
      expect(deps.logger.warn).toHaveBeenCalled();
    });

    it("does not throw when onMessageProcessed is undefined", async () => {
      const adapter = makeAdapter();
      const deps = makeDeps({ adapters: [adapter] }); // no onMessageProcessed
      const manager = createChannelManager(deps);
      await manager.startAll();

      await expect(manager.injectMessage("telegram", makeMessage())).resolves.not.toThrow();
    });
  });

  describe("stopAll() in-flight drain", () => {
    it("awaits in-flight sendMessage before calling adapter.stop()", async () => {
      const callOrder: string[] = [];
      let resolveSend: () => void = () => {};
      // Pre-populate an in-flight Set with a manually-resolvable promise to
      // simulate what deliver-to-channel.ts would have added mid-send.
      const externalSet = new Set<Promise<unknown>>();
      const sendPromise = new Promise<void>((r) => {
        resolveSend = r;
      });
      externalSet.add(sendPromise);

      const adapter = makeAdapter({
        stop: vi.fn(async () => {
          callOrder.push("stop");
          return ok(undefined);
        }),
      });
      const deps = makeDeps({ adapters: [adapter], inFlightSends: externalSet });
      const manager = createChannelManager(deps);
      await manager.startAll();

      const stopPromise = manager.stopAll();
      // Yield microtasks: drain has started but cannot complete because the
      // tracked promise is unresolved. adapter.stop() must NOT have run yet.
      await Promise.resolve();
      await Promise.resolve();
      expect(callOrder).not.toContain("stop");

      // Resolve the in-flight send: drain race wins, stopAll() proceeds.
      resolveSend();
      await stopPromise;
      expect(callOrder).toContain("stop");
    });

    it("enforces 5s deadline on hung sends", async () => {
      vi.useFakeTimers();
      try {
        const externalSet = new Set<Promise<unknown>>();
        // Hung promise -- never resolves. Drain must time out at 5000ms.
        const hung = new Promise<void>(() => {});
        externalSet.add(hung);

        const stopSpy = vi.fn(async () => ok(undefined));
        const adapter = makeAdapter({ stop: stopSpy });
        const deps = makeDeps({ adapters: [adapter], inFlightSends: externalSet });
        const manager = createChannelManager(deps);
        await manager.startAll();

        const stopPromise = manager.stopAll();
        // Before deadline: stop() has not been called.
        await vi.advanceTimersByTimeAsync(4999);
        expect(stopSpy).not.toHaveBeenCalled();
        // At deadline: drain race resolves, stop() proceeds.
        await vi.advanceTimersByTimeAsync(2);
        await stopPromise;
        expect(stopSpy).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("skips drain log when inFlightSends is empty", async () => {
      const adapter = makeAdapter();
      const deps = makeDeps({ adapters: [adapter] }); // factory creates its own empty Set
      const manager = createChannelManager(deps);
      await manager.startAll();
      await manager.stopAll();

      // The "in-flight outbound sends drained" INFO must NOT have been emitted.
      const drainLogs = (deps.logger.info as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([, msg]) => msg === "Channel manager: in-flight outbound sends drained",
      );
      expect(drainLogs).toHaveLength(0);
    });
  });

  describe("activeCount", () => {
    it("reflects started adapters", async () => {
      const adapter1 = makeAdapter();
      const adapter2 = makeAdapter({
        channelId: "telegram-fail",
        start: vi.fn(async () => err(new Error("fail"))),
      });
      const adapter3 = makeAdapter({ channelId: "telegram-good" });
      const deps = makeDeps({ adapters: [adapter1, adapter2, adapter3] });
      const manager = createChannelManager(deps);

      await manager.startAll();

      // 2 succeeded, 1 failed
      expect(manager.activeCount).toBe(2);
    });
  });

  describe("prompt skill detection", () => {
    it("detects /skill:name command and injects metadata", async () => {
      const adapter = makeAdapter();
      const executor = makeExecutor();
      const loadPromptSkill = vi.fn(async () =>
        ok({ content: "<skill>test content</skill>", allowedTools: ["exec"], skillName: "test-skill" }),
      );
      const getUserInvocableSkillNames = vi.fn(() => new Set(["test-skill"]));
      const eventBus = makeEventBus();
      const deps = makeDeps({
        adapters: [adapter],
        createExecutor: vi.fn(() => executor),
        eventBus,
        loadPromptSkill,
        getUserInvocableSkillNames,
      });
      const manager = createChannelManager(deps);
      await manager.startAll();

      const msg = makeMessage({ text: "/skill:test-skill write some code" });
      await adapter._handlers[0](msg);

      // Executor should receive the message with injected metadata
      const executeCall = vi.mocked(executor.execute).mock.calls[0];
      const executedMsg = executeCall[0] as NormalizedMessage;
      expect(executedMsg.metadata?.promptSkillContent).toBe("<skill>test content</skill>");
      expect(executedMsg.metadata?.promptSkillAllowedTools).toEqual(["exec"]);
      expect(executedMsg.metadata?.promptSkillName).toBe("test-skill");
      expect(executedMsg.text).toBe("write some code");

      // skill:prompt_invoked event should have been emitted
      expect(eventBus.emit).toHaveBeenCalledWith(
        "skill:prompt_invoked",
        expect.objectContaining({
          skillName: "test-skill",
          invokedBy: "user",
          args: "write some code",
        }),
      );
    });

    it("system commands take priority over /skill:name", async () => {
      const adapter = makeAdapter();
      const executor = makeExecutor();
      const loadPromptSkill = vi.fn(async () =>
        ok({ content: "<skill>...</skill>", allowedTools: [], skillName: "status" }),
      );
      const getUserInvocableSkillNames = vi.fn(() => new Set(["status"]));
      const deps = makeDeps({
        adapters: [adapter],
        createExecutor: vi.fn(() => executor),
        loadPromptSkill,
        getUserInvocableSkillNames,
      });
      const manager = createChannelManager(deps);
      await manager.startAll();

      // /status is a system command -- loadPromptSkill should NOT be called
      const msg = makeMessage({ text: "/status" });
      await adapter._handlers[0](msg);

      expect(loadPromptSkill).not.toHaveBeenCalled();
    });

    it("skips detection when deps are absent", async () => {
      const adapter = makeAdapter();
      const executor = makeExecutor();
      // No loadPromptSkill or getUserInvocableSkillNames in deps
      const deps = makeDeps({
        adapters: [adapter],
        createExecutor: vi.fn(() => executor),
      });
      const manager = createChannelManager(deps);
      await manager.startAll();

      const msg = makeMessage({ text: "/skill:test-skill args" });
      await adapter._handlers[0](msg);

      // Executor should receive the original text unchanged
      const executeCall = vi.mocked(executor.execute).mock.calls[0];
      expect(executeCall[0].text).toBe("/skill:test-skill args");
    });

    it("handles load failure gracefully", async () => {
      const adapter = makeAdapter();
      const executor = makeExecutor();
      const loadPromptSkill = vi.fn(async () => err(new Error("not found")));
      const getUserInvocableSkillNames = vi.fn(() => new Set(["test-skill"]));
      const logger = createMockLogger();
      const deps = makeDeps({
        adapters: [adapter],
        createExecutor: vi.fn(() => executor),
        loadPromptSkill,
        getUserInvocableSkillNames,
        logger,
      });
      const manager = createChannelManager(deps);
      await manager.startAll();

      const msg = makeMessage({ text: "/skill:test-skill args" });
      await adapter._handlers[0](msg);

      // logger.warn should have been called about the load failure
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ skillName: "test-skill" }),
        "Failed to load prompt skill",
      );

      // Executor should receive message without skill metadata
      const executeCall = vi.mocked(executor.execute).mock.calls[0];
      const executedMsg = executeCall[0] as NormalizedMessage;
      expect(executedMsg.metadata?.promptSkillContent).toBeUndefined();
    });

    it("sets empty text when no args provided", async () => {
      const adapter = makeAdapter();
      const executor = makeExecutor();
      const loadPromptSkill = vi.fn(async () =>
        ok({ content: "<skill>content</skill>", allowedTools: ["exec"], skillName: "test-skill" }),
      );
      const getUserInvocableSkillNames = vi.fn(() => new Set(["test-skill"]));
      const deps = makeDeps({
        adapters: [adapter],
        createExecutor: vi.fn(() => executor),
        loadPromptSkill,
        getUserInvocableSkillNames,
      });
      const manager = createChannelManager(deps);
      await manager.startAll();

      const msg = makeMessage({ text: "/skill:test-skill" });
      await adapter._handlers[0](msg);

      // Executor should receive empty text (no args)
      const executeCall = vi.mocked(executor.execute).mock.calls[0];
      expect(executeCall[0].text).toBe("");
    });

    it("does not inject allowedTools metadata when allowedTools is empty", async () => {
      const adapter = makeAdapter();
      const executor = makeExecutor();
      const loadPromptSkill = vi.fn(async () =>
        ok({ content: "<skill>content</skill>", allowedTools: [], skillName: "test-skill" }),
      );
      const getUserInvocableSkillNames = vi.fn(() => new Set(["test-skill"]));
      const deps = makeDeps({
        adapters: [adapter],
        createExecutor: vi.fn(() => executor),
        loadPromptSkill,
        getUserInvocableSkillNames,
      });
      const manager = createChannelManager(deps);
      await manager.startAll();

      const msg = makeMessage({ text: "/skill:test-skill" });
      await adapter._handlers[0](msg);

      // Executor should receive message with promptSkillAllowedTools undefined (not empty array)
      const executeCall = vi.mocked(executor.execute).mock.calls[0];
      const executedMsg = executeCall[0] as NormalizedMessage;
      expect(executedMsg.metadata?.promptSkillAllowedTools).toBeUndefined();
      // But skill content and name should still be present
      expect(executedMsg.metadata?.promptSkillContent).toBe("<skill>content</skill>");
      expect(executedMsg.metadata?.promptSkillName).toBe("test-skill");
    });
  });

  describe("command queue enqueue failure logging", () => {
    function makeCommandQueue(enqueueResult: ReturnType<typeof ok> | ReturnType<typeof err>): CommandQueue {
      return {
        enqueue: vi.fn(async (_sk, _msg, _ct, handler) => {
          // Still execute the handler so streaming delivery works
          if (enqueueResult.ok) {
            await handler([makeMessage()]);
          }
          return enqueueResult;
        }),
        getQueueDepth: vi.fn(() => 0),
        isProcessing: vi.fn(() => false),
        drain: vi.fn(async () => {}),
        drainAll: vi.fn(async () => {}),
        getStats: vi.fn(() => ({ activeSessions: 0, totalPending: 0, activeExecutions: 0 })),
        shutdown: vi.fn(async () => {}),
      } as unknown as CommandQueue;
    }

    it("logs WARN when primary message enqueue returns err Result", async () => {
      const adapter = makeAdapter();
      const executor = makeExecutor();
      const logger = createMockLogger();
      const commandQueue = makeCommandQueue(err(new Error("queue shutdown")));
      const deps = makeDeps({
        adapters: [adapter],
        createExecutor: vi.fn(() => executor),
        commandQueue,
        logger,
      });
      const manager = createChannelManager(deps);
      await manager.startAll();

      await adapter._handlers[0](makeMessage());

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          err: "queue shutdown",
          hint: expect.any(String),
          errorKind: "resource",
        }),
        "Message enqueue failed",
      );
    });

    it("does NOT log WARN when enqueue returns ok Result", async () => {
      const adapter = makeAdapter();
      const executor = makeExecutor();
      const logger = createMockLogger();
      const commandQueue = makeCommandQueue(ok(undefined));
      const deps = makeDeps({
        adapters: [adapter],
        createExecutor: vi.fn(() => executor),
        commandQueue,
        logger,
      });
      const manager = createChannelManager(deps);
      await manager.startAll();

      await adapter._handlers[0](makeMessage());

      // WARN should NOT have been called with any "enqueue failed" message
      const warnCalls = (logger.warn as any).mock.calls;
      const enqueueWarn = warnCalls.find((c: any[]) =>
        typeof c[1] === "string" && c[1].includes("enqueue failed"),
      );
      expect(enqueueWarn).toBeUndefined();
    });
  });
});
