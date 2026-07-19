// SPDX-License-Identifier: Apache-2.0
import type { AgentExecutor, SessionLifecycle } from "@comis/agent";
// MessageRouter and CommandQueue live in this package; relative paths used
// because orchestrator cannot import its own published name.
import type { MessageRouter } from "./routing/message-router.js";
import type { CommandQueue } from "./queue/command-queue.js";
import { type ChannelPort, type NormalizedMessage, type MessageHandler, type DeliveryService } from "@comis/core";
import { ok, err } from "@comis/shared";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockLogger } from "../../../test/support/mock-logger.js";
import { createFakePrincipalResolver } from "../../../test/support/fake-principal-resolver.js";
import { createChannelManager, type ChannelManagerDeps } from "./channel-manager.js";
import { processInboundMessage as realProcessInboundMessage } from "./inbound/inbound-pipeline.js";

// ChannelManagerDeps requires a DeliveryService. The fake's deliverToChannel
// delegates to adapter.sendMessage so all the existing assertions on
// adapter.sendMessage (chunking, replyTo extraction, per-platform behavior)
// keep working — the assertions are observing the adapter call shape, not
// the in-between DeliveryService call. `drainInFlight` is a default no-op
// (empty drain) for tests that don't exercise stopAll() drain semantics;
// see `makeFakeDeliveryServiceWithTracker` for the drain-test variant.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only fake
function makeFakeDeliveryService(): DeliveryService {
  return {
    deliverToChannel: vi.fn(async (adapter: any, channelId: string, text: string, options?: any) => {
      // Project per-call options to SendMessageOptions. Always pass an options
      // object when the caller did (even when fields are undefined) so test
      // assertions can verify the replyTo/threadId/extra projection contract
      // without ambiguity.
      const sendOpts: any = {
        replyTo: options?.replyTo,
        threadId: options?.threadId,
        extra: options?.extra,
      };
      const finalOpts = options ? sendOpts : undefined;
      const result = await adapter.sendMessage(channelId, text, finalOpts);
      return ok({
        ok: result.ok,
        totalChunks: 1,
        deliveredChunks: result.ok ? 1 : 0,
        failedChunks: result.ok ? 0 : 1,
        chunks: [{
          ok: result.ok,
          messageId: result.ok ? result.value : undefined,
          error: result.ok ? undefined : result.error,
          charCount: text.length,
          retried: false,
        }],
        totalChars: text.length,
      });
    }),
    drainInFlight: vi.fn(async () => ({ drained: 0, remaining: 0, durationMs: 0 })),
  };
}

/**
 * Test-only DeliveryService that exposes a controllable in-flight tracker.
 * Use in tests that need to assert drain ordering or hung-send timing
 * without leaking the Set through production deps (the `inFlightSends`
 * deps slot was removed from `ChannelManagerDeps`).
 *
 * Returns `{ service, track }`. Call `track(promise)` to add a promise to
 * the tracker; the service's `drainInFlight(deadlineMs)` races
 * `Promise.allSettled` against the deadline and returns drain telemetry —
 * matching the production `DeliveryService.drainInFlight` contract.
 */
function makeFakeDeliveryServiceWithTracker(): {
  service: DeliveryService;
  track: (p: Promise<unknown>) => void;
} {
  const tracker = new Set<Promise<unknown>>();
  const service: DeliveryService = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only stub
    deliverToChannel: vi.fn(async (_adapter: any, _channelId: string, _text: string, _options?: any) => {
      return ok({
        ok: true,
        totalChunks: 1,
        deliveredChunks: 1,
        failedChunks: 0,
        chunks: [{ ok: true, messageId: "stub", charCount: _text.length, retried: false }],
        totalChars: _text.length,
      });
    }),
    drainInFlight: async (deadlineMs = 5000) => {
      const start = Date.now();
      const inFlightCount = tracker.size;
      if (inFlightCount === 0) {
        return { drained: 0, remaining: 0, durationMs: 0 };
      }
      await Promise.race([
        Promise.allSettled([...tracker]),
        new Promise<void>((resolve) => setTimeout(resolve, deadlineMs)),
      ]);
      return {
        drained: inFlightCount - tracker.size,
        remaining: tracker.size,
        durationMs: Date.now() - start,
      };
    },
  };
  return {
    service,
    track: (p: Promise<unknown>) => {
      tracker.add(p);
      void p.finally(() => tracker.delete(p));
    },
  };
}

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

function makeSessionManager(): SessionLifecycle {
  return {
    loadOrCreate: vi.fn(() => ok([])),
    save: vi.fn(() => ok(undefined)),
    isExpired: vi.fn(() => false),
    expire: vi.fn(() => ok(undefined)),
    cleanStale: vi.fn(() => ok(0)),
  };
}

/**
 * The orchestrator reads `replyToMetaKey` via
 * `deps.channelRegistry?.getCapabilities(channelType)`. There is no hardcoded
 * REPLY_TO_META_KEY fallback, so tests that exercise the
 * telegram/discord/slack/whatsapp reply-to paths must
 * inject this fake registry to keep those code paths covered.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only stub
function makeFakeChannelRegistry(): any {
  const caps: Record<string, { replyToMetaKey: string; features: { reactions: boolean } }> = {
    telegram: { replyToMetaKey: "telegramMessageId", features: { reactions: true } },
    discord: { replyToMetaKey: "discordMessageId", features: { reactions: true } },
    slack: { replyToMetaKey: "slackTs", features: { reactions: true } },
    whatsapp: { replyToMetaKey: "whatsappMessageId", features: { reactions: true } },
    signal: { replyToMetaKey: "signalTimestamp", features: { reactions: true } },
    line: { replyToMetaKey: "lineMessageId", features: { reactions: false } },
    imessage: { replyToMetaKey: "imsgMessageId", features: { reactions: false } },
    irc: { replyToMetaKey: "ircMessageId", features: { reactions: false } },
    email: { replyToMetaKey: "emailMessageId", features: { reactions: false } },
    echo: { replyToMetaKey: "echoMessageId", features: { reactions: false } },
  };
  return {
    // eslint-disable-next-line security/detect-object-injection -- test-only lookup over closed map
    getCapabilities: (channelType: string) => caps[channelType],
    getAdapter: () => undefined,
    getChannelTypes: () => Object.keys(caps),
    getChannelPlugins: () => [],
    registerChannel: () => ({ ok: true as const, value: undefined }),
    unregisterChannel: () => ({ ok: true as const, value: undefined }),
  };
}

function makeEventBus() {
  const emit = vi.fn(() => true);
  return {
    emit,
    emitSafely: vi.fn((event, payload) => {
      emit(event, payload);
      return { hadListeners: false, failures: [] };
    }),
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
  const principalResolver = createFakePrincipalResolver();
  return {
    tenantId: "default",
    eventBus: makeEventBus(),
    messageRouter: makeRouter(),
    principalResolver,
    getDmScope: () => ({ mode: "per-account-channel-peer", threadIsolation: true }),
    sessionManager: makeSessionManager(),
    createExecutor: vi.fn(() => executor),
    persistInboundMessage: vi.fn(async (_agentId, message) => ({
      ok: true as const,
      value: {
        payloads: [{
            schemaVersion: 1 as const,
            batchId: message.id,
            chunkIndex: 0,
            chunkCount: 1,
            recordedAt: message.timestamp,
            messages: [{
              id: message.id,
              channelId: message.channelId,
              channelType: message.channelType,
              senderId: message.senderId,
              text: message.text,
              timestamp: message.timestamp,
            }],
        }],
        ledgerContent: "test-ledger-record\n",
      },
    })),
    adapters: [makeAdapter()],
    logger: createMockLogger(),
    // DeliveryService is required on ChannelManagerDeps. The fake delegates
    // to adapter.sendMessage so the existing assertions remain valid
    // (assertions observe adapter call shape, not the in-between layer).
    deliveryService: makeFakeDeliveryService(),
    // Orchestrator reads replyToMetaKey via this registry; the fake mirrors
    // plugin CAPABILITIES for the 10 channel types so tests that exercise
    // the inbound replyTo extraction path keep their assertions valid after
    // the REPLY_TO_META_KEY Record was deleted.
    channelRegistry: makeFakeChannelRegistry(),
    // processInboundMessage is injected. Default wires the REAL
    // implementation so existing test assertions on executor.execute /
    // adapter.sendMessage / preprocessMessage / etc. still exercise the
    // full inbound pipeline. Individual tests that want a spy override
    // this field via the `overrides` parameter.
    processInboundMessage: realProcessInboundMessage as unknown as ChannelManagerDeps["processInboundMessage"],
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
      // Distinct channelType — startAll() dedupes adapters by channelType
      // (see channel-manager-branches.test.ts "adapter deduplication"). The
      // intent here is multi-adapter lifecycle, not "two telegrams".
      const adapter2 = makeAdapter({ channelType: "discord", channelId: "discord-456" });
      const deps = makeDeps({ adapters: [adapter1, adapter2] });
      const manager = createChannelManager(deps);

      await manager.startAll();

      expect(adapter1.start).toHaveBeenCalled();
      expect(adapter2.start).toHaveBeenCalled();
    });

    it("registers message handlers on all adapters", async () => {
      const adapter1 = makeAdapter();
      const adapter2 = makeAdapter({ channelType: "discord", channelId: "discord-456" });
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
      // Distinct channelType so the good adapter isn't deduped against the
      // failing one — the intent is "one fails, another succeeds".
      const goodAdapter = makeAdapter({ channelType: "discord", channelId: "discord-good" });
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
          agentId: "agent-default",
          userId: expect.stringMatching(/^platform_/),
          channelId: "telegram:telegram-123:chat-99",
          peerId: expect.stringMatching(/^platform_/),
        }),
        undefined, // no assembleToolsForAgent provided
        expect.any(Function), // onDelta
        "agent-default", // agentId from messageRouter.resolve()
        undefined, // no directives
        undefined, // prevTimestamp
        expect.objectContaining({
          operationType: "interactive",
          inboundProvenancePlans: [expect.objectContaining({ payloads: expect.any(Array) })],
        }),
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
        expect.objectContaining({
          operationType: "interactive",
          inboundProvenancePlans: [expect.objectContaining({ payloads: expect.any(Array) })],
        }),
      );
    });

    it("delivers response via block streaming (sendMessage per chunk)", async () => {
      const adapter = makeAdapter();
      // Mock executor that calls onDelta during execution
      const executor = makeExecutor({
        execute: vi.fn(async (_msg, _sk, _tools, onDelta) => {
          if (onDelta) {
            onDelta("Hello", "text");
            onDelta(" world", "text");
            onDelta("!", "text");
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
          if (onDelta) onDelta("Final text", "text");
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

    it("rejects acknowledgement when no executor is configured for the agent", async () => {
      const adapter = makeAdapter();
      const deps = makeDeps({
        adapters: [adapter],
        createExecutor: vi.fn(() => undefined),
      });
      const manager = createChannelManager(deps);
      await manager.startAll();

      await expect(adapter._handlers[0](makeMessage())).rejects.toThrow(
        "No executor configured",
      );

      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "agent-default" }),
        expect.stringContaining("No executor"),
      );
    });

    it("logs executor failures and rejects the channel acknowledgement", async () => {
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

      await expect(adapter._handlers[0](makeMessage())).rejects.toThrow("Execution failed");

      expect(deps.logger.error).toHaveBeenCalled();
    });

    it("reprocesses persisted provenance because receipt does not prove completed handling", async () => {
      const adapter = makeAdapter();
      const createExecutor = vi.fn(() => makeExecutor());
      const deps = makeDeps({
        adapters: [adapter],
        createExecutor,
        persistInboundMessage: vi.fn(async (_agentId, message) => ({
          ok: true as const,
          value: {
            payloads: [{
              schemaVersion: 1 as const,
              batchId: message.id,
              chunkIndex: 0,
              chunkCount: 1,
              recordedAt: message.timestamp - 1_000,
              messages: [],
            }],
            ledgerContent: "persisted-provenance\n",
          },
        })),
      });
      const manager = createChannelManager(deps);
      await manager.startAll();
      const message = makeMessage();

      await expect(adapter._handlers[0](message)).resolves.toBeUndefined();

      expect(createExecutor).toHaveBeenCalledOnce();
    });

    it("chunks long responses into multiple blocks via sendMessage", async () => {
      const adapter = makeAdapter();
      const longResponse = "A".repeat(5000);
      const executor = makeExecutor({
        execute: vi.fn(async (_msg, _sk, _tools, onDelta) => {
          if (onDelta) onDelta(longResponse, "text");
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
      // message:sent now carries the receipt's real lastChunkMessageId
      // (the fake adapter.sendMessage returns "msg-99"), not the prior synthetic id.
      expect(deps.eventBus.emit).toHaveBeenCalledWith(
        "message:sent",
        expect.objectContaining({
          channelId: "12345",
          messageId: "msg-99",
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

      // Preprocessing receives the original message plus the resolved turn authority.
      expect(mockPreprocess).toHaveBeenCalledWith(
        msg,
        expect.objectContaining({
          conversation: expect.objectContaining({ tenantId: "default", agentId: "agent-default" }),
        }),
      );

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
          if (onDelta) onDelta("response", "text");
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
          if (onDelta) onDelta(longResponse, "text");
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
          if (onDelta) onDelta(shortResponse, "text");
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
      const adapter2 = makeAdapter({ channelType: "discord", channelId: "discord-456" });
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

    it("does not intercept unsigned graph-report text before the inbound pipeline", async () => {
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

      expect(onGraphReportRequest).not.toHaveBeenCalled();
      expect(onMessageProcessed).toHaveBeenCalledTimes(1);
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

    it("processes a message whose metadata is FROZEN without throwing on the traceId write", async () => {
      // The inbound traceId-seed wrote `msg.metadata.traceId = …` in place.
      // On a frozen metadata object that assignment throws a TypeError in strict
      // mode (ES module), which aborts the whole injected turn. Context propagation
      // already rides on runWithContext({ traceId }) — the metadata write is a
      // best-effort convenience for downstream consumers, so a frozen object must
      // NOT break processing.
      const adapter = makeAdapter();
      const onMessageProcessed = vi.fn();
      const processInboundMessage = vi.fn(async () => {});
      const deps = makeDeps({
        adapters: [adapter],
        onMessageProcessed,
        processInboundMessage: processInboundMessage as unknown as ChannelManagerDeps["processInboundMessage"],
      });
      const manager = createChannelManager(deps);
      await manager.startAll();

      // Frozen metadata WITHOUT a traceId → the seed path tries to write it in place.
      const frozenMsg = makeMessage({ metadata: Object.freeze({ telegramMessageId: 7 }) });

      await expect(manager.injectMessage("telegram", frozenMsg)).resolves.not.toThrow();
      // The turn still processed (the frozen write did not abort it).
      expect(processInboundMessage).toHaveBeenCalledTimes(1);
      expect(onMessageProcessed).toHaveBeenCalledTimes(1);
    });
  });

  describe("onMessageReceived / onMessageProcessed timing", () => {
    // Pin the timing contract: onMessageReceived MUST fire BEFORE await
    // processInboundMessage on both code paths so the continuation tracker
    // is populated before any in-flight tool call could trigger SIGUSR2.
    // onMessageProcessed retains its post-processing semantics
    // (sessionTrackerRef.ref deferred-wiring requirement).

    /** Build a deferred promise the test can resolve at will. */
    function makeDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
      let resolveFn: (value: T) => void = () => {};
      const promise = new Promise<T>((r) => {
        resolveFn = r;
      });
      return { promise, resolve: resolveFn };
    }

    it("fires onMessageReceived BEFORE processInboundMessage on the normal inbound path", async () => {
      const calls: string[] = [];
      const deferred = makeDeferred<{
        response: string;
        sessionKey: { tenantId: string; userId: string; channelId: string };
        tokensUsed: { input: number; output: number; total: number };
        cost: { total: number };
        stepsExecuted: number;
        finishReason: "stop";
      }>();
      const adapter = makeAdapter();
      const executor = makeExecutor({
        execute: vi.fn(() => deferred.promise),
      });
      const onMessageReceived = vi.fn(() => {
        calls.push("received");
      });
      const onMessageProcessed = vi.fn(() => {
        calls.push("processed");
      });
      const deps = makeDeps({
        adapters: [adapter],
        createExecutor: vi.fn(() => executor),
        onMessageReceived,
        onMessageProcessed,
      });
      const manager = createChannelManager(deps);
      await manager.startAll();

      const msg = makeMessage();
      const handlerPromise = adapter._handlers[0](msg);
      // Yield microtasks so executor.execute can be reached and the handler
      // is parked at await processInboundMessage.
      await Promise.resolve();
      await Promise.resolve();

      // While processing is hung, onMessageReceived must have already fired
      // and onMessageProcessed must not have fired yet.
      expect(onMessageReceived).toHaveBeenCalledTimes(1);
      expect(onMessageReceived).toHaveBeenCalledWith(msg, "telegram");
      expect(onMessageProcessed).not.toHaveBeenCalled();

      // Resolve the deferred executor to unblock processInboundMessage.
      deferred.resolve({
        response: "Agent response text",
        sessionKey: { tenantId: "default", userId: "user-1", channelId: "12345" },
        tokensUsed: { input: 100, output: 50, total: 150 },
        cost: { total: 0.001 },
        stepsExecuted: 0,
        finishReason: "stop",
      });
      await handlerPromise;

      expect(onMessageProcessed).toHaveBeenCalledTimes(1);
      expect(onMessageProcessed).toHaveBeenCalledWith(msg, "telegram");
      expect(calls).toEqual(["received", "processed"]);
    });

    it("fires onMessageReceived BEFORE processInboundMessage on the injectMessage path", async () => {
      const calls: string[] = [];
      const deferred = makeDeferred<{
        response: string;
        sessionKey: { tenantId: string; userId: string; channelId: string };
        tokensUsed: { input: number; output: number; total: number };
        cost: { total: number };
        stepsExecuted: number;
        finishReason: "stop";
      }>();
      const adapter = makeAdapter();
      const executor = makeExecutor({
        execute: vi.fn(() => deferred.promise),
      });
      const onMessageReceived = vi.fn(() => {
        calls.push("received");
      });
      const onMessageProcessed = vi.fn(() => {
        calls.push("processed");
      });
      const deps = makeDeps({
        adapters: [adapter],
        createExecutor: vi.fn(() => executor),
        onMessageReceived,
        onMessageProcessed,
      });
      const manager = createChannelManager(deps);
      await manager.startAll();

      const msg = makeMessage();
      const injectPromise = manager.injectMessage("telegram", msg);
      await Promise.resolve();
      await Promise.resolve();

      expect(onMessageReceived).toHaveBeenCalledTimes(1);
      expect(onMessageReceived).toHaveBeenCalledWith(msg, "telegram");
      expect(onMessageProcessed).not.toHaveBeenCalled();

      deferred.resolve({
        response: "Agent response text",
        sessionKey: { tenantId: "default", userId: "user-1", channelId: "12345" },
        tokensUsed: { input: 100, output: 50, total: 150 },
        cost: { total: 0.001 },
        stepsExecuted: 0,
        finishReason: "stop",
      });
      await injectPromise;

      expect(onMessageProcessed).toHaveBeenCalledTimes(1);
      expect(onMessageProcessed).toHaveBeenCalledWith(msg, "telegram");
      expect(calls).toEqual(["received", "processed"]);
    });

    it("unsigned graph-report text on injectMessage passes through both lifecycle callbacks", async () => {
      const onMessageReceived = vi.fn();
      const onMessageProcessed = vi.fn();
      const onGraphReportRequest = vi.fn(async () => {});
      const adapter = makeAdapter();
      const deps = makeDeps({
        adapters: [adapter],
        onMessageReceived,
        onMessageProcessed,
        onGraphReportRequest,
      });
      const manager = createChannelManager(deps);
      await manager.startAll();

      const msg = makeMessage({
        text: "graph:report:abc123",
        metadata: { telegramMessageId: 42, isButtonCallback: true },
      });
      await manager.injectMessage("telegram", msg);

      expect(onGraphReportRequest).not.toHaveBeenCalled();
      expect(onMessageReceived).toHaveBeenCalledWith(msg, "telegram");
      expect(onMessageProcessed).toHaveBeenCalledWith(msg, "telegram");
    });

    it("no-adapter intercept on injectMessage bypasses BOTH callbacks", async () => {
      const onMessageReceived = vi.fn();
      const onMessageProcessed = vi.fn();
      const deps = makeDeps({
        adapters: [],
        onMessageReceived,
        onMessageProcessed,
      });
      const manager = createChannelManager(deps);
      await manager.startAll();

      await manager.injectMessage("nonexistent", makeMessage());

      expect(onMessageReceived).not.toHaveBeenCalled();
      expect(onMessageProcessed).not.toHaveBeenCalled();
      expect(deps.logger.warn).toHaveBeenCalled();
    });

    it("unsigned graph-report text on normal inbound passes through both lifecycle callbacks", async () => {
      const onMessageReceived = vi.fn();
      const onMessageProcessed = vi.fn();
      const onGraphReportRequest = vi.fn(async () => {});
      const adapter = makeAdapter();
      const deps = makeDeps({
        adapters: [adapter],
        onMessageReceived,
        onMessageProcessed,
        onGraphReportRequest,
      });
      const manager = createChannelManager(deps);
      await manager.startAll();

      const msg = makeMessage({
        text: "graph:report:abc123",
        metadata: { telegramMessageId: 42, isButtonCallback: true },
      });
      await adapter._handlers[0](msg);

      expect(onGraphReportRequest).not.toHaveBeenCalled();
      expect(onMessageReceived).toHaveBeenCalledWith(msg, "telegram");
      expect(onMessageProcessed).toHaveBeenCalledWith(msg, "telegram");
    });

    it("regression pin: onMessageReceived fires while processing is still in flight", async () => {
      // onMessageReceived must fire while processInboundMessage is still in
      // flight: if the only callback fired AFTER it resolved, a SIGUSR2
      // mid-execution would observe an empty continuation tracker. Wiring
      // tracker.track to onMessageReceived closes that timing window.
      const deferred = (() => {
        let resolveFn: (v: {
          response: string;
          sessionKey: { tenantId: string; userId: string; channelId: string };
          tokensUsed: { input: number; output: number; total: number };
          cost: { total: number };
          stepsExecuted: number;
          finishReason: "stop";
        }) => void = () => {};
        const promise = new Promise<{
          response: string;
          sessionKey: { tenantId: string; userId: string; channelId: string };
          tokensUsed: { input: number; output: number; total: number };
          cost: { total: number };
          stepsExecuted: number;
          finishReason: "stop";
        }>((r) => {
          resolveFn = r;
        });
        return { promise, resolve: resolveFn };
      })();
      const adapter = makeAdapter();
      const executor = makeExecutor({
        execute: vi.fn(() => deferred.promise),
      });
      const onMessageReceived = vi.fn();
      const onMessageProcessed = vi.fn();
      const deps = makeDeps({
        adapters: [adapter],
        createExecutor: vi.fn(() => executor),
        onMessageReceived,
        onMessageProcessed,
      });
      const manager = createChannelManager(deps);
      await manager.startAll();

      const msg = makeMessage();
      const injectPromise = manager.injectMessage("telegram", msg);
      // Yield microtasks so the call reaches await processInboundMessage.
      await Promise.resolve();
      await Promise.resolve();

      // While processing is hung, the continuation-tracker-equivalent
      // (onMessageReceived spy) MUST already have been called -- this is
      // the timing semantic the bug repro requires. onMessageProcessed
      // (which carries recordActivity) MUST NOT have been called yet.
      expect(onMessageReceived).toHaveBeenCalledTimes(1);
      expect(onMessageProcessed).not.toHaveBeenCalled();

      deferred.resolve({
        response: "Agent response text",
        sessionKey: { tenantId: "default", userId: "user-1", channelId: "12345" },
        tokensUsed: { input: 100, output: 50, total: 150 },
        cost: { total: 0.001 },
        stepsExecuted: 0,
        finishReason: "stop",
      });
      await injectPromise;
      expect(onMessageProcessed).toHaveBeenCalledTimes(1);
    });

    it("does not throw when onMessageReceived is undefined", async () => {
      const adapter = makeAdapter();
      // Provide onMessageProcessed only -- onMessageReceived is omitted.
      const deps = makeDeps({
        adapters: [adapter],
        onMessageProcessed: vi.fn(),
      });
      const manager = createChannelManager(deps);
      await manager.startAll();

      // Both code paths must tolerate an undefined onMessageReceived.
      await expect(adapter._handlers[0](makeMessage())).resolves.not.toThrow();
      await expect(manager.injectMessage("telegram", makeMessage())).resolves.not.toThrow();
    });
  });

  describe("stopAll() in-flight drain", () => {
    it("awaits in-flight sendMessage before calling adapter.stop()", async () => {
      const callOrder: string[] = [];
      let resolveSend: () => void = () => {};
      // Stage an in-flight promise via the tracker helper. The Set lives
      // inside the test-only `makeFakeDeliveryServiceWithTracker` —
      // production deps no longer expose an `inFlightSends` injection slot.
      const { service: deliveryService, track } = makeFakeDeliveryServiceWithTracker();
      const sendPromise = new Promise<void>((r) => {
        resolveSend = r;
      });
      track(sendPromise);

      const adapter = makeAdapter({
        stop: vi.fn(async () => {
          callOrder.push("stop");
          return ok(undefined);
        }),
      });
      const deps = makeDeps({ adapters: [adapter], deliveryService });
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
        // Stage the hung send via the tracker helper. `drainInFlight(5000)`
        // races allSettled against a setTimeout(5000) — vi.useFakeTimers +
        // advanceTimersByTimeAsync drive the deadline deterministically.
        const { service: deliveryService, track } = makeFakeDeliveryServiceWithTracker();
        const hung = new Promise<void>(() => {});
        track(hung);

        const stopSpy = vi.fn(async () => ok(undefined));
        const adapter = makeAdapter({ stop: stopSpy });
        const deps = makeDeps({ adapters: [adapter], deliveryService });
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

    it("skips drain log when no sends are in flight", async () => {
      const adapter = makeAdapter();
      // makeFakeDeliveryService.drainInFlight returns
      // `{drained: 0, remaining: 0, durationMs: 0}` by default; channel-manager
      // suppresses the drain INFO when both drained and remaining are zero.
      const deps = makeDeps({ adapters: [adapter] });
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
      // Distinct channelTypes — multi-adapter activeCount accounting must
      // not dedupe these three. With one start() failure, activeCount = 2.
      const adapter2 = makeAdapter({
        channelType: "discord",
        channelId: "discord-fail",
        start: vi.fn(async () => err(new Error("fail"))),
      });
      const adapter3 = makeAdapter({ channelType: "slack", channelId: "slack-good" });
      const deps = makeDeps({ adapters: [adapter1, adapter2, adapter3] });
      const manager = createChannelManager(deps);

      await manager.startAll();

      // 2 succeeded, 1 failed
      expect(manager.activeCount).toBe(2);
    });
  });

  // "prompt skill detection" describe block removed: loadPromptSkill +
  // getUserInvocableSkillNames deps slots removed from ChannelManagerDeps.
  // Production-absent-mode: skill commands now pass through as plain text
  // to the agent.

  describe("command queue enqueue failure logging", () => {
    function makeCommandQueue(enqueueResult: ReturnType<typeof ok> | ReturnType<typeof err>): CommandQueue {
      return {
        enqueue: vi.fn(async (_sk, _msg, _ct, handler) => {
          // Still execute the handler so streaming delivery works
          if (enqueueResult.ok) {
            await handler([makeMessage()], {
              signal: new AbortController().signal,
              receivedAt: 1,
              sourceTerminalScope: {
                publish: () => 0,
                isPublished: false,
              },
              inboundProvenancePlans: [],
            });
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

  describe("credential-rotation targeted reconnect", () => {
    it("does not start or report success when adapter stop returns an error Result", async () => {
      let listener: ((ev: { name: string; action: "upserted" | "removed"; timestamp: number }) => void) | undefined;
      const eventBus = {
        ...makeEventBus(),
        on: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
          if (event === "secret:changed") listener = callback as typeof listener;
          return eventBus;
        }),
      } as any;
      const start = vi.fn(async () => ok(undefined));
      const stop = vi.fn(async () => err(new Error("stop result failed")));
      const adapter = makeAdapter({ channelType: "telegram", start, stop });
      const deps = makeDeps({
        eventBus,
        adapters: [adapter],
        channelCredentialMap: new Map([["TELEGRAM_BOT_TOKEN", "telegram"]]),
      });
      const manager = createChannelManager(deps);
      await manager.startAll();
      vi.clearAllMocks();

      listener?.({ name: "TELEGRAM_BOT_TOKEN", action: "upserted", timestamp: 1 });
      await Promise.resolve();
      await Promise.resolve();

      expect(stop).toHaveBeenCalledOnce();
      expect(start).not.toHaveBeenCalled();
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ errorKind: "platform", hint: expect.any(String) }),
        "Channel adapter reconnect failed after credential rotation",
      );
      expect(deps.logger.info).not.toHaveBeenCalledWith(
        expect.anything(),
        "Channel adapter reconnected after credential rotation",
      );
    });

    it("marks a running adapter inactive when credential restart fails", async () => {
      let listener: ((ev: { name: string; action: "upserted" | "removed"; timestamp: number }) => void) | undefined;
      const eventBus = {
        ...makeEventBus(),
        on: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
          if (event === "secret:changed") listener = callback as typeof listener;
          return eventBus;
        }),
      } as any;
      const start = vi.fn()
        .mockResolvedValueOnce(ok(undefined))
        .mockResolvedValueOnce(err(new Error("start result failed")));
      const stop = vi.fn(async () => ok(undefined));
      const adapter = makeAdapter({ channelType: "telegram", start, stop });
      const deps = makeDeps({
        eventBus,
        adapters: [adapter],
        channelCredentialMap: new Map([["TELEGRAM_BOT_TOKEN", "telegram"]]),
      });
      const manager = createChannelManager(deps);
      await manager.startAll();
      expect(manager.activeCount).toBe(1);
      vi.clearAllMocks();

      listener?.({ name: "TELEGRAM_BOT_TOKEN", action: "upserted", timestamp: 1 });
      await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());

      expect(stop).toHaveBeenCalledOnce();
      expect(manager.activeCount).toBe(0);
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ errorKind: "platform", hint: expect.any(String) }),
        "Channel adapter reconnect failed after credential rotation",
      );
      expect(deps.logger.info).not.toHaveBeenCalledWith(
        expect.anything(),
        "Channel adapter reconnected after credential rotation",
      );
    });

    it("marks an initially failed adapter active after credential reconnect succeeds", async () => {
      let listener: ((ev: { name: string; action: "upserted" | "removed"; timestamp: number }) => void) | undefined;
      const eventBus = {
        ...makeEventBus(),
        on: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
          if (event === "secret:changed") listener = callback as typeof listener;
          return eventBus;
        }),
      } as any;
      const start = vi.fn()
        .mockResolvedValueOnce(err(new Error("initial start failed")))
        .mockResolvedValueOnce(ok(undefined));
      const stop = vi.fn(async () => ok(undefined));
      const adapter = makeAdapter({ channelType: "telegram", start, stop });
      const manager = createChannelManager(makeDeps({
        eventBus,
        adapters: [adapter],
        channelCredentialMap: new Map([["TELEGRAM_BOT_TOKEN", "telegram"]]),
      }));

      await manager.startAll();
      expect(manager.activeCount).toBe(0);
      vi.clearAllMocks();

      listener?.({ name: "TELEGRAM_BOT_TOKEN", action: "upserted", timestamp: 1 });
      await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());

      expect(stop).toHaveBeenCalledOnce();
      expect(manager.activeCount).toBe(1);
    });

    it("serializes repeated credential reconnect events for the same adapter", async () => {
      let listener: ((ev: { name: string; action: "upserted" | "removed"; timestamp: number }) => void) | undefined;
      let releaseFirstStop: (() => void) | undefined;
      const firstStop = new Promise<void>((resolve) => { releaseFirstStop = resolve; });
      const eventBus = {
        ...makeEventBus(),
        on: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
          if (event === "secret:changed") listener = callback as typeof listener;
          return eventBus;
        }),
      } as any;
      const stop = vi.fn()
        .mockImplementationOnce(async () => {
          await firstStop;
          return ok(undefined);
        })
        .mockResolvedValue(ok(undefined));
      const start = vi.fn(async () => ok(undefined));
      const adapter = makeAdapter({ channelType: "telegram", start, stop });
      const manager = createChannelManager(makeDeps({
        eventBus,
        adapters: [adapter],
        channelCredentialMap: new Map([["TELEGRAM_BOT_TOKEN", "telegram"]]),
      }));
      await manager.startAll();
      vi.clearAllMocks();

      listener?.({ name: "TELEGRAM_BOT_TOKEN", action: "upserted", timestamp: 1 });
      listener?.({ name: "TELEGRAM_BOT_TOKEN", action: "upserted", timestamp: 2 });
      await Promise.resolve();

      expect(stop).toHaveBeenCalledOnce();
      releaseFirstStop?.();
      await vi.waitFor(() => {
        expect(stop).toHaveBeenCalledTimes(2);
        expect(start).toHaveBeenCalledTimes(2);
      });
    });

    it("does not resurrect an adapter from credential events after shutdown starts", async () => {
      let listener: ((ev: { name: string; action: "upserted" | "removed"; timestamp: number }) => void) | undefined;
      const eventBus = {
        ...makeEventBus(),
        on: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
          if (event === "secret:changed") listener = callback as typeof listener;
          return eventBus;
        }),
        off: vi.fn().mockReturnThis(),
      } as any;
      const start = vi.fn(async () => ok(undefined));
      const stop = vi.fn(async () => ok(undefined));
      const adapter = makeAdapter({ channelType: "telegram", start, stop });
      const manager = createChannelManager(makeDeps({
        eventBus,
        adapters: [adapter],
        channelCredentialMap: new Map([["TELEGRAM_BOT_TOKEN", "telegram"]]),
      }));
      await manager.startAll();
      await manager.stopAll();
      vi.clearAllMocks();

      listener?.({ name: "TELEGRAM_BOT_TOKEN", action: "upserted", timestamp: 1 });
      await Promise.resolve();
      await Promise.resolve();

      expect(stop).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
    });

    it("rotated channel token triggers targeted stop+start for the matching adapter only", async () => {
      // Capture the secret:changed listener registered by createChannelManager.
      // The makeEventBus() mock records all on() calls — we look up the listener
      // for "secret:changed" and invoke it directly to simulate a rotation event.
      let secretChangedListener: ((ev: { name: string; action: "upserted" | "removed"; timestamp: number }) => void) | undefined;
      const captureEventBus = {
        ...makeEventBus(),
        on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
          if (event === "secret:changed") {
            secretChangedListener = listener as typeof secretChangedListener;
          }
          return captureEventBus;
        }),
      } as any;

      const telegramStop = vi.fn(async () => ok(undefined));
      const telegramStart = vi.fn(async () => ok(undefined));
      const discordStop = vi.fn(async () => ok(undefined));
      const discordStart = vi.fn(async () => ok(undefined));

      const telegramAdapter = makeAdapter({
        channelType: "telegram",
        channelId: "tg-1",
        stop: telegramStop,
        start: telegramStart,
      });
      const discordAdapter = makeAdapter({
        channelType: "discord",
        channelId: "dc-1",
        stop: discordStop,
        start: discordStart,
      });

      // channelCredentialMap: credential name -> channelType
      const channelCredentialMap = new Map([
        ["TELEGRAM_BOT_TOKEN", "telegram"],
        ["DISCORD_BOT_TOKEN", "discord"],
      ]);

      const deps = makeDeps({
        eventBus: captureEventBus,
        adapters: [telegramAdapter, discordAdapter],
        channelCredentialMap,
        processInboundMessage: vi.fn(async () => {}) as unknown as ChannelManagerDeps["processInboundMessage"],
      });

      const manager = createChannelManager(deps);
      await manager.startAll();

      // Sanity: listener was wired
      expect(secretChangedListener).toBeDefined();

      // Clear the start/stop call counts from startAll (start was called once per adapter)
      vi.clearAllMocks();

      // Simulate rotation of TELEGRAM_BOT_TOKEN
      secretChangedListener!({ name: "TELEGRAM_BOT_TOKEN", action: "upserted", timestamp: Date.now() });

      // Yield microtasks so async stop()+start() complete
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Only Telegram adapter reconnected
      expect(telegramStop).toHaveBeenCalledOnce();
      expect(telegramStart).toHaveBeenCalledOnce();
      // Discord adapter must NOT have been reconnected
      expect(discordStop).not.toHaveBeenCalled();
      expect(discordStart).not.toHaveBeenCalled();
    });

    it("credential removal stops the adapter and marks it inactive without restarting", async () => {
      let secretChangedListener: ((ev: { name: string; action: "upserted" | "removed"; timestamp: number }) => void) | undefined;
      const captureEventBus = {
        ...makeEventBus(),
        on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
          if (event === "secret:changed") {
            secretChangedListener = listener as typeof secretChangedListener;
          }
          return captureEventBus;
        }),
      } as any;

      const telegramStop = vi.fn(async () => ok(undefined));
      const telegramStart = vi.fn(async () => ok(undefined));
      const telegramAdapter = makeAdapter({ channelType: "telegram", channelId: "tg-2", stop: telegramStop, start: telegramStart });

      const channelCredentialMap = new Map([["TELEGRAM_BOT_TOKEN", "telegram"]]);
      const deps = makeDeps({
        eventBus: captureEventBus,
        adapters: [telegramAdapter],
        channelCredentialMap,
        processInboundMessage: vi.fn(async () => {}) as unknown as ChannelManagerDeps["processInboundMessage"],
      });

      const manager = createChannelManager(deps);
      await manager.startAll();
      expect(manager.activeCount).toBe(1);
      vi.clearAllMocks();

      secretChangedListener!({ name: "TELEGRAM_BOT_TOKEN", action: "removed", timestamp: Date.now() });
      await vi.waitFor(() => expect(telegramStop).toHaveBeenCalledOnce());

      expect(telegramStart).not.toHaveBeenCalled();
      expect(manager.activeCount).toBe(0);
    });

    it("unknown credential name in secret:changed does not reconnect any adapter", async () => {
      let secretChangedListener: ((ev: { name: string; action: "upserted" | "removed"; timestamp: number }) => void) | undefined;
      const captureEventBus = {
        ...makeEventBus(),
        on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
          if (event === "secret:changed") {
            secretChangedListener = listener as typeof secretChangedListener;
          }
          return captureEventBus;
        }),
      } as any;

      const telegramStop = vi.fn(async () => ok(undefined));
      const telegramStart = vi.fn(async () => ok(undefined));
      const telegramAdapter = makeAdapter({ channelType: "telegram", channelId: "tg-3", stop: telegramStop, start: telegramStart });

      const channelCredentialMap = new Map([["TELEGRAM_BOT_TOKEN", "telegram"]]);
      const deps = makeDeps({
        eventBus: captureEventBus,
        adapters: [telegramAdapter],
        channelCredentialMap,
        processInboundMessage: vi.fn(async () => {}) as unknown as ChannelManagerDeps["processInboundMessage"],
      });

      createChannelManager(deps);
      vi.clearAllMocks();

      // Unknown credential — no adapter matches
      secretChangedListener!({ name: "OPENAI_API_KEY", action: "upserted", timestamp: Date.now() });
      await Promise.resolve();
      await Promise.resolve();

      expect(telegramStop).not.toHaveBeenCalled();
      expect(telegramStart).not.toHaveBeenCalled();
    });
  });

  describe("secret:changed handler is void-synchronous — rejection does not bubble to bus", () => {
    it("adapter.stop() rejection is caught internally and does not propagate as unhandled rejection", async () => {
      let secretChangedListener: ((ev: { name: string; action: "upserted" | "removed"; timestamp: number }) => void) | undefined;
      const captureEventBus = {
        ...makeEventBus(),
        on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
          if (event === "secret:changed") {
            secretChangedListener = listener as typeof secretChangedListener;
          }
          return captureEventBus;
        }),
      } as any;

      const stopError = new Error(
        "stop failed Authorization: Bearer PRIVATE_RECONNECT_SENTINEL",
      );
      const telegramStop = vi.fn(async () => { throw stopError; });
      const telegramStart = vi.fn(async () => ok(undefined));
      const telegramAdapter = makeAdapter({ channelType: "telegram", channelId: "tg-1", stop: telegramStop, start: telegramStart });

      const channelCredentialMap = new Map([["TELEGRAM_BOT_TOKEN", "telegram"]]);
      const deps = makeDeps({
        eventBus: captureEventBus,
        adapters: [telegramAdapter],
        channelCredentialMap,
        processInboundMessage: vi.fn(async () => {}) as unknown as ChannelManagerDeps["processInboundMessage"],
      });

      const manager = createChannelManager(deps);
      await manager.startAll();
      expect(secretChangedListener).toBeDefined();
      vi.clearAllMocks();

      // The listener must return void synchronously — if it returned a rejected
      // Promise, the bus would surface an unhandled rejection. We verify
      // the return value is not a Promise (undefined), and that the rejection is
      // captured internally (warn logged) rather than thrown to the caller.
      const returnValue = secretChangedListener!({ name: "TELEGRAM_BOT_TOKEN", action: "upserted", timestamp: Date.now() });
      expect(returnValue).toBeUndefined();

      // Yield microtasks so the internal async IIFE completes
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // stop() was called and threw — warn was emitted, start() was NOT called
      expect(telegramStop).toHaveBeenCalledOnce();
      expect(telegramStart).not.toHaveBeenCalled();
      const warnCalls = (deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls;
      const reconnectWarn = warnCalls.find((c: any[]) =>
        typeof c[1] === "string" && c[1].includes("Channel adapter reconnect failed"),
      );
      expect(reconnectWarn).toBeDefined();
      expect(typeof reconnectWarn?.[0].err).toBe("string");
      expect(JSON.stringify(reconnectWarn)).not.toContain("PRIVATE_RECONNECT_SENTINEL");
    });
  });

  describe("getRawHandlerCounts()", () => {
    it("reports rawHandlerCount of 1 for a single cleanly wired adapter", async () => {
      const adapter = makeAdapter({ channelType: "echo", channelId: "echo-1" });
      const deps = makeDeps({ adapters: [adapter], channelRegistry: undefined });
      const manager = createChannelManager(deps);

      await manager.startAll();

      const rawCounts = manager.getRawHandlerCounts();
      expect(rawCounts.get("echo")).toBe(1);
    });

    it("reports rawHandlerCount of 2 when same adapter appears in both deps.adapters and channelRegistry (regression wiring), while activeCount remains 1", async () => {
      const adapter = makeAdapter({ channelType: "echo", channelId: "echo-reg" });
      // Simulate regression: same adapter instance in both slots
      const regressionRegistry = {
        ...makeFakeChannelRegistry(),
        getChannelPlugins: () => [{ adapter, capabilities: {} }],
      };
      const deps = makeDeps({
        adapters: [adapter],
        channelRegistry: regressionRegistry,
      });
      const manager = createChannelManager(deps);

      await manager.startAll();

      const rawCounts = manager.getRawHandlerCounts();
      expect(rawCounts.get("echo")).toBe(2);
      // post-dedup activeCount is still 1 (same instance, silently deduped)
      expect(manager.activeCount).toBe(1);
    });
  });
});
