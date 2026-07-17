// SPDX-License-Identifier: Apache-2.0
import type {
  ChannelPort,
  DeliveryService,
  NormalizedMessage,
  PerChannelStreamingConfig,
  SessionKey,
  TurnOutcome,
} from "@comis/core";
import type { AgentExecutor } from "@comis/agent";
import type { SendOverrideStore } from "@comis/channels";
import { ok } from "@comis/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const channelDeliveryMocks = vi.hoisted(() => ({
  deliverOutboundMedia: vi.fn(),
  executeVoiceResponse: vi.fn(),
}));

vi.mock("@comis/channels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/channels")>();
  return {
    ...actual,
    deliverOutboundMedia: channelDeliveryMocks.deliverOutboundMedia,
    executeVoiceResponse: channelDeliveryMocks.executeVoiceResponse,
  };
});

import {
  executeAndDeliver,
  type ExecutionPipelineDeps,
} from "./execution-pipeline.js";
import {
  createSourceTerminalScope,
  mergeSourceTerminalScopes,
} from "../source-message-terminal.js";

function makeMessage(): NormalizedMessage {
  return {
    id: "00000000-0000-0000-0000-000000000111",
    channelId: "chat-1",
    channelType: "telegram",
    senderId: "user-1",
    text: "Reply without text delivery",
    timestamp: 1_000,
    attachments: [],
    metadata: {},
  };
}

function makeSessionKey(): SessionKey {
  return {
    tenantId: "tenant",
    userId: "user-1",
    channelId: "chat-1",
  };
}

function makeAdapter(): ChannelPort {
  return {
    channelId: "telegram-adapter",
    channelType: "telegram",
    start: vi.fn(async () => ok(undefined)),
    stop: vi.fn(async () => ok(undefined)),
    onMessage: vi.fn(),
    sendMessage: vi.fn(async () => ok("text-message-1")),
    sendAttachment: vi.fn(async () =>
      ok({ kind: "tracked" as const, messageId: "attachment-message-1" })
    ),
  } as unknown as ChannelPort;
}

function makeExecutor(response: string): AgentExecutor {
  return {
    execute: vi.fn(async () => ({
      response,
      sessionKey: makeSessionKey(),
      tokensUsed: { input: 10, output: 5, total: 15 },
      cost: { total: 0.01 },
      stepsExecuted: 2,
      llmCalls: 3,
      finishReason: "stop" as const,
    })),
  } as unknown as AgentExecutor;
}

function makeEventBus() {
  const emit = vi.fn(() => true);
  const eventBus = {
    emit,
    emitSafely: vi.fn((event: string, payload: unknown) => {
      const hadListeners = emit(event, payload);
      return { hadListeners, failures: [] };
    }),
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
    removeAllListeners: vi.fn(),
    listenerCount: vi.fn(() => 0),
    setMaxListeners: vi.fn(),
  };
  eventBus.on.mockReturnValue(eventBus);
  eventBus.off.mockReturnValue(eventBus);
  eventBus.once.mockReturnValue(eventBus);
  eventBus.removeAllListeners.mockReturnValue(eventBus);
  eventBus.setMaxListeners.mockReturnValue(eventBus);
  return eventBus;
}

function makeDeliveryService(): DeliveryService {
  return {
    deliverToChannel: vi.fn(async () => ok({
      ok: true,
      totalChunks: 1,
      deliveredChunks: 1,
      failedChunks: 0,
      chunks: [{
        ok: true,
        messageId: "text-message-1",
        charCount: 1,
        retried: false,
      }],
      totalChars: 1,
    })),
    drainInFlight: vi.fn(async () => ({
      drained: 0,
      remaining: 0,
      durationMs: 0,
    })),
  } as DeliveryService;
}

function makeStreamingConfig(): PerChannelStreamingConfig {
  return {
    enabled: true,
    chunkMode: "paragraph",
    chunkMinChars: 100,
    deliveryTiming: {
      mode: "custom",
      minMs: 0,
      maxMs: 0,
      jitterMs: 0,
      firstBlockDelayMs: 0,
    },
    coalescer: {
      minChars: 0,
      maxChars: 500,
      idleMs: 1_500,
      codeBlockPolicy: "standalone",
      adaptiveIdle: false,
    },
    typingMode: "thinking",
    typingRefreshMs: 6_000,
    typingCircuitBreakerThreshold: 3,
    typingTtlMs: 60_000,
    useMarkdownIR: true,
    tableMode: "code",
    replyMode: "first",
  };
}

function makeSendOverrides(): SendOverrideStore {
  return {
    get: vi.fn(() => "inherit"),
    set: vi.fn(),
    delete: vi.fn(),
  };
}

function makeHarness(overrides: Partial<ExecutionPipelineDeps> = {}) {
  const eventBus = makeEventBus();
  const finalize = vi.fn<(outcome: TurnOutcome) => Promise<void>>(async () => undefined);
  const dispose = vi.fn();
  const deps: ExecutionPipelineDeps = {
    eventBus: eventBus as unknown as ExecutionPipelineDeps["eventBus"],
    logger: {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      audit: vi.fn(),
      child: vi.fn(),
    } as unknown as ExecutionPipelineDeps["logger"],
    deliveryService: makeDeliveryService(),
    activityStreamPort: {} as ExecutionPipelineDeps["activityStreamPort"],
    coordinatorFactory: () => ({
      start: vi.fn(),
      finalize,
      dispose,
      counters: vi.fn(() => ({})),
    }),
    ...overrides,
  };
  return { deps, dispose, eventBus, finalize };
}

function diagnosticPayload(eventBus: ReturnType<typeof makeEventBus>): Record<string, unknown> {
  const call = eventBus.emit.mock.calls.find(
    ([event]) => event === "diagnostic:message_processed",
  );
  expect(call).toBeDefined();
  return call?.[1] as unknown as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  channelDeliveryMocks.executeVoiceResponse.mockResolvedValue(
    ok({ voiceSent: false }),
  );
  channelDeliveryMocks.deliverOutboundMedia.mockResolvedValue({
    delivered: 0,
    failed: 0,
  });
});

describe("execution pipeline successful non-text delivery outcomes", () => {
  it("finalizes a successful voice-only reply as delivered instead of silent", async () => {
    channelDeliveryMocks.executeVoiceResponse.mockResolvedValue(
      ok({
        voiceSent: true,
        receipt: { kind: "tracked", messageId: "voice-platform-1" },
      }),
    );
    const msg = makeMessage();
    const adapter = makeAdapter();
    const { deps, eventBus, finalize } = makeHarness({
      voiceResponsePipeline: {} as ExecutionPipelineDeps["voiceResponsePipeline"],
    });

    await executeAndDeliver(
      deps,
      adapter,
      msg,
      msg,
      makeExecutor("Spoken answer"),
      makeSessionKey(),
      "agent-1",
      makeStreamingConfig(),
      new Set(),
      makeSendOverrides(),
    );

    expect(adapter.sendMessage).not.toHaveBeenCalled();
    expect(eventBus.emit).toHaveBeenCalledWith("message:sent", {
      channelType: "telegram",
      channelId: "chat-1",
      messageId: "voice-platform-1",
      content: "Spoken answer",
      sourceChannelType: "telegram",
      sourceChannelId: "chat-1",
      sourceMessageId: msg.id,
    });
    expect(eventBus.emit).not.toHaveBeenCalledWith(
      "response:filtered",
      expect.anything(),
    );
    expect(eventBus.emit.mock.calls.filter(
      ([event]) => event === "message:terminal",
    )).toHaveLength(1);
    expect(diagnosticPayload(eventBus)).toMatchObject({
      status: "success",
      toolCalls: 2,
      llmCalls: 3,
      finishReason: "stop",
    });
    expect(finalize).toHaveBeenCalledOnce();
    expect(finalize).toHaveBeenCalledWith({
      kind: "success",
      trivial: false,
      delivery: {
        ok: true,
        deliveredChunks: 1,
        lastChunkMessageId: "voice-platform-1",
        deliveredAtMs: expect.any(Number),
      },
    });
  });

  it("does not text-fallback or emit a synthetic event after untracked voice delivery", async () => {
    channelDeliveryMocks.executeVoiceResponse.mockResolvedValue(
      ok({
        voiceSent: true,
        receipt: { kind: "delivered_untracked" },
      }),
    );
    const msg = makeMessage();
    const adapter = makeAdapter();
    const { deps, eventBus, finalize } = makeHarness({
      voiceResponsePipeline: {} as ExecutionPipelineDeps["voiceResponsePipeline"],
    });

    await executeAndDeliver(
      deps,
      adapter,
      msg,
      msg,
      makeExecutor("Spoken answer"),
      makeSessionKey(),
      "agent-1",
      makeStreamingConfig(),
      new Set(),
      makeSendOverrides(),
    );

    expect(adapter.sendMessage).not.toHaveBeenCalled();
    expect(eventBus.emit).not.toHaveBeenCalledWith(
      "message:sent",
      expect.anything(),
    );
    expect(diagnosticPayload(eventBus)).toMatchObject({ status: "success" });
    expect(eventBus.emit).toHaveBeenCalledWith("message:terminal", {
      channelType: "telegram",
      channelId: "chat-1",
      sourceMessageId: msg.id,
      outcome: "success",
      reason: "execution_completed",
      timestamp: expect.any(Number),
    });
    expect(finalize).toHaveBeenCalledWith({
      kind: "success",
      trivial: false,
      delivery: {
        ok: true,
        deliveredChunks: 1,
        deliveredAtMs: expect.any(Number),
      },
    });
  });

  it("terminalizes every queue-owned source in a coalesced untracked delivery", async () => {
    channelDeliveryMocks.executeVoiceResponse.mockResolvedValue(
      ok({
        voiceSent: true,
        receipt: { kind: "delivered_untracked" },
      }),
    );
    const msg = makeMessage();
    const firstId = "00000000-0000-0000-0000-000000000121";
    const secondId = "00000000-0000-0000-0000-000000000122";
    msg.originalMessages = [
      {
        id: firstId,
        channelId: msg.channelId,
        channelType: msg.channelType,
        senderId: msg.senderId,
        text: "first",
        timestamp: 900,
      },
      {
        id: secondId,
        channelId: msg.channelId,
        channelType: msg.channelType,
        senderId: msg.senderId,
        text: "second",
        timestamp: 950,
      },
    ];
    const { deps, eventBus } = makeHarness({
      voiceResponsePipeline: {} as ExecutionPipelineDeps["voiceResponsePipeline"],
    });
    const sourceTerminalScope = mergeSourceTerminalScopes([
      createSourceTerminalScope(
        deps,
        { ...msg, id: firstId },
        "telegram",
      ),
      createSourceTerminalScope(
        deps,
        { ...msg, id: secondId },
        "telegram",
      ),
    ]);

    await executeAndDeliver(
      deps,
      makeAdapter(),
      msg,
      msg,
      makeExecutor("Spoken answer"),
      makeSessionKey(),
      "agent-1",
      makeStreamingConfig(),
      new Set(),
      makeSendOverrides(),
      undefined,
      undefined,
      undefined,
      sourceTerminalScope,
    );

    const terminalSourceIds = eventBus.emit.mock.calls
      .filter(([event]) => event === "message:terminal")
      .map(([, payload]) => (payload as { sourceMessageId: string }).sourceMessageId);
    expect(terminalSourceIds).toEqual([firstId, secondId]);
    expect(terminalSourceIds).not.toContain(msg.id);
  });

  it("finalizes a successful media-only reply as delivered instead of silent", async () => {
    channelDeliveryMocks.deliverOutboundMedia.mockResolvedValue({
      delivered: 2,
      failed: 0,
      lastReceipt: { kind: "tracked", messageId: "media-platform-2" },
    });
    const msg = makeMessage();
    const adapter = makeAdapter();
    const { deps, eventBus, finalize } = makeHarness({
      parseOutboundMedia: vi.fn(() => ({
        text: "",
        mediaUrls: [
          "https://example.com/image-1.png",
          "https://example.com/image-2.png",
        ],
      })),
      outboundMediaFetch: vi.fn(async () => ok({
        buffer: Buffer.from("image"),
        mimeType: "image/png",
      })),
    });

    await executeAndDeliver(
      deps,
      adapter,
      msg,
      msg,
      makeExecutor(
        "MEDIA: https://example.com/image-1.png\nMEDIA: https://example.com/image-2.png",
      ),
      makeSessionKey(),
      "agent-1",
      makeStreamingConfig(),
      new Set(),
      makeSendOverrides(),
    );

    expect(adapter.sendMessage).not.toHaveBeenCalled();
    expect(channelDeliveryMocks.deliverOutboundMedia).toHaveBeenCalledOnce();
    expect(eventBus.emit).toHaveBeenCalledWith("message:sent", {
      channelType: "telegram",
      channelId: "chat-1",
      messageId: "media-platform-2",
      content: "",
      sourceChannelType: "telegram",
      sourceChannelId: "chat-1",
      sourceMessageId: msg.id,
    });
    expect(eventBus.emit).not.toHaveBeenCalledWith(
      "response:filtered",
      expect.anything(),
    );
    expect(diagnosticPayload(eventBus)).toMatchObject({
      status: "success",
      toolCalls: 2,
      llmCalls: 3,
      finishReason: "stop",
    });
    expect(finalize).toHaveBeenCalledOnce();
    expect(finalize).toHaveBeenCalledWith({
      kind: "success",
      trivial: false,
      delivery: {
        ok: true,
        deliveredChunks: 2,
        lastChunkMessageId: "media-platform-2",
        deliveredAtMs: expect.any(Number),
      },
    });
  });

  it("finalizes untracked media-only delivery without a synthetic message event", async () => {
    channelDeliveryMocks.deliverOutboundMedia.mockResolvedValue({
      delivered: 1,
      failed: 0,
      lastReceipt: { kind: "delivered_untracked" },
    });
    const msg = makeMessage();
    const adapter = makeAdapter();
    const { deps, eventBus, finalize } = makeHarness({
      parseOutboundMedia: vi.fn(() => ({
        text: "",
        mediaUrls: ["https://example.com/image.png"],
      })),
      outboundMediaFetch: vi.fn(async () => ok({
        buffer: Buffer.from("image"),
        mimeType: "image/png",
      })),
    });

    await executeAndDeliver(
      deps,
      adapter,
      msg,
      msg,
      makeExecutor("MEDIA: https://example.com/image.png"),
      makeSessionKey(),
      "agent-1",
      makeStreamingConfig(),
      new Set(),
      makeSendOverrides(),
    );

    expect(adapter.sendMessage).not.toHaveBeenCalled();
    expect(eventBus.emit).not.toHaveBeenCalledWith(
      "message:sent",
      expect.anything(),
    );
    expect(diagnosticPayload(eventBus)).toMatchObject({ status: "success" });
    expect(eventBus.emit).toHaveBeenCalledWith("message:terminal", {
      channelType: "telegram",
      channelId: "chat-1",
      sourceMessageId: msg.id,
      outcome: "success",
      reason: "execution_completed",
      timestamp: expect.any(Number),
    });
    expect(finalize).toHaveBeenCalledWith({
      kind: "success",
      trivial: false,
      delivery: {
        ok: true,
        deliveredChunks: 1,
        deliveredAtMs: expect.any(Number),
      },
    });
  });

  it("finalizes media-only attachment failures with an aggregated delivery receipt", async () => {
    channelDeliveryMocks.deliverOutboundMedia.mockResolvedValue({
      delivered: 1,
      failed: 2,
      lastReceipt: { kind: "tracked", messageId: "media-platform-1" },
    });
    const msg = makeMessage();
    const { deps, eventBus, finalize } = makeHarness({
      parseOutboundMedia: vi.fn(() => ({
        text: "",
        mediaUrls: [
          "https://example.com/image-1.png",
          "https://example.com/image-2.png",
          "https://example.com/image-3.png",
        ],
      })),
      outboundMediaFetch: vi.fn(async () => ok({
        buffer: Buffer.from("image"),
        mimeType: "image/png",
      })),
    });

    await executeAndDeliver(
      deps,
      makeAdapter(),
      msg,
      msg,
      makeExecutor("three media directives without a caption"),
      makeSessionKey(),
      "agent-1",
      makeStreamingConfig(),
      new Set(),
      makeSendOverrides(),
    );

    expect(finalize).toHaveBeenCalledOnce();
    expect(diagnosticPayload(eventBus)).toMatchObject({
      status: "error",
      failureStage: "delivery",
      errorKind: "platform",
    });
    expect(finalize).toHaveBeenCalledWith({
      kind: "failure",
      errorKind: "platform",
      failedEvents: [],
      deliveryReceipt: {
        ok: false,
        totalChunks: 3,
        deliveredChunks: 1,
        failedChunks: 2,
        errorKind: "platform",
        lastError: "Outbound media delivery failed",
        failedAtMs: expect.any(Number),
      },
    });
  });

  it("combines a failed media send and delivered caption in one delivery receipt", async () => {
    channelDeliveryMocks.deliverOutboundMedia.mockResolvedValue({
      delivered: 1,
      failed: 1,
      lastReceipt: { kind: "tracked", messageId: "media-platform-1" },
    });
    const msg = makeMessage();
    const { deps, eventBus, finalize } = makeHarness({
      parseOutboundMedia: vi.fn(() => ({
        text: "Caption delivered after the media attempts",
        mediaUrls: [
          "https://example.com/image-1.png",
          "https://example.com/image-2.png",
        ],
      })),
      outboundMediaFetch: vi.fn(async () => ok({
        buffer: Buffer.from("image"),
        mimeType: "image/png",
      })),
    });

    await executeAndDeliver(
      deps,
      makeAdapter(),
      msg,
      msg,
      makeExecutor("media directives with a caption"),
      makeSessionKey(),
      "agent-1",
      makeStreamingConfig(),
      new Set(),
      makeSendOverrides(),
    );

    expect(finalize).toHaveBeenCalledOnce();
    expect(diagnosticPayload(eventBus)).toMatchObject({
      status: "error",
      failureStage: "delivery",
      errorKind: "platform",
    });
    expect(finalize).toHaveBeenCalledWith({
      kind: "failure",
      errorKind: "platform",
      failedEvents: [],
      deliveryReceipt: {
        ok: false,
        totalChunks: 3,
        deliveredChunks: 2,
        failedChunks: 1,
        errorKind: "platform",
        lastError: "Outbound media delivery failed",
        failedAtMs: expect.any(Number),
      },
    });
  });

  it("uses the voice platform id as the last receipt after media then voice delivery", async () => {
    channelDeliveryMocks.deliverOutboundMedia.mockResolvedValue({
      delivered: 2,
      failed: 0,
      lastReceipt: { kind: "tracked", messageId: "media-platform-2" },
    });
    channelDeliveryMocks.executeVoiceResponse.mockResolvedValue(
      ok({
        voiceSent: true,
        receipt: { kind: "tracked", messageId: "voice-platform-3" },
      }),
    );
    const msg = makeMessage();
    const { deps, eventBus, finalize } = makeHarness({
      parseOutboundMedia: vi.fn(() => ({
        text: "Spoken caption",
        mediaUrls: [
          "https://example.com/image-1.png",
          "https://example.com/image-2.png",
        ],
      })),
      outboundMediaFetch: vi.fn(async () => ok({
        buffer: Buffer.from("image"),
        mimeType: "image/png",
      })),
      voiceResponsePipeline: {} as ExecutionPipelineDeps["voiceResponsePipeline"],
    });

    await executeAndDeliver(
      deps,
      makeAdapter(),
      msg,
      msg,
      makeExecutor("media directives with a spoken caption"),
      makeSessionKey(),
      "agent-1",
      makeStreamingConfig(),
      new Set(),
      makeSendOverrides(),
    );

    expect(eventBus.emit).toHaveBeenCalledWith("message:sent", {
      channelType: "telegram",
      channelId: "chat-1",
      messageId: "voice-platform-3",
      content: "Spoken caption",
      sourceChannelType: "telegram",
      sourceChannelId: "chat-1",
      sourceMessageId: msg.id,
    });
    expect(finalize).toHaveBeenCalledWith({
      kind: "success",
      trivial: false,
      delivery: {
        ok: true,
        deliveredChunks: 3,
        lastChunkMessageId: "voice-platform-3",
        deliveredAtMs: expect.any(Number),
      },
    });
  });
});

describe("execution pipeline queue-abort delivery boundaries", () => {
  it("skips filter, media, voice, and text delivery after a non-cooperative executor returns", async () => {
    const controller = new AbortController();
    const executor = makeExecutor("late response");
    vi.mocked(executor.execute).mockImplementationOnce(async () => {
      controller.abort("queue_aborted");
      return {
        response: "late response",
        sessionKey: makeSessionKey(),
        tokensUsed: { input: 10, output: 5, total: 15 },
        cost: { total: 0.01 },
        stepsExecuted: 2,
        llmCalls: 3,
        finishReason: "stop" as const,
      };
    });
    const parseOutboundMedia = vi.fn(() => ({
      text: "late response",
      mediaUrls: ["https://example.com/late.png"],
    }));
    const { deps, eventBus, finalize } = makeHarness({
      parseOutboundMedia,
      outboundMediaFetch: vi.fn(),
      voiceResponsePipeline: {} as ExecutionPipelineDeps["voiceResponsePipeline"],
    });

    await executeAndDeliver(
      deps,
      makeAdapter(),
      makeMessage(),
      makeMessage(),
      executor,
      makeSessionKey(),
      "agent-1",
      makeStreamingConfig(),
      new Set(),
      makeSendOverrides(),
      undefined,
      undefined,
      undefined,
      undefined,
      controller.signal,
    );

    expect(parseOutboundMedia).not.toHaveBeenCalled();
    expect(channelDeliveryMocks.deliverOutboundMedia).not.toHaveBeenCalled();
    expect(channelDeliveryMocks.executeVoiceResponse).not.toHaveBeenCalled();
    expect(deps.deliveryService.deliverToChannel).not.toHaveBeenCalled();
    expect(diagnosticPayload(eventBus)).toMatchObject({ status: "aborted" });
    expect(finalize).toHaveBeenCalledWith({
      kind: "aborted",
      reason: "user_cancel",
    });
  });

  it("stops voice and text delivery when the queue aborts during media delivery", async () => {
    const controller = new AbortController();
    channelDeliveryMocks.deliverOutboundMedia.mockImplementationOnce(async (
      _urls: string[],
      mediaDeps: { signal?: AbortSignal },
    ) => {
      expect(mediaDeps.signal).toBe(controller.signal);
      controller.abort("queue_aborted");
      return { delivered: 0, failed: 0 };
    });
    const { deps, eventBus, finalize } = makeHarness({
      parseOutboundMedia: vi.fn(() => ({
        text: "caption must not be sent",
        mediaUrls: ["https://example.com/late.png"],
      })),
      outboundMediaFetch: vi.fn(),
      voiceResponsePipeline: {} as ExecutionPipelineDeps["voiceResponsePipeline"],
    });

    await executeAndDeliver(
      deps,
      makeAdapter(),
      makeMessage(),
      makeMessage(),
      makeExecutor("media response"),
      makeSessionKey(),
      "agent-1",
      makeStreamingConfig(),
      new Set(),
      makeSendOverrides(),
      undefined,
      undefined,
      undefined,
      undefined,
      controller.signal,
    );

    expect(channelDeliveryMocks.executeVoiceResponse).not.toHaveBeenCalled();
    expect(deps.deliveryService.deliverToChannel).not.toHaveBeenCalled();
    expect(diagnosticPayload(eventBus)).toMatchObject({ status: "aborted" });
    expect(finalize).toHaveBeenCalledWith({
      kind: "aborted",
      reason: "user_cancel",
    });
  });

  it("stops text delivery when the queue aborts during voice preparation", async () => {
    const controller = new AbortController();
    channelDeliveryMocks.executeVoiceResponse.mockImplementationOnce(async (
      _deps: unknown,
      voiceContext: { signal?: AbortSignal },
    ) => {
      expect(voiceContext.signal).toBe(controller.signal);
      controller.abort("queue_aborted");
      return ok({ voiceSent: false });
    });
    const { deps, eventBus, finalize } = makeHarness({
      voiceResponsePipeline: {} as ExecutionPipelineDeps["voiceResponsePipeline"],
    });

    await executeAndDeliver(
      deps,
      makeAdapter(),
      makeMessage(),
      makeMessage(),
      makeExecutor("voice fallback must not be sent"),
      makeSessionKey(),
      "agent-1",
      makeStreamingConfig(),
      new Set(),
      makeSendOverrides(),
      undefined,
      undefined,
      undefined,
      undefined,
      controller.signal,
    );

    expect(deps.deliveryService.deliverToChannel).not.toHaveBeenCalled();
    expect(diagnosticPayload(eventBus)).toMatchObject({ status: "aborted" });
    expect(finalize).toHaveBeenCalledWith({
      kind: "aborted",
      reason: "user_cancel",
    });
  });
});
