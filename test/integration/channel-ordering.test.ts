// SPDX-License-Identifier: Apache-2.0
/**
 * Channel Message Ordering Integration Tests
 *
 * Package-level integration tests verifying that the channel message pipeline
 * delivers messages in correct order across three scenarios:
 *   - Sequential delivery ordering
 *   - Coalesced collect-mode delivery with numbered delimiters
 *   - Interleaved multi-channel per-channel ordering
 *
 * These tests construct the pipeline directly (createChannelManager +
 * EchoChannelAdapter) with minimal mocked deps instead of starting a full
 * daemon, providing fast and deterministic verification.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { EchoChannelAdapter } from "@comis/channels";
// createChannelManager + ChannelManagerDeps live in @comis/orchestrator
// alongside processInboundMessage. The dep-inject indirection is preserved
// (daemon + this integration test wire processInboundMessage explicitly).
import {
  createChannelManager,
  processInboundMessage,
  type ChannelManagerDeps,
  createCommandQueue,
  coalesceMessages,
} from "@comis/orchestrator";
import {
  QueueConfigSchema,
  createDeliveryService,
  createNoOpDeliveryQueue,
  createHookRunner,
  createPluginRegistry,
} from "@comis/core";
import type { NormalizedMessage, ChannelPort, ComisLogger } from "@comis/core";
import { ASYNC_SETTLE_MS } from "../support/timeouts.js";

/**
 * Build a real DeliveryService for integration: empty plugin registry +
 * no-op queue. ChannelManagerDeps requires a DeliveryService. The
 * DeliveryService captures these in closure and is shared across all
 * makeMinimalDeps callers below.
 */
function makeRealDeliveryService(eventBus: any) {
  const logger = {
    level: "silent",
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    audit: vi.fn(),
    child: vi.fn(),
  } as unknown as ComisLogger;
  vi.mocked(logger.child).mockReturnValue(logger);
  return createDeliveryService({
    hookRunner: createHookRunner(createPluginRegistry(), { eventBus, catchErrors: true }),
    deliveryQueue: createNoOpDeliveryQueue(),
    logger,
    eventBus,
  });
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Create a NormalizedMessage with sensible defaults for testing.
 * Overrides are spread last, so any field can be customized.
 */
function makeMessage(overrides?: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    id: randomUUID(),
    channelId: "echo-test",
    channelType: "echo",
    senderId: "user-1",
    text: "Hello from test",
    timestamp: Date.now(),
    attachments: [],
    metadata: {},
    ...overrides,
  };
}

/**
 * Create a mock TypedEventBus with all required methods stubbed.
 * Cast as `any` for TypedEventBus compatibility since we only need
 * the shape, not the generic type safety, for test wiring.
 */
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

/**
 * Create minimal ChannelManagerDeps with real adapters and mocked
 * infrastructure (executor, router, session manager, logger, event bus).
 *
 * @param adapters - Real channel adapters to wire into the manager
 * @param executorOverrides - Optional overrides for the mock executor's execute function
 */
function makeMinimalDeps(
  adapters: ChannelPort[],
  executorOverrides?: { execute: (...args: any[]) => Promise<any> },
): ChannelManagerDeps {
  const executor = {
    execute: executorOverrides?.execute ?? vi.fn(async (msg: NormalizedMessage) => ({
      response: `Echo: ${msg.text}`,
      sessionKey: {
        tenantId: "default",
        userId: msg.senderId,
        channelId: msg.channelId,
      },
      tokensUsed: { input: 10, output: 5, total: 15 },
      cost: { total: 0.001 },
      stepsExecuted: 0,
      finishReason: "stop" as const,
    })),
  };

  const eventBus = makeEventBus();
  return {
    eventBus,
    messageRouter: { resolve: vi.fn(() => "default"), updateConfig: vi.fn() },
    sessionManager: {
      loadOrCreate: vi.fn(() => []),
      save: vi.fn(),
      isExpired: vi.fn(() => false),
      expire: vi.fn(() => true),
      cleanStale: vi.fn(() => 0),
    },
    createExecutor: vi.fn(() => executor),
    adapters,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    // DeliveryService is required on ChannelManagerDeps. Constructed once
    // per deps object so the inbound pipeline closes over a working service
    // when it delivers responses (and rejects gracefully when no hooks/queue
    // are wired — both empty in this integration test).
    deliveryService: makeRealDeliveryService(eventBus),
    // processInboundMessage is dep-injected to avoid back-edges between
    // packages. Integration test wires the real implementation.
    processInboundMessage: processInboundMessage as unknown as ChannelManagerDeps["processInboundMessage"],
  };
}

// ---------------------------------------------------------------------------
// Sequential message ordering
// ---------------------------------------------------------------------------

describe("Sequential message ordering", () => {
  it("sends 5 sequential messages and receives responses in order", async () => {
    const adapter = new EchoChannelAdapter({ channelId: "echo-seq", channelType: "echo" });
    const deps = makeMinimalDeps([adapter]);
    const manager = createChannelManager(deps);
    await manager.startAll();

    for (let i = 0; i < 5; i++) {
      await adapter.injectMessage(
        makeMessage({ text: `msg-${i}`, channelType: "echo" }),
      );
    }

    // Wait for async pipeline (executor + block pacer) to complete
    await new Promise((r) => setTimeout(r, ASYNC_SETTLE_MS * 3));

    const sent = adapter.getSentMessages();
    expect(sent.length).toBeGreaterThanOrEqual(5);

    // Verify ordering: response for msg-0 appears before msg-1, etc.
    // The executor echoes the input text as "Echo: msg-N", and the block
    // pacer delivers blocks in order. Verify relative ordering.
    for (let i = 0; i < 5; i++) {
      const matchingIdx = sent.findIndex((s) => s.text.includes(`msg-${i}`));
      expect(matchingIdx).toBeGreaterThanOrEqual(0);
      if (i > 0) {
        const prevIdx = sent.findIndex((s) => s.text.includes(`msg-${i - 1}`));
        expect(prevIdx).toBeLessThan(matchingIdx);
      }
    }

    await manager.stopAll();
  });

  it("sends 10 sequential messages without message loss", async () => {
    const adapter = new EchoChannelAdapter({ channelId: "echo-seq-10", channelType: "echo" });
    const deps = makeMinimalDeps([adapter]);
    const manager = createChannelManager(deps);
    await manager.startAll();

    for (let i = 0; i < 10; i++) {
      await adapter.injectMessage(
        makeMessage({ text: `seq-${i}`, channelType: "echo" }),
      );
    }

    // Wait for async pipeline to complete
    await new Promise((r) => setTimeout(r, ASYNC_SETTLE_MS * 5));

    const sent = adapter.getSentMessages();
    expect(sent.length).toBeGreaterThanOrEqual(10);

    // Verify no duplicate message IDs in sent results
    const sentIds = sent.map((s) => s.id);
    const uniqueIds = new Set(sentIds);
    expect(uniqueIds.size).toBe(sentIds.length);

    await manager.stopAll();
  });
});

// ---------------------------------------------------------------------------
// Coalesced message delimiter ordering
// ---------------------------------------------------------------------------

describe("Coalesced message delimiter ordering", () => {
  it("coalesceMessages produces [Message N]: delimiters in ascending order", () => {
    // Direct test of the coalescer function that the pipeline uses
    const messages = [
      makeMessage({ text: "first" }),
      makeMessage({ text: "second" }),
      makeMessage({ text: "third" }),
    ];

    const coalesced = coalesceMessages(messages);

    // Verify the coalesced text contains all three messages with numbered delimiters
    expect(coalesced.text).toContain("[Message 1]: first");
    expect(coalesced.text).toContain("[Message 2]: second");
    expect(coalesced.text).toContain("[Message 3]: third");

    // Verify ordering: [Message 1] before [Message 2] before [Message 3]
    const idx1 = coalesced.text.indexOf("[Message 1]:");
    const idx2 = coalesced.text.indexOf("[Message 2]:");
    const idx3 = coalesced.text.indexOf("[Message 3]:");
    expect(idx1).toBeLessThan(idx2);
    expect(idx2).toBeLessThan(idx3);
  });

  it("messages coalesced during active execution preserve [Message N]: ordering", async () => {
    const adapter = new EchoChannelAdapter({ channelId: "echo-coalesce", channelType: "echo" });

    // Slow executor to keep the lane busy while subsequent messages arrive
    const slowExecute = vi.fn(async (msg: NormalizedMessage) => {
      await new Promise((r) => setTimeout(r, 300));
      return {
        response: `Coalesced: ${msg.text}`,
        sessionKey: {
          tenantId: "default",
          userId: msg.senderId,
          channelId: msg.channelId,
        },
        tokensUsed: { input: 10, output: 5, total: 15 },
        cost: { total: 0.001 },
        stepsExecuted: 0,
        finishReason: "stop" as const,
      };
    });

    // Configure CommandQueue in collect mode
    const queueConfig = QueueConfigSchema.parse({
      maxConcurrentSessions: 1,
      defaultMode: "collect",
      defaultOverflow: { maxDepth: 20, policy: "drop-new" },
      defaultDebounceMs: 0,
    });

    const queue = createCommandQueue({
      eventBus: makeEventBus(),
      config: queueConfig,
    });

    const deps = makeMinimalDeps([adapter], { execute: slowExecute });
    deps.commandQueue = queue;

    const manager = createChannelManager(deps);
    await manager.startAll();

    // Fire first message (starts execution, lane becomes busy)
    // Do NOT await -- let it start processing asynchronously
    void adapter.injectMessage(
      makeMessage({
        text: "first",
        senderId: "user-coalesce",
        channelId: "echo-coalesce",
        channelType: "echo",
      }),
    );

    // Wait a brief moment so the first message enters the executor
    await new Promise((r) => setTimeout(r, 50));

    // Fire second and third messages while lane is busy (they get collected)
    void adapter.injectMessage(
      makeMessage({
        text: "second",
        senderId: "user-coalesce",
        channelId: "echo-coalesce",
        channelType: "echo",
      }),
    );
    void adapter.injectMessage(
      makeMessage({
        text: "third",
        senderId: "user-coalesce",
        channelId: "echo-coalesce",
        channelType: "echo",
      }),
    );

    // Wait for queue to drain and pipeline to settle
    await queue.drainAll();
    await new Promise((r) => setTimeout(r, ASYNC_SETTLE_MS * 5));

    // The executor should have been called at least 2 times:
    //   1st call: the "first" message (individual)
    //   2nd call: the coalesced "second" + "third" message
    expect(slowExecute.mock.calls.length).toBeGreaterThanOrEqual(2);

    // Find the coalesced call -- it should contain [Message 1]: and [Message 2]:
    const coalescedCall = slowExecute.mock.calls.find(
      (call) => call[0].text.includes("[Message 1]:"),
    );
    expect(coalescedCall).toBeDefined();

    const coalescedText = coalescedCall![0].text as string;
    expect(coalescedText).toContain("[Message 1]:");
    expect(coalescedText).toContain("[Message 2]:");

    // Verify delimiter ordering
    const msgIdx1 = coalescedText.indexOf("[Message 1]:");
    const msgIdx2 = coalescedText.indexOf("[Message 2]:");
    expect(msgIdx1).toBeLessThan(msgIdx2);

    await manager.stopAll();
    await queue.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Interleaved multi-channel ordering
// ---------------------------------------------------------------------------

describe("Interleaved multi-channel ordering", () => {
  it("messages from two channels maintain per-channel ordering under interleaving", async () => {
    // Use DISTINCT channelTypes to prevent session key collisions
    const adapterA = new EchoChannelAdapter({ channelId: "ch-a", channelType: "echo-a" });
    const adapterB = new EchoChannelAdapter({ channelId: "ch-b", channelType: "echo-b" });

    const deps = makeMinimalDeps([adapterA, adapterB]);
    const manager = createChannelManager(deps);
    await manager.startAll();

    // Interleave messages from both channels
    await adapterA.injectMessage(
      makeMessage({ text: "A1", channelType: "echo-a", channelId: "ch-a", senderId: "user-a" }),
    );
    await adapterB.injectMessage(
      makeMessage({ text: "B1", channelType: "echo-b", channelId: "ch-b", senderId: "user-b" }),
    );
    await adapterA.injectMessage(
      makeMessage({ text: "A2", channelType: "echo-a", channelId: "ch-a", senderId: "user-a" }),
    );
    await adapterB.injectMessage(
      makeMessage({ text: "B2", channelType: "echo-b", channelId: "ch-b", senderId: "user-b" }),
    );
    await adapterA.injectMessage(
      makeMessage({ text: "A3", channelType: "echo-a", channelId: "ch-a", senderId: "user-a" }),
    );
    await adapterB.injectMessage(
      makeMessage({ text: "B3", channelType: "echo-b", channelId: "ch-b", senderId: "user-b" }),
    );

    // Wait for async pipeline to complete
    await new Promise((r) => setTimeout(r, ASYNC_SETTLE_MS * 5));

    const sentA = adapterA.getSentMessages();
    const sentB = adapterB.getSentMessages();

    // Each adapter should have received at least 3 responses (one per injected message)
    expect(sentA.length).toBeGreaterThanOrEqual(3);
    expect(sentB.length).toBeGreaterThanOrEqual(3);

    // Verify per-channel ordering for channel A: A1 before A2 before A3
    const idxA1 = sentA.findIndex((s) => s.text.includes("A1"));
    const idxA2 = sentA.findIndex((s) => s.text.includes("A2"));
    const idxA3 = sentA.findIndex((s) => s.text.includes("A3"));
    expect(idxA1).toBeGreaterThanOrEqual(0);
    expect(idxA2).toBeGreaterThanOrEqual(0);
    expect(idxA3).toBeGreaterThanOrEqual(0);
    expect(idxA1).toBeLessThan(idxA2);
    expect(idxA2).toBeLessThan(idxA3);

    // Verify per-channel ordering for channel B: B1 before B2 before B3
    const idxB1 = sentB.findIndex((s) => s.text.includes("B1"));
    const idxB2 = sentB.findIndex((s) => s.text.includes("B2"));
    const idxB3 = sentB.findIndex((s) => s.text.includes("B3"));
    expect(idxB1).toBeGreaterThanOrEqual(0);
    expect(idxB2).toBeGreaterThanOrEqual(0);
    expect(idxB3).toBeGreaterThanOrEqual(0);
    expect(idxB1).toBeLessThan(idxB2);
    expect(idxB2).toBeLessThan(idxB3);

    // Cross-channel ordering is NOT guaranteed (A1 before B1 is not required),
    // but per-channel ordering IS guaranteed -- which is what we've verified above.

    await manager.stopAll();
  });
});
