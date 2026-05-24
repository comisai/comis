// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for orchestrator channel-manager runWithContext wrap (TRACE-01).
 *
 * Asserts that the adapter.onMessage handler body wraps in runWithContext —
 * defense-in-depth at the orchestrator level. The wrap reuses the traceId
 * minted at adapter ingress (Plans 01-02, 01-03) via getMessageTraceId, and
 * falls back to randomUUID() if a future adapter bypasses ingress wrapping.
 *
 * RED state: fails before the runWithContext wrap is added to channel-manager.ts
 * (tryGetContext() returns undefined inside processInboundMessage).
 *
 * @module
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChannelPort, NormalizedMessage, MessageHandler, DeliveryService } from "@comis/core";
import { ok } from "@comis/shared";
import { tryGetContext } from "@comis/core";
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
  return {
    eventBus: {
      emit: vi.fn(() => true),
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

describe("channel-manager -- adapter.onMessage handler runWithContext wrap (TRACE-01)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("wraps onMessage handler body in runWithContext using adapter-minted traceId (defense-in-depth)", async () => {
    const knownTrace = "550e8400-e29b-41d4-a716-446655440001";
    let observedTrace: string | undefined;
    let observedChannelType: string | undefined;

    // processInboundMessage spy — captures the ALS context observable from inside
    const processSpy = vi.fn(async () => {
      const ctx = tryGetContext();
      observedTrace = ctx?.traceId;
      observedChannelType = ctx?.channelType;
    });

    const adapter = makeAdapter();
    const manager = createChannelManager(
      makeDeps(adapter, processSpy as any),
    );
    await manager.startAll();

    // Inject a message with a pre-stamped traceId (simulates adapter ingress wrap)
    await adapter.triggerMessage(makeMessage({ metadata: { traceId: knownTrace } }));

    expect(observedTrace).toBe(knownTrace);
    expect(observedChannelType).toBe("telegram");
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
