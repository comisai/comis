// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for delivery subsystem wiring: queue (drain, prune, disabled paths)
 * and mirror (hook registration, prune timer, disabled path).
 * Covers queue drain/prune/disabled paths and mirror hook registration, prune timer, and disabled path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ok, err } from "@comis/shared";
import type { DeliveryQueuePort, DeliveryQueueEntry } from "@comis/core";
import type { DeliveryMirrorPort, DeliveryMirrorEntry, PluginPort, PluginRegistryApi } from "@comis/core";
import type { DeliveryAdapter } from "@comis/channels";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { createMockEventBus } from "../../../../test/support/mock-event-bus.js";

// ===========================================================================
// Queue helpers and mocks
// ===========================================================================

function makeEntry(overrides: Partial<DeliveryQueueEntry> = {}): DeliveryQueueEntry {
  return {
    id: "entry-1",
    text: "hello",
    channelType: "telegram",
    channelId: "chat-1",
    tenantId: "default",
    optionsJson: "{}",
    origin: "test",
    formatApplied: true,
    chunkingApplied: true,
    status: "pending",
    attemptCount: 0,
    maxAttempts: 5,
    createdAt: Date.now(),
    scheduledAt: Date.now(),
    expireAt: Date.now() + 3_600_000,
    lastAttemptAt: null,
    nextRetryAt: null,
    lastError: null,
    markdownFallbackApplied: false,
    deliveredMessageId: null,
    traceId: null,
    ...overrides,
  };
}

function createMockQueue(): DeliveryQueuePort & {
  ackCalls: Array<{ id: string; messageId: string }>;
  failCalls: Array<{ id: string; error: string }>;
  nackCalls: Array<{ id: string; error: string; nextRetryAt: number }>;
} {
  const ackCalls: Array<{ id: string; messageId: string }> = [];
  const failCalls: Array<{ id: string; error: string }> = [];
  const nackCalls: Array<{ id: string; error: string; nextRetryAt: number }> = [];

  return {
    ackCalls,
    failCalls,
    nackCalls,
    enqueue: vi.fn(async () => ok("new-id")),
    ack: vi.fn(async (id: string, messageId: string) => { ackCalls.push({ id, messageId }); return ok(undefined); }),
    nack: vi.fn(async (id: string, error: string, nextRetryAt: number) => { nackCalls.push({ id, error, nextRetryAt }); return ok(undefined); }),
    fail: vi.fn(async (id: string, error: string) => { failCalls.push({ id, error }); return ok(undefined); }),
    pendingEntries: vi.fn(async () => ok([] as DeliveryQueueEntry[])),
    pruneExpired: vi.fn(async () => ok(0)),
    depth: vi.fn(async () => ok(0)),
  };
}

function createMockAdapter(channelType: string, sendResults: Array<{ ok: true; value: string } | { ok: false; error: Error }> = []): DeliveryAdapter {
  let callIndex = 0;
  return {
    channelType,
    sendMessage: vi.fn(async () => {
      const result = sendResults[callIndex] ?? { ok: true as const, value: `msg-${callIndex}` };
      callIndex++;
      if (result.ok) return ok(result.value);
      return err(result.error);
    }),
  };
}

// ===========================================================================
// Mirror helpers
// ===========================================================================

function createMockMirror(): DeliveryMirrorPort & {
  recordCalls: Array<Record<string, unknown>>;
} {
  const recordCalls: Array<Record<string, unknown>> = [];
  return {
    recordCalls,
    record: vi.fn(async (entry: Record<string, unknown>) => { recordCalls.push(entry); return ok("test-id"); }),
    pending: vi.fn(async () => ok([] as DeliveryMirrorEntry[])),
    acknowledge: vi.fn(async () => ok(undefined)),
    pruneOld: vi.fn(async () => ok(0)),
  };
}

function createMockPluginRegistry(): {
  register: ReturnType<typeof vi.fn>;
  registeredPlugins: PluginPort[];
  capturedHooks: Map<string, Function>;
} {
  const registeredPlugins: PluginPort[] = [];
  const capturedHooks = new Map<string, Function>();

  return {
    registeredPlugins,
    capturedHooks,
    register: vi.fn((plugin: PluginPort) => {
      registeredPlugins.push(plugin);
      // Simulate the registry calling plugin.register() with a mock API
      const api: PluginRegistryApi = {
        registerHook(hookName: string, handler: Function) {
          capturedHooks.set(hookName, handler);
        },
        registerTool() {},
        registerHttpRoute() {},
        registerConfigSchema() {},
      } as unknown as PluginRegistryApi;
      plugin.register(api);
      return ok(undefined);
    }),
  };
}

// ===========================================================================
// Shared helpers
// ===========================================================================

function createMockConfig(overrides: Record<string, unknown> = {}): any {
  return {
    deliveryQueue: {
      enabled: true,
      maxQueueDepth: 10_000,
      defaultMaxAttempts: 5,
      defaultExpireMs: 3_600_000,
      drainOnStartup: true,
      drainBudgetMs: 60_000,
      pruneIntervalMs: 300_000,
      ...overrides,
    },
  };
}

function createMockMirrorConfig(overrides: Record<string, unknown> = {}): any {
  return {
    deliveryMirror: {
      enabled: true,
      retentionMs: 3_600_000,
      pruneIntervalMs: 300_000,
      maxEntriesPerInjection: 10,
      maxCharsPerInjection: 4000,
      ...overrides,
    },
  };
}

// Mock createSqliteDeliveryQueue and createNoOpDeliveryQueue
const mockSqliteQueue = createMockQueue();
const mockSqliteMirror = createMockMirror();
vi.mock("@comis/memory", () => ({
  createSqliteDeliveryQueue: () => mockSqliteQueue,
  createSqliteDeliveryMirror: () => mockSqliteMirror,
}));

const mockNoOpQueue = createMockQueue();
const mockNoOpMirror = createMockMirror();
vi.mock("@comis/core", async (importOriginal) => {
  const original = await importOriginal<typeof import("@comis/core")>();
  return {
    ...original,
    createNoOpDeliveryQueue: () => mockNoOpQueue,
    createNoOpDeliveryMirror: () => mockNoOpMirror,
  };
});

// Inline import to avoid ESM issues with mock setup
const { setupDeliveryQueue, setupDeliveryMirror } = await import("./setup-delivery.js");

// ===========================================================================
// Queue tests
// ===========================================================================

describe("setupDeliveryQueue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSqliteQueue.ackCalls.length = 0;
    mockSqliteQueue.failCalls.length = 0;
    mockSqliteQueue.nackCalls.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns no-op queue when disabled", async () => {
    const result = await setupDeliveryQueue({
      db: {} as any,
      config: createMockConfig({ enabled: false }),
      eventBus: createMockEventBus(),
      logger: createMockLogger(),
      channelAdapters: new Map(),
    });

    expect(result.deliveryQueue).toBe(mockNoOpQueue);
    await result.drainAndStartPrune(); // should be no-op
    result.shutdown(); // should be no-op
  });

  it("creates SQLite queue when enabled", async () => {
    const result = await setupDeliveryQueue({
      db: {} as any,
      config: createMockConfig(),
      eventBus: createMockEventBus(),
      logger: createMockLogger(),
      channelAdapters: new Map(),
    });

    expect(result.deliveryQueue).toBe(mockSqliteQueue);
    result.shutdown();
  });

  describe("drain", () => {
    it("drains pending entries: 2 succeed, 1 fails permanently", async () => {
      const entries = [
        makeEntry({ id: "e1", channelType: "telegram", text: "msg1" }),
        makeEntry({ id: "e2", channelType: "telegram", text: "msg2" }),
        makeEntry({ id: "e3", channelType: "telegram", text: "msg3" }),
      ];
      vi.mocked(mockSqliteQueue.pendingEntries).mockResolvedValueOnce(ok(entries));

      const adapter = createMockAdapter("telegram", [
        { ok: true, value: "m1" },
        { ok: true, value: "m2" },
        { ok: false, error: new Error("chat not found") }, // permanent error
      ]);
      const adapters = new Map<string, DeliveryAdapter>([["telegram", adapter]]);
      const eventBus = createMockEventBus();

      const result = await setupDeliveryQueue({
        db: {} as any,
        config: createMockConfig(),
        eventBus,
        logger: createMockLogger(),
        channelAdapters: adapters,
      });

      await result.drainAndStartPrune();

      // 2 acks
      expect(mockSqliteQueue.ackCalls).toHaveLength(2);
      expect(mockSqliteQueue.ackCalls[0]).toEqual({ id: "e1", messageId: "m1" });
      expect(mockSqliteQueue.ackCalls[1]).toEqual({ id: "e2", messageId: "m2" });

      // 1 fail
      expect(mockSqliteQueue.failCalls).toHaveLength(1);
      expect(mockSqliteQueue.failCalls[0]?.id).toBe("e3");

      // Event emitted
      expect(eventBus.emit).toHaveBeenCalledWith("delivery:queue_drained", expect.objectContaining({
        entriesAttempted: 3,
        entriesDelivered: 2,
        entriesFailed: 1,
      }));

      result.shutdown();
    });

    it("stops drain when budget exhausted", async () => {
      // Create many entries so the budget can expire mid-drain
      const entries = [
        makeEntry({ id: "e1", channelType: "telegram" }),
        makeEntry({ id: "e2", channelType: "telegram" }),
        makeEntry({ id: "e3", channelType: "telegram" }),
      ];
      vi.mocked(mockSqliteQueue.pendingEntries).mockResolvedValueOnce(ok(entries));

      // Mock Date.now to jump past the budget after the first entry
      const realDateNow = Date.now;
      let callCount = 0;
      const baseTime = realDateNow();
      vi.spyOn(Date, "now").mockImplementation(() => {
        callCount++;
        // First few calls: return base time. After 3 calls: jump past budget.
        if (callCount >= 4) return baseTime + 100_000;
        return baseTime;
      });

      const adapter = createMockAdapter("telegram");
      const adapters = new Map<string, DeliveryAdapter>([["telegram", adapter]]);
      const eventBus = createMockEventBus();

      const result = await setupDeliveryQueue({
        db: {} as any,
        config: createMockConfig({ drainBudgetMs: 1000 }),
        eventBus,
        logger: createMockLogger(),
        channelAdapters: adapters,
      });

      await result.drainAndStartPrune();

      // Drain should have stopped before processing all 3 entries
      const drainEvent = eventBus.emit.mock.calls.find(
        (c: unknown[]) => c[0] === "delivery:queue_drained",
      );
      expect(drainEvent).toBeDefined();
      const payload = drainEvent![1] as Record<string, number>;
      expect(payload.entriesAttempted).toBeLessThan(3);

      vi.spyOn(Date, "now").mockRestore();
      result.shutdown();
    });

    it("fails entry when no adapter for channel type", async () => {
      const entries = [
        makeEntry({ id: "e1", channelType: "whatsapp" }),
      ];
      vi.mocked(mockSqliteQueue.pendingEntries).mockResolvedValueOnce(ok(entries));

      const adapters = new Map<string, DeliveryAdapter>(); // no adapters
      const eventBus = createMockEventBus();

      const result = await setupDeliveryQueue({
        db: {} as any,
        config: createMockConfig(),
        eventBus,
        logger: createMockLogger(),
        channelAdapters: adapters,
      });

      await result.drainAndStartPrune();

      expect(mockSqliteQueue.failCalls).toHaveLength(1);
      expect(mockSqliteQueue.failCalls[0]?.error).toContain("No adapter for channel type");

      result.shutdown();
    });

    it("nacks transient errors with backoff", async () => {
      const entries = [
        makeEntry({ id: "e1", channelType: "telegram", attemptCount: 1 }),
      ];
      vi.mocked(mockSqliteQueue.pendingEntries).mockResolvedValueOnce(ok(entries));

      const adapter = createMockAdapter("telegram", [
        { ok: false, error: new Error("network timeout") }, // transient
      ]);
      const adapters = new Map<string, DeliveryAdapter>([["telegram", adapter]]);
      const eventBus = createMockEventBus();

      const result = await setupDeliveryQueue({
        db: {} as any,
        config: createMockConfig(),
        eventBus,
        logger: createMockLogger(),
        channelAdapters: adapters,
      });

      await result.drainAndStartPrune();

      expect(mockSqliteQueue.nackCalls).toHaveLength(1);
      expect(mockSqliteQueue.nackCalls[0]?.id).toBe("e1");
      expect(mockSqliteQueue.nackCalls[0]?.nextRetryAt).toBeGreaterThan(Date.now() - 1000);

      result.shutdown();
    });

    it("skips drain when drainOnStartup is false", async () => {
      const eventBus = createMockEventBus();

      const result = await setupDeliveryQueue({
        db: {} as any,
        config: createMockConfig({ drainOnStartup: false }),
        eventBus,
        logger: createMockLogger(),
        channelAdapters: new Map(),
      });

      await result.drainAndStartPrune();

      // pendingEntries should not be called
      expect(mockSqliteQueue.pendingEntries).not.toHaveBeenCalled();
      // No drain event
      expect(eventBus.emit).not.toHaveBeenCalledWith("delivery:queue_drained", expect.anything());

      result.shutdown();
    });
  });

  describe("prune timer", () => {
    it("starts prune timer after drain", async () => {
      vi.useFakeTimers();
      vi.mocked(mockSqliteQueue.pendingEntries).mockResolvedValue(ok([]));
      vi.mocked(mockSqliteQueue.pruneExpired).mockResolvedValue(ok(3));

      const result = await setupDeliveryQueue({
        db: {} as any,
        config: createMockConfig({ pruneIntervalMs: 1000 }),
        eventBus: createMockEventBus(),
        logger: createMockLogger(),
        channelAdapters: new Map(),
      });

      await result.drainAndStartPrune();

      // Advance timer past prune interval
      await vi.advanceTimersByTimeAsync(1100);

      expect(mockSqliteQueue.pruneExpired).toHaveBeenCalled();

      result.shutdown();
      vi.useRealTimers();
    });
  });
});

// ===========================================================================
// Mirror tests
// ===========================================================================

describe("setupDeliveryMirror", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSqliteMirror.recordCalls.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns no-op mirror when disabled", async () => {
    const result = await setupDeliveryMirror({
      db: {} as any,
      config: createMockMirrorConfig({ enabled: false }),
      pluginRegistry: createMockPluginRegistry() as any,
      logger: createMockLogger(),
    });

    expect(result.deliveryMirror).toBe(mockNoOpMirror);
    result.startPrune(); // should be no-op
    result.shutdown(); // should be no-op
  });

  it("creates SQLite mirror when enabled", async () => {
    const result = await setupDeliveryMirror({
      db: {} as any,
      config: createMockMirrorConfig(),
      pluginRegistry: createMockPluginRegistry() as any,
      logger: createMockLogger(),
    });

    expect(result.deliveryMirror).toBe(mockSqliteMirror);
    result.shutdown();
  });

  it("registers comis:delivery-mirror plugin", async () => {
    const registry = createMockPluginRegistry();

    await setupDeliveryMirror({
      db: {} as any,
      config: createMockMirrorConfig(),
      pluginRegistry: registry as any,
      logger: createMockLogger(),
    });

    expect(registry.register).toHaveBeenCalledTimes(1);
    expect(registry.registeredPlugins[0]?.id).toBe("comis:delivery-mirror");
  });

  it("after_delivery hook calls record with idempotency key", async () => {
    const registry = createMockPluginRegistry();

    const result = await setupDeliveryMirror({
      db: {} as any,
      config: createMockMirrorConfig(),
      pluginRegistry: registry as any,
      logger: createMockLogger(),
    });

    // Get the captured after_delivery hook handler
    const hookHandler = registry.capturedHooks.get("after_delivery");
    expect(hookHandler).toBeDefined();

    // Call the handler with a mock event and context
    const event = {
      text: "Hello world",
      channelType: "telegram",
      channelId: "chat-1",
      result: { messageId: "123" },
      durationMs: 50,
      origin: "agent",
    };
    const ctx = { sessionKey: "agent-1:telegram:chat-1" };

    await hookHandler!(event, ctx);

    // Verify record was called
    expect(mockSqliteMirror.record).toHaveBeenCalledTimes(1);
    const recordCall = mockSqliteMirror.recordCalls[0];
    expect(recordCall).toMatchObject({
      sessionKey: "agent-1:telegram:chat-1",
      text: "Hello world",
      mediaUrls: [],
      channelType: "telegram",
      channelId: "chat-1",
      origin: "agent",
    });
    // Verify idempotencyKey is a string with expected format
    expect(recordCall!.idempotencyKey).toMatch(/^agent-1:telegram:chat-1:[a-f0-9]{16}:\d+$/);

    result.shutdown();
  });

  it("after_delivery hook skips when sessionKey is undefined", async () => {
    const registry = createMockPluginRegistry();

    const result = await setupDeliveryMirror({
      db: {} as any,
      config: createMockMirrorConfig(),
      pluginRegistry: registry as any,
      logger: createMockLogger(),
    });

    const hookHandler = registry.capturedHooks.get("after_delivery");
    expect(hookHandler).toBeDefined();

    const event = {
      text: "Hello world",
      channelType: "telegram",
      channelId: "chat-1",
      result: {},
      durationMs: 50,
      origin: "agent",
    };
    // No sessionKey in context
    const ctx = {};

    await hookHandler!(event, ctx);

    // record should NOT be called
    expect(mockSqliteMirror.record).not.toHaveBeenCalled();

    result.shutdown();
  });

  it("startPrune starts interval that calls pruneOld", async () => {
    vi.useFakeTimers();
    vi.mocked(mockSqliteMirror.pruneOld).mockResolvedValue(ok(3));

    const result = await setupDeliveryMirror({
      db: {} as any,
      config: createMockMirrorConfig({ pruneIntervalMs: 1000 }),
      pluginRegistry: createMockPluginRegistry() as any,
      logger: createMockLogger(),
    });

    result.startPrune();

    // Advance timer past prune interval
    await vi.advanceTimersByTimeAsync(1100);

    expect(mockSqliteMirror.pruneOld).toHaveBeenCalledWith(3_600_000);

    result.shutdown();
    vi.useRealTimers();
  });
});
