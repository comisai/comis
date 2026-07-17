// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for channel-manager request-context ownership.
 *
 * Adapter dispatch owns the normal inbound scope. The manager preserves that
 * exact object and creates a fallback scope only for an unscoped adapter.
 *
 * @module
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChannelPort, NormalizedMessage, MessageHandler, DeliveryService } from "@comis/core";
import { ok } from "@comis/shared";
import { runWithContext, tryGetContext } from "@comis/core";
import { createMockLogger } from "../../../test/support/mock-logger.js";
import { createChannelManager, type ChannelManagerDeps } from "./channel-manager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(overrides?: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    channelId: "test-channel",
    channelType: "telegram",
    senderId: "user-1",
    text: "Hello",
    timestamp: Date.now(),
    attachments: [],
    metadata: {},
    ...overrides,
  };
}

function makeAdapter(
  overrides?: Partial<ChannelPort>,
): ChannelPort & { _handlers: MessageHandler[]; triggerMessage: (msg: NormalizedMessage) => Promise<void> } {
  const handlers: MessageHandler[] = [];
  return {
    _handlers: handlers,
    channelId: "telegram-123",
    channelType: "telegram",
    start: vi.fn(async () => ok(undefined)),
    stop: vi.fn(async () => ok(undefined)),
    sendMessage: vi.fn(async () => ok("msg-99")),
    onMessage: vi.fn((handler: MessageHandler) => {
      handlers.push(handler);
    }),
    async triggerMessage(msg: NormalizedMessage): Promise<void> {
      for (const h of handlers) {
        await h(msg);
      }
    },
    ...overrides,
  } as any;
}

function makeFakeDeliveryService(): DeliveryService {
  return {
    deliverToChannel: vi.fn(async () => ok({
      ok: true,
      totalChunks: 1,
      deliveredChunks: 1,
      failedChunks: 0,
      chunks: [{ ok: true, messageId: "stub", charCount: 5, retried: false }],
      totalChars: 5,
    })),
    drainInFlight: vi.fn(async () => ({ drained: 0, remaining: 0, durationMs: 0 })),
  };
}

function makeDeps(
  adapter: ChannelPort,
  processInboundMessage: ChannelManagerDeps["processInboundMessage"],
  overrides?: Partial<ChannelManagerDeps>,
): ChannelManagerDeps {
  const emit = vi.fn(() => true);
  return {
    tenantId: "default",
    eventBus: {
      emit,
      emitSafely: vi.fn((event, payload) => {
        emit(event, payload);
        return {
          hadListeners: false,
          failures: [],
          pendingFailures: Promise.resolve([]),
        };
      }),
      on: vi.fn().mockReturnThis(),
      off: vi.fn().mockReturnThis(),
      once: vi.fn().mockReturnThis(),
      removeAllListeners: vi.fn().mockReturnThis(),
      listenerCount: vi.fn(() => 0),
      setMaxListeners: vi.fn().mockReturnThis(),
    } as any,
    messageRouter: { resolve: vi.fn(() => "agent-default"), updateConfig: vi.fn() },
    sessionManager: {
      loadOrCreate: vi.fn(() => []),
      save: vi.fn(),
      isExpired: vi.fn(() => false),
      expire: vi.fn(() => true),
      cleanStale: vi.fn(() => 0),
    },
    createExecutor: vi.fn(() => ({
      execute: vi.fn(async () => ({
        response: "Response",
        sessionKey: { tenantId: "default", userId: "user-1", channelId: "test-channel" },
        tokensUsed: { input: 10, output: 5, total: 15 },
        cost: { total: 0.0001 },
        stepsExecuted: 0,
        finishReason: "stop" as const,
      })),
    })),
    adapters: [adapter],
    logger: createMockLogger(),
    deliveryService: makeFakeDeliveryService(),
    processInboundMessage,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("channel-manager -- adapter.onMessage request context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reuses the exact adapter context without shadowing it", async () => {
    const knownTrace = "550e8400-e29b-41d4-a716-446655440001";
    const ingressStartedAt = 1_700_000_000_000;
    let observedTrace: string | undefined;
    let observedChannelType: string | undefined;
    let observedStartedAt: number | undefined;
    let observedContext: ReturnType<typeof tryGetContext>;

    // processInboundMessage spy — captures the ALS context observable from inside
    const processSpy = vi.fn(async () => {
      const ctx = tryGetContext();
      observedTrace = ctx?.traceId;
      observedChannelType = ctx?.channelType;
      observedStartedAt = ctx?.startedAt;
      observedContext = ctx;
    });

    const adapter = makeAdapter();
    const manager = createChannelManager(
      makeDeps(adapter, processSpy as any),
    );
    await manager.startAll();

    // Inject a message with a pre-stamped traceId (simulates adapter ingress wrap)
    const ingressContext = {
      traceId: knownTrace,
      startedAt: ingressStartedAt,
      channelType: "telegram",
      tenantId: "default",
      trustLevel: "user",
    } as const;
    await runWithContext(
      ingressContext,
      () => adapter.triggerMessage(makeMessage({ metadata: { traceId: knownTrace } })),
    );

    expect(observedContext).toBe(ingressContext);
    expect(observedTrace).toBe(knownTrace);
    expect(observedChannelType).toBe("telegram");
    expect(observedStartedAt).toBe(ingressStartedAt);
  });

  it("falls back to a minted traceId when msg.metadata.traceId is absent (future-adapter defense)", async () => {
    let observedTrace: string | undefined;

    const processSpy = vi.fn(async () => {
      observedTrace = tryGetContext()?.traceId;
    });

    const adapter = makeAdapter();
    const manager = createChannelManager(
      makeDeps(adapter, processSpy as any),
    );
    await manager.startAll();

    // No traceId on message — simulates a future adapter that skips ingress wrap
    await adapter.triggerMessage(makeMessage({ metadata: {} }));

    expect(observedTrace).toBeDefined();
    expect(observedTrace).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("uses the configured tenant when establishing a fallback ingress scope", async () => {
    let observedTenantId: string | undefined;
    const processSpy = vi.fn(async () => {
      observedTenantId = tryGetContext()?.tenantId;
    });
    const adapter = makeAdapter();
    const manager = createChannelManager(makeDeps(adapter, processSpy as any, {
      tenantId: "tenant-production",
    }));
    await manager.startAll();

    await adapter.triggerMessage(makeMessage({ metadata: {} }));

    expect(observedTenantId).toBe("tenant-production");
  });

  it("creates a fresh fallback scope for an untraced custom message under unrelated same-channel context", async () => {
    const ambientContext = {
      traceId: "550e8400-e29b-41d4-a716-446655440010",
      startedAt: 1_700_000_000_000,
      channelType: "telegram",
      tenantId: "default",
      trustLevel: "user",
      agentId: "already-resolved-agent",
      userId: "other-user",
      sessionKey: "default:other-user:other-channel:peer:other-user",
    } as const;
    let observedContext: ReturnType<typeof tryGetContext>;
    let observedMessage: NormalizedMessage | undefined;
    const processSpy = vi.fn(async (_deps, _adapter, msg) => {
      observedContext = tryGetContext();
      observedMessage = msg;
    });
    const adapter = makeAdapter();
    const manager = createChannelManager(makeDeps(adapter, processSpy as any));
    await manager.startAll();

    await runWithContext(
      ambientContext,
      () => adapter.triggerMessage(makeMessage({ metadata: {} })),
    );

    expect(observedContext).not.toBe(ambientContext);
    expect(observedContext).toMatchObject({
      channelType: "telegram",
      tenantId: "default",
      trustLevel: "user",
    });
    expect(observedContext?.traceId).not.toBe(ambientContext.traceId);
    expect(observedMessage?.metadata.traceId).toBe(observedContext?.traceId);
    expect(observedContext?.agentId).toBeUndefined();
    expect(observedContext?.sessionKey).toBeUndefined();
  });

  it("drops an explicitly traced message when ambient trace correlation conflicts", async () => {
    const messageTrace = "550e8400-e29b-41d4-a716-446655440011";
    const ambientContext = {
      traceId: "550e8400-e29b-41d4-a716-446655440012",
      startedAt: 1_700_000_000_000,
      channelType: "telegram",
      tenantId: "default",
      trustLevel: "user",
    } as const;
    const processSpy = vi.fn(async () => undefined);
    const adapter = makeAdapter();
    const deps = makeDeps(adapter, processSpy as any);
    const manager = createChannelManager(deps);
    await manager.startAll();
    const msg = makeMessage({ metadata: { traceId: messageTrace } });

    await runWithContext(ambientContext, () => adapter.triggerMessage(msg));

    expect(processSpy).not.toHaveBeenCalled();
    const terminals = vi.mocked(deps.eventBus.emit).mock.calls.filter(
      ([event]) => event === "message:terminal",
    );
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.[1]).toMatchObject({
      channelType: "telegram",
      channelId: msg.channelId,
      sourceMessageId: msg.id,
      outcome: "error",
      reason: "inbound_rejected",
    });
  });

  it("drops a correlated trace when the ambient context is already resolved", async () => {
    const knownTrace = "550e8400-e29b-41d4-a716-446655440013";
    const resolvedContext = {
      traceId: knownTrace,
      startedAt: 1_700_000_000_000,
      channelType: "telegram",
      tenantId: "default",
      trustLevel: "user",
      agentId: "other-agent",
      userId: "other-user",
      sessionKey: "default:other-user:other-channel:peer:other-user",
    } as const;
    const processSpy = vi.fn(async () => undefined);
    const adapter = makeAdapter();
    const deps = makeDeps(adapter, processSpy as any);
    const manager = createChannelManager(deps);
    await manager.startAll();

    await runWithContext(
      resolvedContext,
      () => adapter.triggerMessage(makeMessage({ metadata: { traceId: knownTrace } })),
    );

    expect(processSpy).not.toHaveBeenCalled();
    expect(vi.mocked(deps.eventBus.emit).mock.calls.filter(
      ([event]) => event === "message:terminal",
    )).toHaveLength(1);
  });

  it("drops a correlated trace carrying an unknown unresolved trust value", async () => {
    const knownTrace = "550e8400-e29b-41d4-a716-446655440014";
    const malformedContext = {
      traceId: knownTrace,
      startedAt: 1_700_000_000_000,
      channelType: "telegram",
      tenantId: "default",
      trustLevel: "operator",
    } as any;
    const processSpy = vi.fn(async () => undefined);
    const adapter = makeAdapter();
    const deps = makeDeps(adapter, processSpy as any);
    const manager = createChannelManager(deps);
    await manager.startAll();

    await runWithContext(
      malformedContext,
      () => adapter.triggerMessage(makeMessage({ metadata: { traceId: knownTrace } })),
    );

    expect(processSpy).not.toHaveBeenCalled();
    expect(vi.mocked(deps.eventBus.emit).mock.calls.filter(
      ([event]) => event === "message:terminal",
    )).toHaveLength(1);
  });

  it("drops an envelope whose channel does not match the receiving adapter", async () => {
    const processSpy = vi.fn(async () => undefined);
    const adapter = makeAdapter();
    const deps = makeDeps(adapter, processSpy as any);
    const manager = createChannelManager(deps);
    await manager.startAll();
    const msg = makeMessage({ channelType: "discord" });

    await adapter.triggerMessage(msg);

    expect(processSpy).not.toHaveBeenCalled();
    expect(vi.mocked(deps.eventBus.emit).mock.calls.filter(
      ([event]) => event === "message:terminal",
    )).toHaveLength(1);
  });

  it("publishes the mismatch terminal even when diagnostic logging throws", async () => {
    const processSpy = vi.fn(async () => undefined);
    const adapter = makeAdapter();
    const logger = createMockLogger();
    vi.mocked(logger.error).mockImplementation(() => {
      throw new Error("diagnostic sink unavailable");
    });
    const deps = makeDeps(adapter, processSpy as any, { logger });
    const manager = createChannelManager(deps);
    await manager.startAll();

    await expect(adapter.triggerMessage(
      makeMessage({ channelType: "discord" }),
    )).resolves.toBeUndefined();

    expect(processSpy).not.toHaveBeenCalled();
    expect(vi.mocked(deps.eventBus.emit).mock.calls.filter(
      ([event]) => event === "message:terminal",
    )).toHaveLength(1);
  });

  it("channelType in runWithContext matches adapter.channelType", async () => {
    let observedChannelType: string | undefined;

    const processSpy = vi.fn(async () => {
      observedChannelType = tryGetContext()?.channelType;
    });

    const adapter = makeAdapter({ channelType: "discord", channelId: "discord-456" });
    const manager = createChannelManager(
      makeDeps(adapter, processSpy as any),
    );
    await manager.startAll();

    await adapter.triggerMessage(
      makeMessage({ channelType: "discord", metadata: { traceId: "550e8400-e29b-41d4-a716-446655440002" } }),
    );

    expect(observedChannelType).toBe("discord");
  });
});
