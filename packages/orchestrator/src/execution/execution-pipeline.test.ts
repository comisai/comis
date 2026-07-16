// SPDX-License-Identifier: Apache-2.0
import type { ChannelPort, NormalizedMessage, SessionKey, DeliveryService } from "@comis/core";
import type { PerChannelStreamingConfig, StreamingConfig } from "@comis/core";
import { StreamingConfigSchema, PerChannelStreamingConfigSchema } from "@comis/core";
import type { AgentExecutor } from "@comis/agent";
// Queue types live in orchestrator. Relative paths used because orchestrator
// cannot import its own published name.
import { ok } from "@comis/shared";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import type {
  TypingController,
  TypingLifecycleController,
  SendOverrideStore,
  BlockPacer,
  PacerConfig,
} from "@comis/channels";

// Mock createBlockPacer to capture config and control delivery behavior.
// block-pacer.ts lives in @comis/channels (bucket-A internal) — see
// packages/orchestrator/HELPER-OWNERSHIP-INVENTORY.md.
let capturedPacerConfig: PacerConfig | undefined;
vi.mock("@comis/channels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/channels")>();
  return {
    ...actual,
    createBlockPacer: vi.fn((config: PacerConfig) => {
      capturedPacerConfig = config;
      return {
        deliver: vi.fn(async (blocks: string[], send: (text: string) => Promise<void>) => {
          for (const b of blocks) await send(b);
        }),
        cancel: vi.fn(),
      };
    }),
  };
});

import {
  resolveStreamingConfig,
  executeAndDeliver,
  THREAD_PROPAGATION_KEYS,
  type ExecutionPipelineDeps,
} from "./execution-pipeline.js";
import { tryGetContext, runWithContext, systemNowMs } from "@comis/core";
import { TELEGRAM_THREAD_META_KEYS } from "@comis/channels";

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

function makeAdapter(overrides?: Partial<ChannelPort>): ChannelPort {
  return {
    channelId: "telegram-123",
    channelType: "telegram",
    start: vi.fn(async () => ok(undefined)),
    stop: vi.fn(async () => ok(undefined)),
    sendMessage: vi.fn(async () => ok("msg-99")),
    editMessage: vi.fn(async () => ok(undefined)),
    onMessage: vi.fn(),
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
      llmCalls: 1,
      finishReason: "stop" as const,
    })),
    ...overrides,
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

// ExecutionPipelineDeps requires a DeliveryService. The fake delegates to
// adapter.sendMessage so the existing assertions (which observe adapter call
// shape — replyTo, threadId, extra, per-block chunking) remain valid.
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
    // DeliveryService exposes drainInFlight(). Default fake returns empty
    // drain telemetry; tests that exercise drain semantics override this
    // field.
    drainInFlight: vi.fn(async () => ({ drained: 0, remaining: 0, durationMs: 0 })),
  };
}

function makeDeps(overrides?: Partial<ExecutionPipelineDeps>): ExecutionPipelineDeps {
  return {
    eventBus: makeEventBus(),
    logger: createMockLogger(),
    deliveryService: makeFakeDeliveryService(),
    ...overrides,
  };
}

function makeBlockStreamCfg(overrides?: Partial<PerChannelStreamingConfig>): PerChannelStreamingConfig {
  return {
    enabled: true,
    chunkMode: "paragraph",
    chunkMinChars: 100,
    deliveryTiming: { mode: "custom", minMs: 0, maxMs: 0, jitterMs: 0, firstBlockDelayMs: 0 },
    coalescer: { minChars: 0, maxChars: 500, idleMs: 1500, codeBlockPolicy: "standalone", adaptiveIdle: false },
    typingMode: "thinking",
    typingRefreshMs: 6000,
    useMarkdownIR: true,
    tableMode: "code",
    replyMode: "first",
    ...overrides,
  };
}

function makeSessionKey(overrides?: Partial<SessionKey>): SessionKey {
  return {
    tenantId: "default",
    userId: "user-1",
    channelId: "12345",
    ...overrides,
  };
}

function makeSendOverrides(): SendOverrideStore {
  const map = new Map<string, "on" | "off" | "inherit">();
  return {
    get: vi.fn((key: string) => map.get(key) ?? "inherit"),
    set: vi.fn((key: string, val: "on" | "off" | "inherit") => { map.set(key, val); }),
    delete: vi.fn((key: string) => { map.delete(key); }),
  };
}

function makeTypingCtrl(overrides?: Partial<TypingController>): TypingController {
  let active = false;
  let started = 0;
  let sealedState = false;
  return {
    get isActive() { return active; },
    get startedAt() { return started; },
    get isSealed() { return sealedState; },
    start: vi.fn(() => { active = true; started = Date.now(); }),
    stop: vi.fn(() => { active = false; sealedState = true; }),
    refreshTtl: vi.fn(),
    ...overrides,
  };
}

function makeTypingLifecycle(ctrl?: TypingController): { lifecycle: TypingLifecycleController; ctrl: TypingController } {
  const typingCtrl = ctrl ?? makeTypingCtrl();
  const lifecycle: TypingLifecycleController = {
    get controller() { return typingCtrl; },
    markRunComplete: vi.fn(),
    markDispatchIdle: vi.fn(),
    dispose: vi.fn(() => { typingCtrl.stop(); }),
  };
  return { lifecycle, ctrl: typingCtrl };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveStreamingConfig", () => {
  it("returns hardcoded defaults when no streamingConfig is provided", () => {
    const cfg = resolveStreamingConfig("telegram");
    expect(cfg).toEqual({
      enabled: true,
      chunkMode: "paragraph",
      chunkMinChars: 100,
      deliveryTiming: { mode: "natural", minMs: 800, maxMs: 2500, jitterMs: 200, firstBlockDelayMs: 0 },
      coalescer: { minChars: 0, maxChars: 500, idleMs: 1500, codeBlockPolicy: "standalone", adaptiveIdle: false },
      typingMode: "thinking",
      typingRefreshMs: 6000,
      typingCircuitBreakerThreshold: 3,
      typingTtlMs: 60000,
      useMarkdownIR: true,
      tableMode: "code",
      replyMode: "first",
    });
  });

  it("returns per-channel override when it exists", () => {
    const perChannelCfg: PerChannelStreamingConfig = {
      enabled: false,
      chunkMode: "sentence",
      chunkMinChars: 50,
      deliveryTiming: { mode: "custom", minMs: 200, maxMs: 600, jitterMs: 200, firstBlockDelayMs: 0 },
      coalescer: { minChars: 0, maxChars: 300, idleMs: 1500, codeBlockPolicy: "standalone", adaptiveIdle: false },
      typingMode: "message",
      typingRefreshMs: 3000,
      useMarkdownIR: true,
      tableMode: "split",
      replyMode: "first",
    };
    const streamingConfig: StreamingConfig = {
      enabled: true,
      defaultChunkMode: "paragraph",
      defaultDeliveryTiming: { mode: "natural", minMs: 800, maxMs: 2500, jitterMs: 200, firstBlockDelayMs: 0 },
      defaultCoalescer: { minChars: 0, maxChars: 500, idleMs: 1500, codeBlockPolicy: "standalone", adaptiveIdle: false },
      defaultTypingMode: "thinking",
      defaultTypingRefreshMs: 6000,
      defaultUseMarkdownIR: false,
      defaultTableMode: "code",
      defaultReplyMode: "first",
      perChannel: { telegram: perChannelCfg },
    };
    const result = resolveStreamingConfig("telegram", streamingConfig);
    expect(result).toBe(perChannelCfg);
  });

  it("falls back to global defaults when no per-channel override exists", () => {
    const streamingConfig: StreamingConfig = {
      enabled: false,
      defaultChunkMode: "newline",
      defaultChunkMinChars: 100,
      defaultDeliveryTiming: { mode: "custom", minMs: 500, maxMs: 1500, jitterMs: 200, firstBlockDelayMs: 0 },
      defaultCoalescer: { minChars: 0, maxChars: 500, idleMs: 1500, codeBlockPolicy: "standalone", adaptiveIdle: false },
      defaultTypingMode: "message",
      defaultTypingRefreshMs: 4000,
      defaultTypingCircuitBreakerThreshold: 3,
      defaultTypingTtlMs: 60000,
      defaultUseMarkdownIR: true,
      defaultTableMode: "split",
      defaultReplyMode: "first",
      perChannel: {},
    };
    const result = resolveStreamingConfig("discord", streamingConfig);
    expect(result).toEqual({
      enabled: false,
      chunkMode: "newline",
      chunkMinChars: 100,
      deliveryTiming: { mode: "custom", minMs: 500, maxMs: 1500, jitterMs: 200, firstBlockDelayMs: 0 },
      coalescer: { minChars: 0, maxChars: 500, idleMs: 1500, codeBlockPolicy: "standalone", adaptiveIdle: false },
      typingMode: "message",
      typingRefreshMs: 4000,
      typingCircuitBreakerThreshold: 3,
      typingTtlMs: 60000,
      useMarkdownIR: true,
      tableMode: "split",
      replyMode: "first",
    });
  });
});

describe("resolveStreamingConfig + StreamingConfigSchema defaults", () => {
  describe("schema-level defaults", () => {
    it("StreamingConfigSchema.parse({}) returns defaultChunkMinChars === 100", () => {
      const config = StreamingConfigSchema.parse({});
      expect(config.defaultChunkMinChars).toBe(100);
    });

    it("StreamingConfigSchema.parse({}) returns defaultTypingCircuitBreakerThreshold === 3", () => {
      const config = StreamingConfigSchema.parse({});
      expect(config.defaultTypingCircuitBreakerThreshold).toBe(3);
    });

    it("StreamingConfigSchema.parse({}) returns defaultTypingTtlMs === 60000", () => {
      const config = StreamingConfigSchema.parse({});
      expect(config.defaultTypingTtlMs).toBe(60000);
    });
  });

  describe("default branch — no global streaming config provided", () => {
    it("resolveStreamingConfig('telegram', undefined).chunkMinChars === 100", () => {
      const resolved = resolveStreamingConfig("telegram", undefined);
      expect(resolved.chunkMinChars).toBe(100);
    });

    it("resolveStreamingConfig('telegram', undefined).typingCircuitBreakerThreshold === 3", () => {
      const resolved = resolveStreamingConfig("telegram", undefined);
      expect(resolved.typingCircuitBreakerThreshold).toBe(3);
    });

    it("resolveStreamingConfig('telegram', undefined).typingTtlMs === 60000", () => {
      const resolved = resolveStreamingConfig("telegram", undefined);
      expect(resolved.typingTtlMs).toBe(60000);
    });
  });

  describe("global branch — YAML defaultChunkMinChars: 50 propagates through resolver", () => {
    it("defaultChunkMinChars: 50 propagates to chunkMinChars on resolved per-channel", () => {
      const config = StreamingConfigSchema.parse({
        defaultChunkMinChars: 50,
      });
      const resolved = resolveStreamingConfig("telegram", config);
      expect(resolved.chunkMinChars).toBe(50);
    });

    it("defaultTypingCircuitBreakerThreshold: 5 propagates", () => {
      const config = StreamingConfigSchema.parse({
        defaultTypingCircuitBreakerThreshold: 5,
      });
      const resolved = resolveStreamingConfig("telegram", config);
      expect(resolved.typingCircuitBreakerThreshold).toBe(5);
    });

    it("defaultTypingTtlMs: 90000 propagates", () => {
      const config = StreamingConfigSchema.parse({
        defaultTypingTtlMs: 90000,
      });
      const resolved = resolveStreamingConfig("telegram", config);
      expect(resolved.typingTtlMs).toBe(90000);
    });
  });

  describe("per-channel override branch — regression coverage", () => {
    it("per-channel override wins over global defaults for chunkMinChars", () => {
      const config = StreamingConfigSchema.parse({
        defaultChunkMinChars: 50,
        perChannel: {
          telegram: PerChannelStreamingConfigSchema.parse({ chunkMinChars: 25 }),
        },
      });
      const resolved = resolveStreamingConfig("telegram", config);
      expect(resolved.chunkMinChars).toBe(25);
    });

    it("per-channel override wins over global defaults for typingCircuitBreakerThreshold", () => {
      const config = StreamingConfigSchema.parse({
        defaultTypingCircuitBreakerThreshold: 5,
        perChannel: {
          telegram: PerChannelStreamingConfigSchema.parse({ typingCircuitBreakerThreshold: 10 }),
        },
      });
      const resolved = resolveStreamingConfig("telegram", config);
      expect(resolved.typingCircuitBreakerThreshold).toBe(10);
    });
  });
});

describe("executeAndDeliver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedPacerConfig = undefined;
  });

  // -------------------------------------------------------------------
  // Basic dispatch
  // -------------------------------------------------------------------
  describe("basic dispatch", () => {
    it("calls executor.execute with the effective message and session key", async () => {
      const adapter = makeAdapter();
      const executor = makeExecutor();
      const deps = makeDeps();
      const msg = makeMessage();
      const sk = makeSessionKey();
      const cfg = makeBlockStreamCfg();

      await executeAndDeliver(
        deps, adapter, msg, msg, executor, sk, "agent-1",
        cfg, new Set(), makeSendOverrides(),
      );

      expect(executor.execute).toHaveBeenCalledWith(
        msg,
        sk,
        undefined, // no tools
        expect.any(Function), // onDelta
        "agent-1",
        undefined, // no directives
        undefined, // prevTimestamp
        { operationType: "interactive" }, // overrides
      );
    });

    it("delivers response via adapter.sendMessage", async () => {
      const adapter = makeAdapter();
      const executor = makeExecutor();
      const deps = makeDeps();
      const msg = makeMessage();
      const sk = makeSessionKey();
      const cfg = makeBlockStreamCfg();

      await executeAndDeliver(
        deps, adapter, msg, msg, executor, sk, "agent-1",
        cfg, new Set(), makeSendOverrides(),
      );

      expect(adapter.sendMessage).toHaveBeenCalled();
      const callArgs = vi.mocked(adapter.sendMessage).mock.calls[0];
      expect(callArgs[0]).toBe("12345"); // channelId
      expect(callArgs[1]).toBe("Agent response text"); // text
    });

    it("the delivery stage runs under a request context carrying the resolved agentId (so deliverToChannel can bind the reply → trajectory)", async () => {
      // The delivery happens AFTER executeLlm returns (outside the executor's
      // runWithContext) and would otherwise inherit the channel-ingress ALS,
      // which has NO agentId (context.ts:38). deliverToChannel reads ctx.agentId
      // to persist the REAL agent into the queue optionsJson AND bind the minted
      // reply id → trajectory (the reaction-attribution keystone). This test
      // captures the ctx.agentId visible INSIDE deliverToChannel; it must be the
      // resolved agent, not undefined (which is what the ingress context carries).
      let agentIdInDelivery: string | undefined = "SENTINEL_NOT_SET";
      const capturingDelivery: DeliveryService = {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only fake
        deliverToChannel: vi.fn(async (adapter: any, channelId: string, text: string) => {
          agentIdInDelivery = tryGetContext()?.agentId;
          const result = await adapter.sendMessage(channelId, text, undefined);
          return ok({
            ok: result.ok,
            totalChunks: 1,
            deliveredChunks: result.ok ? 1 : 0,
            failedChunks: result.ok ? 0 : 1,
            chunks: [{ ok: result.ok, messageId: result.ok ? result.value : undefined, error: result.ok ? undefined : result.error, charCount: text.length, retried: false }],
            totalChars: text.length,
          });
        }),
        drainInFlight: vi.fn(async () => ({ drained: 0, remaining: 0, durationMs: 0 })),
      };
      const deps = makeDeps({ deliveryService: capturingDelivery });

      await executeAndDeliver(
        deps, makeAdapter(), makeMessage(), makeMessage(), makeExecutor(),
        makeSessionKey(), "mldag", makeBlockStreamCfg(), new Set(), makeSendOverrides(),
      );

      expect(capturingDelivery.deliverToChannel).toHaveBeenCalled();
      // The delivery stage must see the resolved agentId on the ALS — NOT
      // undefined (which fail-closes both reaction-binding paths).
      expect(
        agentIdInDelivery,
        "deliverToChannel must run under a context carrying the resolved agentId (else the reply→trajectory binding fail-closes and reactions never attribute)",
      ).toBe("mldag");
    });

    it("emits diagnostic:message_processed event after execution", async () => {
      const eventBus = makeEventBus();
      const deps = makeDeps({ eventBus });
      const msg = makeMessage();
      const executor = makeExecutor({
        execute: vi.fn(async () => ({
          response: "Agent response text",
          sessionKey: makeSessionKey(),
          tokensUsed: { input: 100, output: 50, total: 150 },
          cost: { total: 0.001 },
          stepsExecuted: 3,
          llmCalls: 4,
          finishReason: "stop" as const,
        })),
      });

      await executeAndDeliver(
        deps, makeAdapter(), msg, msg, executor, makeSessionKey(),
        "agent-1", makeBlockStreamCfg(), new Set(), makeSendOverrides(),
      );

      expect(eventBus.emit).toHaveBeenCalledWith(
        "diagnostic:message_processed",
        expect.objectContaining({
          messageId: msg.id,
          channelId: "12345",
          agentId: "agent-1",
          tokensUsed: 150,
          cost: 0.001,
          toolCalls: 3,
          llmCalls: 4,
          success: true,
        }),
      );
    });

    it("emits message:sent event carrying the real lastChunkMessageId (not block-delivery)", async () => {
      const eventBus = makeEventBus();
      const deps = makeDeps({ eventBus });
      const msg = makeMessage();

      await executeAndDeliver(
        deps, makeAdapter(), msg, msg, makeExecutor(), makeSessionKey(),
        "agent-1", makeBlockStreamCfg(), new Set(), makeSendOverrides(),
      );

      // The synthetic "block-delivery" id is replaced by the receipt's real
      // lastChunkMessageId — here the adapter.sendMessage mock returns "msg-99".
      expect(eventBus.emit).toHaveBeenCalledWith(
        "message:sent",
        expect.objectContaining({
          channelId: "12345",
          messageId: "msg-99",
          content: "Agent response text",
        }),
      );
      // Defend against regression: no message:sent emit carries the synthetic id.
      const sentEmits = vi.mocked(eventBus.emit).mock.calls
        .filter(([name]) => name === "message:sent")
        .map(([, payload]) => payload as { messageId: string });
      expect(sentEmits.every((p) => p.messageId !== "block-delivery")).toBe(true);
    });

    it("delivers the real lastChunkMessageId to a downstream message:sent subscriber", async () => {
      // Enumerated message:sent subscribers (grep -Rn '"message:sent"'):
      //   daemon/observability/{delivery-tracer,channel-activity-tracker},
      //   daemon/observability/diagnostic-collector, channels/shared/lifecycle-reactor,
      //   gateway web/rest + sse fan-out, web SPA. All read payload.messageId.
      // This asserts the on()-style subscriber contract holds end-to-end.
      const eventBus = makeEventBus();
      const received: string[] = [];
      vi.mocked(eventBus.emit).mockImplementation(((name: string, payload: { messageId?: string }) => {
        if (name === "message:sent" && payload?.messageId) received.push(payload.messageId);
        return true;
      }) as typeof eventBus.emit);
      const deps = makeDeps({ eventBus });
      const msg = makeMessage();

      await executeAndDeliver(
        deps, makeAdapter(), msg, msg, makeExecutor(), makeSessionKey(),
        "agent-1", makeBlockStreamCfg(), new Set(), makeSendOverrides(),
      );

      expect(received).toContain("msg-99");
      expect(received).not.toContain("block-delivery");
    });
  });

  // -------------------------------------------------------------------
  // Error and empty response handling
  // -------------------------------------------------------------------
  describe("error and empty response handling", () => {
    it("sends fallback acknowledgment when executor returns empty response with finishReason stop", async () => {
      const adapter = makeAdapter();
      const executor = makeExecutor({
        execute: vi.fn(async () => ({
          response: "",
          sessionKey: { tenantId: "default", userId: "user-1", channelId: "12345" },
          tokensUsed: { input: 100, output: 0, total: 100 },
          cost: { total: 0.0005 },
          stepsExecuted: 0,
          llmCalls: 1,
          finishReason: "stop" as const,
        })),
      });
      const eventBus = makeEventBus();
      const deps = makeDeps({ eventBus });
      const msg = makeMessage();

      await executeAndDeliver(
        deps, adapter, msg, msg, executor, makeSessionKey(),
        "agent-1", makeBlockStreamCfg(), new Set(), makeSendOverrides(),
      );

      // canned ack is sent instead of silent skip
      expect(adapter.sendMessage).toHaveBeenCalledWith(
        msg.channelId,
        "I completed the requested operations but wasn't able to generate a summary. Please check the results or ask me to continue.",
        { replyTo: undefined },
      );
      // Diagnostic should still be emitted
      expect(eventBus.emit).toHaveBeenCalledWith(
        "diagnostic:message_processed",
        expect.objectContaining({ success: true }),
      );
    });

    it("suppresses NO_REPLY sentinel and does NOT call adapter.sendMessage", async () => {
      const adapter = makeAdapter();
      const executor = makeExecutor({
        execute: vi.fn(async () => ({
          response: "NO_REPLY",
          sessionKey: { tenantId: "default", userId: "user-1", channelId: "12345" },
          tokensUsed: { input: 100, output: 10, total: 110 },
          cost: { total: 0.0005 },
          stepsExecuted: 0,
          llmCalls: 1,
          finishReason: "stop" as const,
        })),
      });
      const eventBus = makeEventBus();
      const deps = makeDeps({ eventBus });
      const msg = makeMessage();

      await executeAndDeliver(
        deps, adapter, msg, msg, executor, makeSessionKey(),
        "agent-1", makeBlockStreamCfg(), new Set(), makeSendOverrides(),
      );

      expect(adapter.sendMessage).not.toHaveBeenCalled();
      expect(eventBus.emit).toHaveBeenCalledWith(
        "response:filtered",
        expect.objectContaining({
          channelId: "telegram-123",
          suppressedBy: "NO_REPLY",
        }),
      );
    });
  });

  // -------------------------------------------------------------------
  // Send policy gate
  // -------------------------------------------------------------------
  describe("send policy gate", () => {
    it("when policy denies: still executes agent but skips delivery, emits sendpolicy:denied", async () => {
      const adapter = makeAdapter();
      const executor = makeExecutor();
      const eventBus = makeEventBus();
      const deps = makeDeps({
        eventBus,
        sendPolicyConfig: {
          enabled: true,
          defaultAction: "deny",
          rules: [],
        },
      });
      const msg = makeMessage();

      await executeAndDeliver(
        deps, adapter, msg, msg, executor, makeSessionKey(),
        "agent-1", makeBlockStreamCfg(), new Set(), makeSendOverrides(),
      );

      // Agent was still executed (for session history)
      expect(executor.execute).toHaveBeenCalled();
      // But no message delivered
      expect(adapter.sendMessage).not.toHaveBeenCalled();
      // Denial event emitted
      expect(eventBus.emit).toHaveBeenCalledWith(
        "sendpolicy:denied",
        expect.objectContaining({
          channelId: "telegram-123",
          channelType: "telegram",
        }),
      );
    });

    it("when policy allows: emits sendpolicy:allowed and proceeds to delivery", async () => {
      const adapter = makeAdapter();
      const executor = makeExecutor();
      const eventBus = makeEventBus();
      const deps = makeDeps({
        eventBus,
        sendPolicyConfig: {
          enabled: true,
          defaultAction: "allow",
          rules: [],
        },
      });
      const msg = makeMessage();

      await executeAndDeliver(
        deps, adapter, msg, msg, executor, makeSessionKey(),
        "agent-1", makeBlockStreamCfg(), new Set(), makeSendOverrides(),
      );

      expect(eventBus.emit).toHaveBeenCalledWith(
        "sendpolicy:allowed",
        expect.objectContaining({
          channelId: "telegram-123",
          channelType: "telegram",
        }),
      );
      // Normal delivery proceeds
      expect(adapter.sendMessage).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------
  // Elevated reply routing
  // -------------------------------------------------------------------
  describe("elevated reply routing", () => {
    it("injects modelRoute into message metadata when senderTrustMap matches", async () => {
      const adapter = makeAdapter();
      const executor = makeExecutor();
      const deps = makeDeps({
        getElevatedReplyConfig: () => ({
          enabled: true,
          senderTrustMap: { "user-1": "admin" },
          defaultTrustLevel: "user",
          trustModelRoutes: { admin: "anthropic:claude-3-opus" },
          trustPromptOverrides: {},
        }),
      });
      const msg = makeMessage({ senderId: "user-1" });

      await executeAndDeliver(
        deps, adapter, msg, msg, executor, makeSessionKey(),
        "agent-1", makeBlockStreamCfg(), new Set(), makeSendOverrides(),
      );

      // Executor should have been called with modelRoute in metadata
      const executeCall = vi.mocked(executor.execute).mock.calls[0];
      const executedMsg = executeCall[0] as NormalizedMessage;
      expect(executedMsg.metadata?.modelRoute).toBe("anthropic:claude-3-opus");
    });

    it("injects systemPromptOverride when trustPromptOverrides configured", async () => {
      const adapter = makeAdapter();
      const executor = makeExecutor();
      const deps = makeDeps({
        getElevatedReplyConfig: () => ({
          enabled: true,
          senderTrustMap: { "user-1": "admin" },
          defaultTrustLevel: "user",
          trustModelRoutes: {},
          trustPromptOverrides: { admin: "You are an admin-level assistant." },
        }),
      });
      const msg = makeMessage({ senderId: "user-1" });

      await executeAndDeliver(
        deps, adapter, msg, msg, executor, makeSessionKey(),
        "agent-1", makeBlockStreamCfg(), new Set(), makeSendOverrides(),
      );

      const executeCall = vi.mocked(executor.execute).mock.calls[0];
      const executedMsg = executeCall[0] as NormalizedMessage;
      expect(executedMsg.metadata?.systemPromptOverride).toBe("You are an admin-level assistant.");
    });
  });

  // -------------------------------------------------------------------
  // Typing indicator lifecycle
  // -------------------------------------------------------------------
  describe("typing indicator lifecycle", () => {
    it("thinking mode: starts typing before execution, lifecycle signals fire", async () => {
      const { lifecycle, ctrl: typingCtrl } = makeTypingLifecycle();
      const eventBus = makeEventBus();
      const deps = makeDeps({ eventBus });
      const cfg = makeBlockStreamCfg({ typingMode: "thinking" });
      const msg = makeMessage();

      await executeAndDeliver(
        deps, makeAdapter(), msg, msg, makeExecutor(), makeSessionKey(),
        "agent-1", cfg, new Set(), makeSendOverrides(), lifecycle,
      );

      expect(typingCtrl.start).toHaveBeenCalledWith("12345");
      // dispose() is called in finally block, which calls stop()
      expect(lifecycle.dispose).toHaveBeenCalled();
      // typing:started event
      expect(eventBus.emit).toHaveBeenCalledWith(
        "typing:started",
        expect.objectContaining({ mode: "thinking" }),
      );
      // markRunComplete called after execution
      expect(lifecycle.markRunComplete).toHaveBeenCalled();
    });

    it("message mode: starts typing just before block delivery", async () => {
      const { lifecycle, ctrl: typingCtrl } = makeTypingLifecycle();
      const eventBus = makeEventBus();
      const deps = makeDeps({ eventBus });
      const cfg = makeBlockStreamCfg({ typingMode: "message" });
      const msg = makeMessage();

      await executeAndDeliver(
        deps, makeAdapter(), msg, msg, makeExecutor(), makeSessionKey(),
        "agent-1", cfg, new Set(), makeSendOverrides(), lifecycle,
      );

      expect(typingCtrl.start).toHaveBeenCalledWith("12345");
      expect(eventBus.emit).toHaveBeenCalledWith(
        "typing:started",
        expect.objectContaining({ mode: "message" }),
      );
      // markDispatchIdle called after delivery, markRunComplete after
      expect(lifecycle.markDispatchIdle).toHaveBeenCalled();
      expect(lifecycle.markRunComplete).toHaveBeenCalled();
    });

    it("refreshes TTL on thinking-only deltas that produce no visible content", async () => {
      const { lifecycle, ctrl: typingCtrl } = makeTypingLifecycle();
      const eventBus = makeEventBus();
      const deps = makeDeps({ eventBus });
      const cfg = makeBlockStreamCfg({ typingMode: "thinking" });
      const msg = makeMessage();

      // Executor captures onDelta and feeds thinking-only tokens
      const executor = makeExecutor({
        execute: vi.fn(async (_msg, _sk, _tools, onDelta) => {
          // Simulate LLM emitting thinking tokens (kind="thinking") -- never reach accumulated
          onDelta?.("<think>reasoning step", "thinking");
          onDelta?.(" about the problem", "thinking");
          onDelta?.("</think>", "thinking");
          return {
            response: "",
            sessionKey: { tenantId: "default", userId: "user-1", channelId: "12345" },
            tokensUsed: { input: 100, output: 50, total: 150 },
            cost: { total: 0.001 },
            stepsExecuted: 0,
            llmCalls: 1,
            finishReason: "stop" as const,
          };
        }),
      });

      await executeAndDeliver(
        deps, makeAdapter(), msg, msg, executor, makeSessionKey(),
        "agent-1", cfg, new Set(), makeSendOverrides(), lifecycle,
      );

      // TTL should be refreshed even though no visible content was produced
      expect(typingCtrl.refreshTtl).toHaveBeenCalled();
      // At least 3 calls (one per delta)
      expect((typingCtrl.refreshTtl as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it("refreshes TTL on normal content deltas (regression guard)", async () => {
      const { lifecycle, ctrl: typingCtrl } = makeTypingLifecycle();
      const eventBus = makeEventBus();
      const deps = makeDeps({ eventBus });
      const cfg = makeBlockStreamCfg({ typingMode: "thinking" });
      const msg = makeMessage();

      // Executor captures onDelta and feeds visible content
      const executor = makeExecutor({
        execute: vi.fn(async (_msg, _sk, _tools, onDelta) => {
          onDelta?.("Hello ", "text");
          onDelta?.("world!", "text");
          return {
            response: "Hello world!",
            sessionKey: { tenantId: "default", userId: "user-1", channelId: "12345" },
            tokensUsed: { input: 100, output: 50, total: 150 },
            cost: { total: 0.001 },
            stepsExecuted: 0,
            llmCalls: 1,
            finishReason: "stop" as const,
          };
        }),
      });

      await executeAndDeliver(
        deps, makeAdapter(), msg, msg, executor, makeSessionKey(),
        "agent-1", cfg, new Set(), makeSendOverrides(), lifecycle,
      );

      // TTL should be refreshed for visible content deltas
      expect(typingCtrl.refreshTtl).toHaveBeenCalled();
      expect((typingCtrl.refreshTtl as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  // -------------------------------------------------------------------
  // Outbound media pipeline
  // -------------------------------------------------------------------
  describe("outbound media pipeline", () => {
    it("delivers media before text when MEDIA: directives found", async () => {
      const adapter = makeAdapter({
        sendAttachment: vi.fn(async () => ok("attachment-id")),
      } as any);
      const executor = makeExecutor({
        execute: vi.fn(async () => ({
          response: "MEDIA: https://example.com/image.png\nCaption text",
          sessionKey: { tenantId: "default", userId: "user-1", channelId: "12345" },
          tokensUsed: { input: 100, output: 50, total: 150 },
          cost: { total: 0.001 },
          stepsExecuted: 0,
          llmCalls: 1,
          finishReason: "stop" as const,
        })),
      });
      const deps = makeDeps({
        parseOutboundMedia: vi.fn((text: string) => ({
          text: "Caption text",
          mediaUrls: ["https://example.com/image.png"],
        })),
        outboundMediaFetch: vi.fn(async () => ok({ buffer: Buffer.from("img"), mimeType: "image/png" })),
      });

      await executeAndDeliver(
        deps, adapter, makeMessage(), makeMessage(), executor, makeSessionKey(),
        "agent-1", makeBlockStreamCfg(), new Set(), makeSendOverrides(),
      );

      // outboundMediaFetch was called
      expect(deps.outboundMediaFetch).toHaveBeenCalledWith("https://example.com/image.png");
      // Text delivery for caption
      expect(adapter.sendMessage).toHaveBeenCalled();
      const sentText = vi.mocked(adapter.sendMessage).mock.calls[0][1];
      expect(sentText).toBe("Caption text");
    });

    it("media-only response emits message:sent with media-only-delivery (no coalesce events)", async () => {
      const adapter = makeAdapter({
        sendAttachment: vi.fn(async () => ok("attachment-id")),
      } as any);
      const executor = makeExecutor({
        execute: vi.fn(async () => ({
          response: "MEDIA: https://example.com/image.png",
          sessionKey: { tenantId: "default", userId: "user-1", channelId: "12345" },
          tokensUsed: { input: 100, output: 50, total: 150 },
          cost: { total: 0.001 },
          stepsExecuted: 0,
          llmCalls: 1,
          finishReason: "stop" as const,
        })),
      });
      const eventBus = makeEventBus();
      const deps = makeDeps({
        eventBus,
        parseOutboundMedia: vi.fn(() => ({
          text: "",
          mediaUrls: ["https://example.com/image.png"],
        })),
        outboundMediaFetch: vi.fn(async () => ok({ buffer: Buffer.from("img"), mimeType: "image/png" })),
      });

      await executeAndDeliver(
        deps, adapter, makeMessage(), makeMessage(), executor, makeSessionKey(),
        "agent-1", makeBlockStreamCfg(), new Set(), makeSendOverrides(),
      );

      // Text delivery should be skipped
      expect(adapter.sendMessage).not.toHaveBeenCalled();
      // message:sent with media-only
      expect(eventBus.emit).toHaveBeenCalledWith(
        "message:sent",
        expect.objectContaining({
          messageId: "media-only-delivery",
        }),
      );
    });
  });

  // -------------------------------------------------------------------
  // chunkForDelivery integration
  // -------------------------------------------------------------------
  describe("chunkForDelivery integration", () => {
    it("uses chunkForDelivery for chunking (blocks match expected output)", async () => {
      // Response long enough to require multiple coalesced groups (exceeds coalescer maxChars)
      const longResponse = "First paragraph with some substantial text content here.\n\n" +
        "Second paragraph that continues with more detailed response content.\n\n" +
        "Third paragraph providing additional information for the user.\n\n" +
        "Fourth paragraph with even more content to ensure multiple coalesced groups.";
      const executor = makeExecutor({
        execute: vi.fn(async () => ({
          response: longResponse,
          sessionKey: { tenantId: "default", userId: "user-1", channelId: "12345" },
          tokensUsed: { input: 100, output: 50, total: 150 },
          cost: { total: 0.001 },
          stepsExecuted: 0,
          llmCalls: 1,
          finishReason: "stop" as const,
        })),
      });
      const adapter = makeAdapter();
      const deps = makeDeps();
      const msg = makeMessage();
      // Small chunkMaxChars + small coalescer maxChars to force multiple delivered groups
      const cfg = makeBlockStreamCfg({
        chunkMaxChars: 80,
        coalescer: { minChars: 0, maxChars: 100, idleMs: 1500, codeBlockPolicy: "standalone", adaptiveIdle: false },
      });

      await executeAndDeliver(
        deps, adapter, msg, msg, executor, makeSessionKey(),
        "agent-1", cfg, new Set(), makeSendOverrides(),
      );

      // adapter.sendMessage should have been called multiple times (multiple coalesced groups)
      const calls = vi.mocked(adapter.sendMessage).mock.calls;
      expect(calls.length).toBeGreaterThan(1);
      // Reconstruct the full text from all sent blocks
      const sentTexts = calls.map((c) => c[1]);
      const joined = sentTexts.join("");
      // Full response content should be preserved across chunks
      expect(joined).toContain("First paragraph");
      expect(joined).toContain("Second paragraph");
      expect(joined).toContain("Third paragraph");
      expect(joined).toContain("Fourth paragraph");
    });
  });

  // -------------------------------------------------------------------
  // Block coalescer integration
  // -------------------------------------------------------------------
  describe("block coalescer integration", () => {
    it("coalesces blocks and emits coalesce:flushed events", async () => {
      const eventBus = makeEventBus();
      const executor = makeExecutor({
        execute: vi.fn(async () => ({
          response: "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.",
          sessionKey: { tenantId: "default", userId: "user-1", channelId: "12345" },
          tokensUsed: { input: 100, output: 50, total: 150 },
          cost: { total: 0.001 },
          stepsExecuted: 0,
          llmCalls: 1,
          finishReason: "stop" as const,
        })),
      });
      const deps = makeDeps({ eventBus });
      const msg = makeMessage();

      await executeAndDeliver(
        deps, makeAdapter(), msg, msg, executor, makeSessionKey(),
        "agent-1", makeBlockStreamCfg(), new Set(), makeSendOverrides(),
      );

      // Verify coalesce:flushed events were emitted
      const coalesceEmits = vi.mocked(eventBus.emit).mock.calls.filter(
        (c) => c[0] === "coalesce:flushed",
      );
      expect(coalesceEmits.length).toBeGreaterThanOrEqual(1);

      // Check event payload structure
      const firstEvent = coalesceEmits[0][1] as Record<string, unknown>;
      expect(firstEvent).toHaveProperty("channelId");
      expect(firstEvent).toHaveProperty("chatId");
      expect(firstEvent).toHaveProperty("blockCount");
      expect(firstEvent).toHaveProperty("charCount");
      expect(firstEvent).toHaveProperty("trigger");
      expect(firstEvent).toHaveProperty("timestamp");
    });

    it("passes disableCoalescing: true to block pacer", async () => {
      const deps = makeDeps();
      const msg = makeMessage();

      await executeAndDeliver(
        deps, makeAdapter(), msg, msg, makeExecutor(), makeSessionKey(),
        "agent-1", makeBlockStreamCfg(), new Set(), makeSendOverrides(),
      );

      expect(capturedPacerConfig).toBeDefined();
      expect(capturedPacerConfig!.disableCoalescing).toBe(true);
    });

    it("passes deliveryTiming config to block pacer", async () => {
      const customTiming = { mode: "custom" as const, minMs: 100, maxMs: 300, jitterMs: 50, firstBlockDelayMs: 0 };
      const cfg = makeBlockStreamCfg({
        deliveryTiming: customTiming,
      });
      const deps = makeDeps();
      const msg = makeMessage();

      await executeAndDeliver(
        deps, makeAdapter(), msg, msg, makeExecutor(), makeSessionKey(),
        "agent-1", cfg, new Set(), makeSendOverrides(),
      );

      expect(capturedPacerConfig).toBeDefined();
      expect(capturedPacerConfig!.timingConfig).toEqual(customTiming);
    });

    it("passes coalesced groups to pacer deliver (not raw blocks)", async () => {
      // Use the mock pacer to verify the blocks passed to deliver()
      const { createBlockPacer: mockedCreate } = await import("@comis/channels");
      const deps = makeDeps();
      const msg = makeMessage();
      const cfg = makeBlockStreamCfg();

      await executeAndDeliver(
        deps, makeAdapter(), msg, msg, makeExecutor(), makeSessionKey(),
        "agent-1", cfg, new Set(), makeSendOverrides(),
      );

      // Verify the mock pacer's deliver was called
      const mockPacer = vi.mocked(mockedCreate).mock.results[0]?.value as BlockPacer;
      expect(mockPacer).toBeDefined();
      const deliverCalls = vi.mocked(mockPacer.deliver).mock.calls;
      expect(deliverCalls.length).toBe(1);

      // The first argument to deliver() should be the coalesced groups (string[])
      const deliveredGroups = deliverCalls[0][0] as string[];
      expect(Array.isArray(deliveredGroups)).toBe(true);
      expect(deliveredGroups.length).toBeGreaterThanOrEqual(1);
      // The content should match the agent response (coalesced)
      expect(deliveredGroups.join("")).toContain("Agent response text");
    });
  });

  // -------------------------------------------------------------------
  // Pipeline timeout
  // -------------------------------------------------------------------
  describe("pipeline timeout", () => {
    it("sends canned error message on execution timeout", async () => {
      const adapter = makeAdapter();
      const executor = makeExecutor({
        execute: vi.fn(() => new Promise(() => {})), // hangs forever
      });
      const eventBus = makeEventBus();
      const deps = makeDeps({ eventBus, executionTimeoutMs: 50 });
      const msg = makeMessage();
      const sk = makeSessionKey();

      await executeAndDeliver(
        deps, adapter, msg, msg, executor, sk, "agent-1",
        makeBlockStreamCfg(), new Set(), makeSendOverrides(),
      );

      // Canned error sent to channel
      expect(adapter.sendMessage).toHaveBeenCalledWith(
        "12345",
        "I'm having trouble processing your request right now. Please try again in a moment.",
        expect.objectContaining({}),
      );

      // execution:aborted emitted with pipeline_timeout reason
      expect(eventBus.emit).toHaveBeenCalledWith(
        "execution:aborted",
        expect.objectContaining({
          reason: "pipeline_timeout",
          agentId: "agent-1",
          sessionKey: sk,
        }),
      );
    });

    it("does not send canned error when execution completes within timeout", async () => {
      const adapter = makeAdapter();
      const executor = makeExecutor(); // resolves immediately
      const eventBus = makeEventBus();
      const deps = makeDeps({ eventBus, executionTimeoutMs: 5000 });
      const msg = makeMessage();

      await executeAndDeliver(
        deps, adapter, msg, msg, executor, makeSessionKey(), "agent-1",
        makeBlockStreamCfg(), new Set(), makeSendOverrides(),
      );

      // Normal response delivered (not the canned error)
      expect(adapter.sendMessage).toHaveBeenCalled();
      const sentText = vi.mocked(adapter.sendMessage).mock.calls[0][1];
      expect(sentText).toBe("Agent response text");

      // execution:aborted NOT emitted
      const abortedCalls = vi.mocked(eventBus.emit).mock.calls.filter(
        (c) => c[0] === "execution:aborted",
      );
      expect(abortedCalls).toHaveLength(0);
    });

    it("typing controller is stopped after timeout (finally block disposes lifecycle)", async () => {
      const { lifecycle, ctrl: typingCtrl } = makeTypingLifecycle();
      const executor = makeExecutor({
        execute: vi.fn(() => new Promise(() => {})), // hangs forever
      });
      const deps = makeDeps({ executionTimeoutMs: 50 });
      const cfg = makeBlockStreamCfg({ typingMode: "thinking" });
      const msg = makeMessage();

      await executeAndDeliver(
        deps, makeAdapter(), msg, msg, executor, makeSessionKey(),
        "agent-1", cfg, new Set(), makeSendOverrides(), lifecycle,
      );

      // Typing was started and then disposed by the finally block
      expect(typingCtrl.start).toHaveBeenCalledWith("12345");
      expect(lifecycle.dispose).toHaveBeenCalled();
    });

    it("uses 600_000ms default when executionTimeoutMs is not set", async () => {
      const adapter = makeAdapter();
      const executor = makeExecutor(); // resolves immediately
      const deps = makeDeps(); // executionTimeoutMs is undefined
      const msg = makeMessage();

      // With a fast-resolving executor and undefined timeout, the function
      // should complete normally (default 600s is never reached)
      await executeAndDeliver(
        deps, adapter, msg, msg, executor, makeSessionKey(), "agent-1",
        makeBlockStreamCfg(), new Set(), makeSendOverrides(),
      );

      // Normal delivery succeeds -- no timeout triggered
      expect(adapter.sendMessage).toHaveBeenCalled();
      const sentText = vi.mocked(adapter.sendMessage).mock.calls[0][1];
      expect(sentText).toBe("Agent response text");
    });

    it("emits diagnostic:message_processed even on timeout", async () => {
      const eventBus = makeEventBus();
      const executor = makeExecutor({
        execute: vi.fn(() => new Promise(() => {})),
      });
      const deps = makeDeps({ eventBus, executionTimeoutMs: 50 });
      const msg = makeMessage();

      await executeAndDeliver(
        deps, makeAdapter(), msg, msg, executor, makeSessionKey(),
        "agent-1", makeBlockStreamCfg(), new Set(), makeSendOverrides(),
      );

      // Diagnostic event emitted on timeout path
      expect(eventBus.emit).toHaveBeenCalledWith(
        "diagnostic:message_processed",
        expect.objectContaining({
          messageId: msg.id,
          agentId: "agent-1",
          toolCalls: null,
          llmCalls: null,
          success: true,
        }),
      );
    });
  });

  // -------------------------------------------------------------------
  // Thread propagation
  // -------------------------------------------------------------------
  describe("thread propagation", () => {
    it("sends threadId in sendOpts for all blocks (not just first)", async () => {
      const adapter = makeAdapter();
      const executor = makeExecutor({
        execute: vi.fn(async () => ({
          response: "First paragraph.\n\nSecond paragraph.",
          sessionKey: { tenantId: "default", userId: "user-1", channelId: "12345" },
          tokensUsed: { input: 100, output: 50, total: 150 },
          cost: { total: 0.001 },
          stepsExecuted: 0,
          llmCalls: 1,
          finishReason: "stop" as const,
        })),
      });
      const deps = makeDeps();
      const msg = makeMessage({
        metadata: {
          telegramMessageId: 42,
          telegramChatType: "group",
          isGroup: true,
          threadId: "42",
          telegramThreadId: 42,
          telegramIsForum: true,
          telegramThreadScope: "forum",
        },
      });

      await executeAndDeliver(
        deps, adapter, msg, msg, executor, makeSessionKey(),
        "agent-1", makeBlockStreamCfg(), new Set(), makeSendOverrides(),
      );

      // adapter.sendMessage should have been called for each block
      const calls = vi.mocked(adapter.sendMessage).mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(1);

      // ALL blocks must have threadId in sendOpts
      for (let i = 0; i < calls.length; i++) {
        const sendOpts = calls[i][2] as Record<string, unknown>;
        expect(sendOpts.threadId).toBe("42");
        expect(sendOpts.extra).toEqual({ telegramThreadScope: "forum" });
      }

      // First block has replyTo, subsequent do not
      if (calls.length > 1) {
        expect((calls[1][2] as Record<string, unknown>).replyTo).toBeUndefined();
      }
    });

    it("omits threadId from sendOpts when no thread metadata", async () => {
      const adapter = makeAdapter();
      const deps = makeDeps();
      const msg = makeMessage(); // no thread metadata

      await executeAndDeliver(
        deps, adapter, msg, msg, makeExecutor(), makeSessionKey(),
        "agent-1", makeBlockStreamCfg(), new Set(), makeSendOverrides(),
      );

      const calls = vi.mocked(adapter.sendMessage).mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(1);

      // sendOpts should NOT contain threadId
      const sendOpts = calls[0][2] as Record<string, unknown>;
      expect(sendOpts.threadId).toBeUndefined();
    });

    it("threads a 1:1 (DM) reply when the channel declares threadReplyInDm (email invisible In-Reply-To)", async () => {
      // ISSUE-2 (chief-of-staff live campaign): email threads via invisible
      // In-Reply-To/References headers, so a DM (1:1) reply must still carry
      // reply-to — unlike visible-quote channels that skip DM reply-to as noise.
      // Pre-fix the DM-skip was unconditional (isGroupMessage only), so email
      // replies started a fresh thread every time.
      const adapter = makeAdapter({ channelType: "email" });
      const channelRegistry = {
        getCapabilities: vi.fn(() => ({
          features: { reactions: false, editMessages: false, deleteMessages: false, fetchHistory: false, attachments: true, typing: false, threads: false, buttons: "none" as const },
          limits: { maxMessageChars: 100_000 },
          replyToMetaKey: "emailMessageId",
          threadReplyInDm: true,
        })),
      } as unknown as ExecutionPipelineDeps["channelRegistry"];
      const deps = makeDeps({ channelRegistry });
      const msg = makeMessage({
        channelType: "email",
        chatType: "dm",
        metadata: { emailMessageId: "<orig@home.test>", emailSubject: "Budget" },
      });

      await executeAndDeliver(
        deps, adapter, msg, msg, makeExecutor(), makeSessionKey(),
        "agent-1", makeBlockStreamCfg(), new Set(), makeSendOverrides(),
      );

      const calls = vi.mocked(adapter.sendMessage).mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(1);
      // Block 0 must carry the inbound Message-ID as reply-to so the mail client threads it.
      expect((calls[0][2] as Record<string, unknown>).replyTo).toBe("<orig@home.test>");
    });

    // followupTrigger-based tests were removed: the followupTrigger and
    // followupConfig deps slots + handleFollowupTrigger helper were removed
    // from the execution pipeline. createFollowupMessage cross-reference
    // moved to dedicated unit tests in queue/followup-trigger.test.ts
    // (when needed).
  });

  // -------------------------------------------------------------------
  // Thread propagation cross-reference
  // -------------------------------------------------------------------
  describe("thread propagation cross-reference", () => {
    it("THREAD_PROPAGATION_KEYS matches TELEGRAM_THREAD_META_KEYS", () => {
      expect(new Set(THREAD_PROPAGATION_KEYS)).toEqual(new Set(TELEGRAM_THREAD_META_KEYS));
    });
  });

  // -------------------------------------------------------------------
  // Outbound media and voice thread sendOptions passthrough
  // -------------------------------------------------------------------
  describe("outbound media and voice thread sendOptions", () => {
    it("passes thread sendOptions to deliverOutboundMedia", async () => {
      const adapter = makeAdapter({
        sendAttachment: vi.fn(async () => ok("msg-99")),
      });
      const executor = makeExecutor({
        execute: vi.fn(async () => ({
          response: "MEDIA: https://example.com/img.png\nHere is the image.",
          sessionKey: { tenantId: "default", userId: "user-1", channelId: "12345" },
          tokensUsed: { input: 100, output: 50, total: 150 },
          cost: { total: 0.001 },
          stepsExecuted: 0,
          llmCalls: 1,
          finishReason: "stop" as const,
        })),
      });
      const deps = makeDeps({
        parseOutboundMedia: vi.fn((text: string) => ({
          text: text.replace(/MEDIA:.*\n?/g, "").trim(),
          mediaUrls: ["https://example.com/img.png"],
        })),
        outboundMediaFetch: vi.fn(async () => ok({ buffer: Buffer.from("data"), mimeType: "image/png" })),
      });
      const msg = makeMessage({
        metadata: {
          telegramMessageId: 42,
          telegramChatType: "group",
          isGroup: true,
          threadId: "42",
          telegramThreadId: 42,
          telegramIsForum: true,
          telegramThreadScope: "forum",
        },
      });

      await executeAndDeliver(
        deps, adapter, msg, msg, executor, makeSessionKey(),
        "agent-1", makeBlockStreamCfg(), new Set(), makeSendOverrides(),
      );

      // adapter.sendAttachment should have been called with sendOptions containing threadId
      const sendAttachCalls = vi.mocked(adapter.sendAttachment!).mock.calls;
      expect(sendAttachCalls.length).toBeGreaterThanOrEqual(1);
      const sendOptions = sendAttachCalls[0][2] as Record<string, unknown>;
      expect(sendOptions.threadId).toBe("42");
    });

    it("passes thread sendOptions to executeVoiceResponse via adapter", async () => {
      const sendAttachmentMock = vi.fn(async () => ok({}));
      const adapter = makeAdapter({
        sendAttachment: sendAttachmentMock,
      });
      const executor = makeExecutor({
        execute: vi.fn(async () => ({
          response: "Hello voice test",
          sessionKey: { tenantId: "default", userId: "user-1", channelId: "12345" },
          tokensUsed: { input: 100, output: 50, total: 150 },
          cost: { total: 0.001 },
          stepsExecuted: 0,
          llmCalls: 1,
          finishReason: "stop" as const,
        })),
      });

      const voicePipelineDeps = {
        ttsAdapter: {
          synthesize: vi.fn().mockResolvedValue(
            ok({ audio: Buffer.from("audio-data"), mimeType: "audio/ogg" }),
          ),
        },
        audioConverter: {
          toOggOpus: vi.fn(),
          verifyOpusCodec: vi.fn(),
          extractWaveform: vi.fn(),
        },
        mediaTempManager: { getManagedDir: vi.fn().mockReturnValue("/tmp/comis-media") },
        mediaSemaphore: { run: vi.fn().mockImplementation(async (fn: () => Promise<unknown>) => fn()) },
        shouldAutoTts: vi.fn().mockReturnValue({ shouldSynthesize: false }),
        resolveOutputFormat: vi.fn().mockReturnValue({
          openai: "opus", elevenlabs: "opus_48000_64",
          edge: "audio-24khz-48kbitrate-mono-mp3", extension: ".opus",
        }),
        ttsConfig: {
          autoMode: "inbound" as const,
          tagPattern: "\\[\\[tts(?::.*?)?\\]\\]",
          voice: "alloy",
          maxTextLength: 4096,
          providerFormatKey: "openai" as const,
        },
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      };

      const deps = makeDeps({ voiceResponsePipeline: voicePipelineDeps });
      const msg = makeMessage({
        metadata: {
          telegramMessageId: 42,
          telegramChatType: "group",
          isGroup: true,
          threadId: "42",
          telegramThreadId: 42,
          telegramIsForum: true,
          telegramThreadScope: "forum",
        },
      });

      await executeAndDeliver(
        deps, adapter, msg, msg, executor, makeSessionKey(),
        "agent-1", makeBlockStreamCfg(), new Set(), makeSendOverrides(),
      );

      // Voice skipped (shouldAutoTts returns false), but the pipeline was invoked --
      // verify the text block delivery includes threadId instead (voice is pass-through)
      const sendMsgCalls = vi.mocked(adapter.sendMessage).mock.calls;
      expect(sendMsgCalls.length).toBeGreaterThanOrEqual(1);
      const sendOpts = sendMsgCalls[0][2] as Record<string, unknown>;
      expect(sendOpts.threadId).toBe("42");
    });
  });

  // -------------------------------------------------------------------
  // Tool TTL refresh during long tool calls
  // -------------------------------------------------------------------
  describe("tool TTL refresh during long tool calls", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("starts periodic TTL refresh on tool:started and clears on tool:executed", async () => {
      const { lifecycle, ctrl: typingCtrl } = makeTypingLifecycle();
      const eventBus = makeEventBus();
      // Capture handlers registered via eventBus.on
      const handlers: Record<string, Function> = {};
      eventBus.on = vi.fn((event: string, handler: Function) => {
        handlers[event] = handler;
        return eventBus;
      });
      eventBus.off = vi.fn().mockReturnThis();

      // Use a controlled executor that only resolves when we tell it to
      let resolveExecution!: (value: unknown) => void;
      const executor = makeExecutor({
        execute: vi.fn(() => new Promise((resolve) => { resolveExecution = resolve; })),
      });

      const deps = makeDeps({ eventBus });
      const cfg = makeBlockStreamCfg({ typingMode: "thinking" });
      const msg = makeMessage();

      const promise = executeAndDeliver(
        deps, makeAdapter(), msg, msg, executor, makeSessionKey(),
        "agent-1", cfg, new Set(), makeSendOverrides(), lifecycle,
      );
      // Let microtasks settle so the event handlers are registered and typing starts
      await vi.advanceTimersByTimeAsync(0);

      // Simulate tool:started
      expect(handlers["tool:started"]).toBeDefined();
      handlers["tool:started"]();
      const callsAfterStart = vi.mocked(typingCtrl.refreshTtl).mock.calls.length;

      // Advance by 30s -- the interval should fire once
      await vi.advanceTimersByTimeAsync(30_000);
      expect(vi.mocked(typingCtrl.refreshTtl).mock.calls.length).toBe(callsAfterStart + 1);

      // Simulate tool:executed (all tools done)
      expect(handlers["tool:executed"]).toBeDefined();
      handlers["tool:executed"]();

      // Track call count after clearing
      const callsAfterClear = vi.mocked(typingCtrl.refreshTtl).mock.calls.length;

      // Advance another 30s -- interval should NOT fire
      await vi.advanceTimersByTimeAsync(30_000);
      expect(vi.mocked(typingCtrl.refreshTtl).mock.calls.length).toBe(callsAfterClear);

      // Let execution complete
      resolveExecution({
        response: "Agent response text",
        sessionKey: { tenantId: "default", userId: "user-1", channelId: "12345" },
        tokensUsed: { input: 100, output: 50, total: 150 },
        cost: { total: 0.001 },
        stepsExecuted: 0, llmCalls: 1, finishReason: "stop",
      });
      await vi.advanceTimersByTimeAsync(0);
      await promise;
    });

    it("keeps interval running while multiple tools overlap", async () => {
      const { lifecycle, ctrl: typingCtrl } = makeTypingLifecycle();
      const eventBus = makeEventBus();
      const handlers: Record<string, Function> = {};
      eventBus.on = vi.fn((event: string, handler: Function) => {
        handlers[event] = handler;
        return eventBus;
      });
      eventBus.off = vi.fn().mockReturnThis();

      // Controlled executor
      let resolveExecution!: (value: unknown) => void;
      const executor = makeExecutor({
        execute: vi.fn(() => new Promise((resolve) => { resolveExecution = resolve; })),
      });

      const deps = makeDeps({ eventBus });
      const cfg = makeBlockStreamCfg({ typingMode: "thinking" });
      const msg = makeMessage();

      const promise = executeAndDeliver(
        deps, makeAdapter(), msg, msg, executor, makeSessionKey(),
        "agent-1", cfg, new Set(), makeSendOverrides(), lifecycle,
      );
      await vi.advanceTimersByTimeAsync(0);

      // Start two overlapping tools
      handlers["tool:started"]();
      handlers["tool:started"]();

      // Complete one tool -- interval should keep running (activeToolCount = 1)
      handlers["tool:executed"]();

      const callsBeforeAdvance = vi.mocked(typingCtrl.refreshTtl).mock.calls.length;
      await vi.advanceTimersByTimeAsync(30_000);
      // Interval still fires
      expect(vi.mocked(typingCtrl.refreshTtl).mock.calls.length).toBe(callsBeforeAdvance + 1);

      // Complete second tool -- interval should stop
      handlers["tool:executed"]();
      const callsAfterAllDone = vi.mocked(typingCtrl.refreshTtl).mock.calls.length;
      await vi.advanceTimersByTimeAsync(30_000);
      // No more interval calls
      expect(vi.mocked(typingCtrl.refreshTtl).mock.calls.length).toBe(callsAfterAllDone);

      // Let execution complete
      resolveExecution({
        response: "Agent response text",
        sessionKey: { tenantId: "default", userId: "user-1", channelId: "12345" },
        tokensUsed: { input: 100, output: 50, total: 150 },
        cost: { total: 0.001 },
        stepsExecuted: 0, llmCalls: 1, finishReason: "stop",
      });
      await vi.advanceTimersByTimeAsync(0);
      await promise;
    });

    it("finally block cleans up tool:executed subscription and interval", async () => {
      const { lifecycle } = makeTypingLifecycle();
      const eventBus = makeEventBus();
      const handlers: Record<string, Function> = {};
      eventBus.on = vi.fn((event: string, handler: Function) => {
        handlers[event] = handler;
        return eventBus;
      });
      const offCalls: [string, Function][] = [];
      eventBus.off = vi.fn((event: string, handler: Function) => {
        offCalls.push([event, handler]);
        return eventBus;
      });

      // Executor that hangs -- will timeout
      const executor = makeExecutor({
        execute: vi.fn(() => new Promise(() => {})),
      });
      const deps = makeDeps({ eventBus, executionTimeoutMs: 50 });
      const cfg = makeBlockStreamCfg({ typingMode: "thinking" });
      const msg = makeMessage();

      const promise = executeAndDeliver(
        deps, makeAdapter(), msg, msg, executor, makeSessionKey(),
        "agent-1", cfg, new Set(), makeSendOverrides(), lifecycle,
      );

      // Advance past the timeout to trigger the finally block
      await vi.advanceTimersByTimeAsync(100);
      await promise;

      // Verify tool:executed was unsubscribed in the finally block
      const toolExecutedOff = offCalls.find(([event]) => event === "tool:executed");
      expect(toolExecutedOff).toBeDefined();
      expect(typeof toolExecutedOff![1]).toBe("function");

      // Verify tool:started was also unsubscribed
      const toolStartedOff = offCalls.find(([event]) => event === "tool:started");
      expect(toolStartedOff).toBeDefined();
    });
  });

  // -------------------------------------------------------------------
  // Delivery abort signal
  // -------------------------------------------------------------------
  describe("delivery abort signal", () => {
    it("passes externalSignal to createBlockPacer config", async () => {
      const adapter = makeAdapter();
      const executor = makeExecutor();
      const deps = makeDeps();
      const msg = makeMessage();
      const sk = makeSessionKey();
      const cfg = makeBlockStreamCfg();

      await executeAndDeliver(
        deps, adapter, msg, msg, executor, sk, "agent-1",
        cfg, new Set(), makeSendOverrides(),
      );

      // The mock of createBlockPacer captures its config
      expect(capturedPacerConfig).toBeDefined();
      expect(capturedPacerConfig!.externalSignal).toBeDefined();
      expect(capturedPacerConfig!.externalSignal).toBeInstanceOf(AbortSignal);
    });
  });

  // -------------------------------------------------------------------
  // Resource abort recovery delivery
  // -------------------------------------------------------------------
  describe("resource abort recovery", () => {
    it("delivers response when budget_exceeded aborts execution mid-run", async () => {
      const adapter = makeAdapter();
      const eventBus = makeEventBus();
      // Capture the execution:aborted handler so we can fire it during execute()
      const handlers: Record<string, Function> = {};
      eventBus.on = vi.fn((event: string, handler: Function) => {
        handlers[event] = handler;
        return eventBus;
      });

      const sk = makeSessionKey();
      const executor = makeExecutor({
        execute: vi.fn(async () => {
          // Simulate budget guard tripping mid-execution: fires execution:aborted
          // which pre-aborts the deliveryAbortController before returning
          handlers["execution:aborted"]?.({
            sessionKey: sk,
            reason: "budget_exceeded",
            agentId: "agent-1",
            timestamp: Date.now(),
          });
          return {
            response: "Recovered text from earlier turn",
            sessionKey: sk,
            tokensUsed: { input: 1_000_000, output: 60_000, total: 2_060_000 },
            cost: { total: 1.87 },
            stepsExecuted: 28,
            llmCalls: 27,
            finishReason: "budget_exceeded" as const,
          };
        }),
      });

      const deps = makeDeps({ eventBus });
      const msg = makeMessage();
      const cfg = makeBlockStreamCfg();

      await executeAndDeliver(
        deps, adapter, msg, msg, executor, sk, "agent-1",
        cfg, new Set(), makeSendOverrides(),
      );

      // The response should have been delivered despite the pre-aborted signal
      // The pacer receives a fresh (non-aborted) signal for resource aborts
      expect(capturedPacerConfig).toBeDefined();
      expect(capturedPacerConfig!.externalSignal).toBeDefined();
      expect(capturedPacerConfig!.externalSignal!.aborted).toBe(false);

      // adapter.sendMessage should have been called (via pacer mock which calls send for each block)
      expect(adapter.sendMessage).toHaveBeenCalled();
    });

    it("sends canned notification when resource abort produces empty response", async () => {
      const adapter = makeAdapter();
      const eventBus = makeEventBus();
      const handlers: Record<string, Function> = {};
      eventBus.on = vi.fn((event: string, handler: Function) => {
        handlers[event] = handler;
        return eventBus;
      });

      const sk = makeSessionKey();
      const executor = makeExecutor({
        execute: vi.fn(async () => {
          handlers["execution:aborted"]?.({
            sessionKey: sk,
            reason: "budget_exceeded",
            agentId: "agent-1",
            timestamp: Date.now(),
          });
          return {
            response: "", // Empty response — recovery found nothing
            sessionKey: sk,
            tokensUsed: { input: 1_000_000, output: 60_000, total: 2_060_000 },
            cost: { total: 1.87 },
            stepsExecuted: 28,
            llmCalls: 27,
            finishReason: "budget_exceeded" as const,
          };
        }),
      });

      const deps = makeDeps({ eventBus });
      const msg = makeMessage();
      const cfg = makeBlockStreamCfg();

      await executeAndDeliver(
        deps, adapter, msg, msg, executor, sk, "agent-1",
        cfg, new Set(), makeSendOverrides(),
      );

      // Should send the canned resource-abort notification instead of silence
      expect(adapter.sendMessage).toHaveBeenCalledWith(
        "12345",
        "I've reached my processing limit for this request. Please try again or break the task into smaller steps.",
        expect.objectContaining({}),
      );
    });

    it("does NOT bypass abort signal for user-initiated /stop", async () => {
      const adapter = makeAdapter();
      const eventBus = makeEventBus();
      const handlers: Record<string, Function> = {};
      eventBus.on = vi.fn((event: string, handler: Function) => {
        handlers[event] = handler;
        return eventBus;
      });

      const sk = makeSessionKey();
      const executor = makeExecutor({
        execute: vi.fn(async () => {
          // Simulate user /stop — NOT a resource abort reason
          handlers["execution:aborted"]?.({
            sessionKey: sk,
            reason: "user_stop",
            agentId: "agent-1",
            timestamp: Date.now(),
          });
          return {
            response: "Some partial response",
            sessionKey: sk,
            tokensUsed: { input: 50_000, output: 5_000, total: 55_000 },
            cost: { total: 0.05 },
            stepsExecuted: 3,
            llmCalls: 3,
            finishReason: "stop" as const,
          };
        }),
      });

      const deps = makeDeps({ eventBus });
      const msg = makeMessage();
      const cfg = makeBlockStreamCfg();

      await executeAndDeliver(
        deps, adapter, msg, msg, executor, sk, "agent-1",
        cfg, new Set(), makeSendOverrides(),
      );

      // The original (aborted) signal should be passed to pacer, NOT a fresh one
      expect(capturedPacerConfig).toBeDefined();
      expect(capturedPacerConfig!.externalSignal).toBeDefined();
      expect(capturedPacerConfig!.externalSignal!.aborted).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // policy-retry path runWithContext must reuse ingress traceId
  // -------------------------------------------------------------------
  describe("policy-retry runWithContext reuses ingress traceId", () => {
    it("policy-deny path: executor sees ingress traceId, not a fresh mint", async () => {
      // The policy-deny path in executeAndDeliver calls runWithContext with
      // traceId: randomUUID() — it must reuse tryGetContext()?.traceId from
      // the outer scope.
      const ingressTraceId = "550e8400-e29b-41d4-a716-446655440003";

      let capturedTraceId: string | undefined;
      const executor = makeExecutor({
        execute: vi.fn(async () => {
          capturedTraceId = tryGetContext()?.traceId;
          return {
            response: "agent-response",
            sessionKey: { tenantId: "default", userId: "user-1", channelId: "12345" },
            tokensUsed: { input: 10, output: 5, total: 15 },
            cost: { total: 0 },
            stepsExecuted: 0,
            llmCalls: 1,
            finishReason: "stop" as const,
          };
        }),
      });

      const deps = makeDeps({
        sendPolicyConfig: {
          enabled: true,
          defaultAction: "deny",
          rules: [],
        },
      });

      // Simulate the outer ingress context from channel-manager / echo-adapter wrap
      await runWithContext(
        {
          traceId: ingressTraceId,
          startedAt: systemNowMs(),
          channelType: "echo",
        },
        () =>
          executeAndDeliver(
            deps,
            makeAdapter(),
            makeMessage(),
            makeMessage(),
            executor,
            makeSessionKey(),
            "agent-1",
            makeBlockStreamCfg(),
            new Set(),
            makeSendOverrides(),
          ),
      );

      // policy-retry path must inherit the ingress traceId
      expect(capturedTraceId, "policy-deny executor should see ingress traceId, not a fresh mint").toBe(ingressTraceId);
    });
  });
});
