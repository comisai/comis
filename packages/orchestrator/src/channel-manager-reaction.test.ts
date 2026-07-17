// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the orchestrator channel-manager inbound-reaction fanout.
 *
 * Asserts that startAll registers `adapter.onReaction?.(...)` (optional-call
 * form) for reaction-capable adapters and emits a `channel:reaction_received`
 * bus event (ids/emoji only) per reaction — and that a no-op adapter (one that
 * omits onReaction) registers nothing and emits nothing.
 *
 * @module
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  ChannelPort,
  NormalizedMessage,
  NormalizedReaction,
  ReactionHandler,
  MessageHandler,
  DeliveryService,
} from "@comis/core";
import { ok } from "@comis/shared";
import { createMockLogger } from "../../../test/support/mock-logger.js";
import { createChannelManager, type ChannelManagerDeps } from "./channel-manager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReaction(overrides?: Partial<NormalizedReaction>): NormalizedReaction {
  return {
    messageId: "msg-200",
    reactorId: "user-9",
    emoji: "👍",
    channelType: "discord",
    channelId: "chan-7",
    ...overrides,
  };
}

/** A reaction-capable adapter: captures onReaction handlers, exposes a trigger. */
function makeReactionAdapter(
  overrides?: Partial<ChannelPort>,
): ChannelPort & { triggerReaction: (r: NormalizedReaction) => Promise<void> } {
  const messageHandlers: MessageHandler[] = [];
  const reactionHandlers: ReactionHandler[] = [];
  return {
    channelId: "discord-123",
    channelType: "discord",
    start: vi.fn(async () => ok(undefined)),
    stop: vi.fn(async () => ok(undefined)),
    sendMessage: vi.fn(async () => ok("msg-99")),
    onMessage: vi.fn((handler: MessageHandler) => { messageHandlers.push(handler); }),
    onReaction: vi.fn((handler: ReactionHandler) => { reactionHandlers.push(handler); }),
    async triggerReaction(r: NormalizedReaction): Promise<void> {
      for (const h of reactionHandlers) {
        await h(r);
      }
    },
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/** A no-op adapter: omits onReaction entirely (honest no-op, like iMessage). */
function makeNoReactionAdapter(): ChannelPort {
  const messageHandlers: MessageHandler[] = [];
  return {
    channelId: "echo-1",
    channelType: "echo",
    start: vi.fn(async () => ok(undefined)),
    stop: vi.fn(async () => ok(undefined)),
    sendMessage: vi.fn(async () => ok("msg-1")),
    onMessage: vi.fn((handler: MessageHandler) => { messageHandlers.push(handler); }),
    // NO onReaction — the optional-call form must skip it cleanly.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

function makeDeps(adapter: ChannelPort, overrides?: Partial<ChannelManagerDeps>): ChannelManagerDeps {
  return {
    tenantId: "default",
    eventBus: {
      emit: vi.fn(() => true),
      on: vi.fn().mockReturnThis(),
      off: vi.fn().mockReturnThis(),
      once: vi.fn().mockReturnThis(),
      removeAllListeners: vi.fn().mockReturnThis(),
      listenerCount: vi.fn(() => 0),
      setMaxListeners: vi.fn().mockReturnThis(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    processInboundMessage: vi.fn(async () => {}),
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("channel-manager -- inbound reaction fanout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers adapter.onReaction and emits channel:reaction_received with ids/emoji on a reaction", async () => {
    const adapter = makeReactionAdapter();
    const deps = makeDeps(adapter);
    const manager = createChannelManager(deps);
    await manager.startAll();

    expect(adapter.onReaction).toHaveBeenCalledTimes(1);

    await adapter.triggerReaction(makeReaction());

    const emit = vi.mocked(deps.eventBus.emit);
    const reactionEmit = emit.mock.calls.find((c) => c[0] === "channel:reaction_received");
    expect(reactionEmit).toBeDefined();
    const payload = reactionEmit?.[1] as Record<string, unknown>;
    expect(payload.messageId).toBe("msg-200");
    expect(payload.reactorId).toBe("user-9");
    expect(payload.emoji).toBe("👍");
    expect(payload.channelType).toBe("discord");
    expect(payload.channelId).toBe("chan-7");
    expect(typeof payload.timestamp).toBe("number");
    // SEC: no message body / sender name leaks onto the bus.
    expect(payload.text).toBeUndefined();
    expect(payload.senderName).toBeUndefined();
  });

  it("does NOT crash and emits no reaction event for a no-op adapter that omits onReaction", async () => {
    const adapter = makeNoReactionAdapter();
    const deps = makeDeps(adapter);
    const manager = createChannelManager(deps);

    // The optional-call form adapter.onReaction?.(...) must be a clean no-op.
    await expect(manager.startAll()).resolves.toBeUndefined();

    const emit = vi.mocked(deps.eventBus.emit);
    const reactionEmit = emit.mock.calls.find((c) => c[0] === "channel:reaction_received");
    expect(reactionEmit).toBeUndefined();
  });

  it("validates the binder-built reaction through parseReaction at the fanout boundary — an invalid reaction (empty messageId) is REJECTED and NOT emitted", async () => {
    const adapter = makeReactionAdapter();
    const deps = makeDeps(adapter);
    const manager = createChannelManager(deps);
    await manager.startAll();

    // An untrusted reaction with an empty messageId violates the
    // NormalizedReaction strictObject (z.string().min(1)). The fanout must run it
    // through parseReaction and DROP it (fail-closed) rather than emitting an
    // invalid content-free event onto the bus.
    await adapter.triggerReaction(makeReaction({ messageId: "" }) as never);

    const emit = vi.mocked(deps.eventBus.emit);
    const reactionEmit = emit.mock.calls.find((c) => c[0] === "channel:reaction_received");
    expect(reactionEmit).toBeUndefined();
  });

  it("a VALID binder-built reaction still passes parseReaction and is emitted (no false rejection of well-formed inbound)", async () => {
    const adapter = makeReactionAdapter();
    const deps = makeDeps(adapter);
    const manager = createChannelManager(deps);
    await manager.startAll();

    await adapter.triggerReaction(makeReaction({ messageId: "msg-ok", emoji: "✅" }));

    const emit = vi.mocked(deps.eventBus.emit);
    const reactionEmit = emit.mock.calls.find((c) => c[0] === "channel:reaction_received");
    expect(reactionEmit).toBeDefined();
    const payload = reactionEmit?.[1] as Record<string, unknown>;
    expect(payload.messageId).toBe("msg-ok");
    expect(payload.emoji).toBe("✅");
  });
});
