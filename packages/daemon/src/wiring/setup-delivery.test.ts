// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for delivery subsystem wiring: queue (drain, prune, disabled paths)
 * and mirror (hook registration, prune timer, disabled path).
 * Covers queue drain/prune/disabled paths and mirror hook registration, prune timer, and disabled path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ok, err } from "@comis/shared";
import {
  AMBIGUOUS_SEND_OUTCOME_ERROR,
  EXPLICIT_SEND_REJECTION_ERROR,
  type DeliveryQueuePort,
  type DeliveryQueueEntry,
  type DeliveryAdapter,
  ConversationRefSchema,
} from "@comis/core";
import type { DeliveryMirrorPort, DeliveryMirrorEntry, PluginPort, PluginRegistryApi } from "@comis/core";
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
    agentId: "agent-default",
    conversationRef: ConversationRefSchema.parse(`cv_${"a".repeat(43)}`),
    destinationEndpoint: {
      channelType: "telegram",
      channelInstanceId: "test-instance",
      conversationId: "chat-1",
      conversationKind: "direct",
    },
    optionsJson: "{}",
    origin: "test",
    status: "pending",
    attemptCount: 0,
    maxAttempts: 5,
    createdAt: Date.now(),
    scheduledAt: Date.now(),
    expireAt: Date.now() + 3_600_000,
    lastAttemptAt: null,
    nextRetryAt: null,
    lastError: null,
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
    enqueueInFlight: vi.fn(async () => ok("new-id")),
    claim: vi.fn(async () => ok(true)),
    ack: vi.fn(async (id: string, messageId: string) => { ackCalls.push({ id, messageId }); return ok(undefined); }),
    nack: vi.fn(async (id: string, error: string, nextRetryAt: number) => { nackCalls.push({ id, error, nextRetryAt }); return ok(undefined); }),
    fail: vi.fn(async (id: string, error: string) => { failCalls.push({ id, error }); return ok(undefined); }),
    pendingEntries: vi.fn(async () => ok([] as DeliveryQueueEntry[])),
    unconfirmedEntries: vi.fn(async () => ok([] as DeliveryQueueEntry[])),
    pruneExpired: vi.fn(async () => ok(0)),
    statusCounts: vi.fn(async () => ok({ pending: 0, inFlight: 0, failed: 0, delivered: 0, expired: 0 })),
    recoverInFlight: vi.fn(async () => ok(0)),
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
    clearSession: vi.fn(async () => ok(0)),
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
      drainIntervalMs: 1_000,
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
    await result.drainAndStart(); // should be no-op
    result.shutdown(); // should be no-op
    // Sanity: recoverInFlight not called when queue disabled (no-op queue)
    expect(mockNoOpQueue.recoverInFlight).not.toHaveBeenCalled();
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

      await result.drainAndStart();

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

      await result.drainAndStart();

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

      await result.drainAndStart();

      expect(mockSqliteQueue.failCalls).toHaveLength(1);
      expect(mockSqliteQueue.failCalls[0]?.error).toBe("delivery adapter unavailable");

      result.shutdown();
    });

    it("parks a network error instead of scheduling a duplicate-prone retry", async () => {
      const entries = [
        makeEntry({ id: "e1", channelType: "telegram", attemptCount: 1 }),
      ];
      vi.mocked(mockSqliteQueue.pendingEntries).mockResolvedValueOnce(ok(entries));

      const adapter = createMockAdapter("telegram", [
        { ok: false, error: new Error("network timeout") },
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

      await result.drainAndStart();

      expect(mockSqliteQueue.nackCalls).toHaveLength(0);
      expect(mockSqliteQueue.failCalls).toEqual([
        { id: "e1", error: AMBIGUOUS_SEND_OUTCOME_ERROR },
      ]);

      result.shutdown();
    });

    it("nacks an explicit platform rate-limit rejection with backoff", async () => {
      const entries = [
        makeEntry({ id: "e1", channelType: "telegram", attemptCount: 1 }),
      ];
      vi.mocked(mockSqliteQueue.pendingEntries).mockResolvedValueOnce(ok(entries));

      const adapter = createMockAdapter("telegram", [
        { ok: false, error: new Error("429 too many requests") },
      ]);
      const result = await setupDeliveryQueue({
        db: {} as any,
        config: createMockConfig(),
        eventBus: createMockEventBus(),
        logger: createMockLogger(),
        channelAdapters: new Map([["telegram", adapter]]),
      });

      await result.drainAndStart();

      expect(mockSqliteQueue.nackCalls).toHaveLength(1);
      expect(mockSqliteQueue.nackCalls[0]?.id).toBe("e1");
      expect(mockSqliteQueue.nackCalls[0]?.error).toBe(EXPLICIT_SEND_REJECTION_ERROR);
      expect(mockSqliteQueue.nackCalls[0]?.nextRetryAt).toBeGreaterThan(Date.now() - 1000);

      result.shutdown();
    });

    it("sanitizes a pending-row storage error before logging it", async () => {
      vi.mocked(mockSqliteQueue.pendingEntries).mockResolvedValueOnce(
        err(new Error("Bearer secret-value")),
      );
      const logger = createMockLogger();
      const result = await setupDeliveryQueue({
        db: {} as any,
        config: createMockConfig(),
        eventBus: createMockEventBus(),
        logger,
        channelAdapters: new Map(),
      });

      await result.drainAndStart();

      const serializedWarnings = JSON.stringify(
        (logger.warn as ReturnType<typeof vi.fn>).mock.calls,
      );
      expect(serializedWarnings).not.toContain("secret-value");
      expect(serializedWarnings).toContain("[REDACTED]");
      result.shutdown();
    });

    it("does not call the platform when another drainer already claimed the row", async () => {
      const entry = makeEntry({ id: "claimed-elsewhere", channelType: "telegram" });
      vi.mocked(mockSqliteQueue.pendingEntries).mockResolvedValueOnce(ok([entry]));
      vi.mocked(mockSqliteQueue.claim).mockResolvedValueOnce(ok(false));
      const adapter = createMockAdapter("telegram");
      const result = await setupDeliveryQueue({
        db: {} as any,
        config: createMockConfig(),
        eventBus: createMockEventBus(),
        logger: createMockLogger(),
        channelAdapters: new Map([["telegram", adapter]]),
      });

      await result.drainAndStart();

      expect(adapter.sendMessage).not.toHaveBeenCalled();
      expect(mockSqliteQueue.ackCalls).toHaveLength(0);
      expect(mockSqliteQueue.nackCalls).toHaveLength(0);
      expect(mockSqliteQueue.failCalls).toHaveLength(0);
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

      await result.drainAndStart();

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

      await result.drainAndStart();

      // Advance timer past prune interval
      await vi.advanceTimersByTimeAsync(1100);

      expect(mockSqliteQueue.pruneExpired).toHaveBeenCalled();

      result.shutdown();
      vi.useRealTimers();
    });
  });

  // ========================================================================
  // Recurring drain timer + invariants
  // ========================================================================

  describe("recurring drain timer", () => {
    it("starts recurring drain timer after startup drain", async () => {
      vi.useFakeTimers();
      vi.mocked(mockSqliteQueue.pendingEntries).mockResolvedValue(ok([]));
      vi.mocked(mockSqliteQueue.recoverInFlight).mockResolvedValue(ok(0));

      const result = await setupDeliveryQueue({
        db: {} as any,
        config: createMockConfig({ drainIntervalMs: 50 }),
        eventBus: createMockEventBus(),
        logger: createMockLogger(),
        channelAdapters: new Map(),
      });

      await result.drainAndStart();

      // Startup drain calls pendingEntries once; recurring tick adds at least one more.
      const startupCalls = vi.mocked(mockSqliteQueue.pendingEntries).mock.calls.length;
      await vi.advanceTimersByTimeAsync(120);
      const totalCalls = vi.mocked(mockSqliteQueue.pendingEntries).mock.calls.length;

      expect(totalCalls).toBeGreaterThan(startupCalls);

      result.shutdown();
      vi.useRealTimers();
    });

    it("recoverInFlight runs BEFORE startup drain", async () => {
      vi.mocked(mockSqliteQueue.pendingEntries).mockResolvedValue(ok([]));
      vi.mocked(mockSqliteQueue.recoverInFlight).mockResolvedValue(ok(2));

      const result = await setupDeliveryQueue({
        db: {} as any,
        config: createMockConfig(),
        eventBus: createMockEventBus(),
        logger: createMockLogger(),
        channelAdapters: new Map(),
      });

      await result.drainAndStart();

      const recoverOrder = vi.mocked(mockSqliteQueue.recoverInFlight).mock.invocationCallOrder[0];
      const pendingOrder = vi.mocked(mockSqliteQueue.pendingEntries).mock.invocationCallOrder[0];
      expect(recoverOrder).toBeDefined();
      expect(pendingOrder).toBeDefined();
      expect(recoverOrder!).toBeLessThan(pendingOrder!);

      result.shutdown();
    });

    it("recoverInFlight still runs when drainOnStartup is false", async () => {
      vi.mocked(mockSqliteQueue.recoverInFlight).mockResolvedValue(ok(0));

      const result = await setupDeliveryQueue({
        db: {} as any,
        config: createMockConfig({ drainOnStartup: false }),
        eventBus: createMockEventBus(),
        logger: createMockLogger(),
        channelAdapters: new Map(),
      });

      await result.drainAndStart();
      expect(mockSqliteQueue.recoverInFlight).toHaveBeenCalled();
      result.shutdown();
    });

    it("deferred row not delivered before scheduled_at", async () => {
      vi.useFakeTimers();
      vi.mocked(mockSqliteQueue.recoverInFlight).mockResolvedValue(ok(0));
      // Simulate: pendingEntries returns [] for the first 4 ticks (row's scheduled_at > now),
      // then returns the entry on tick 5 (scheduled_at <= now), then [] for all subsequent
      // ticks (ack on the real SQLite path would have flipped status to 'delivered').
      const entry = makeEntry({ id: "deferred-1", channelType: "telegram" });
      vi.mocked(mockSqliteQueue.pendingEntries)
        .mockResolvedValueOnce(ok([]))      // startup
        .mockResolvedValueOnce(ok([]))      // tick 1 (1000ms)
        .mockResolvedValueOnce(ok([]))      // tick 2 (2000ms)
        .mockResolvedValueOnce(ok([]))      // tick 3 (3000ms)
        .mockResolvedValueOnce(ok([]))      // tick 4 (4000ms)
        .mockResolvedValueOnce(ok([entry])) // tick 5 (5000ms) -- finally due
        .mockResolvedValue(ok([]));         // tick 6+ -- already delivered

      const adapter = createMockAdapter("telegram", [{ ok: true, value: "m1" }]);
      const adapters = new Map<string, DeliveryAdapter>([["telegram", adapter]]);

      const result = await setupDeliveryQueue({
        db: {} as any,
        config: createMockConfig({ drainIntervalMs: 1000 }),
        eventBus: createMockEventBus(),
        logger: createMockLogger(),
        channelAdapters: adapters,
      });

      await result.drainAndStart();

      // 4 ticks elapsed (4000ms), still pre-due.
      await vi.advanceTimersByTimeAsync(4500);
      expect(adapter.sendMessage).not.toHaveBeenCalled();

      // 5th tick -- row is now due; advance one more interval.
      await vi.advanceTimersByTimeAsync(1000);
      // Flush microtasks so the in-flight tick's pendingEntries -> sendMessage resolves.
      await Promise.resolve();
      await Promise.resolve();
      expect(adapter.sendMessage).toHaveBeenCalledTimes(1);

      result.shutdown();
      vi.useRealTimers();
    });

    it("shutdown clears both drain and prune timers", async () => {
      vi.useFakeTimers();
      vi.mocked(mockSqliteQueue.recoverInFlight).mockResolvedValue(ok(0));
      vi.mocked(mockSqliteQueue.pendingEntries).mockResolvedValue(ok([]));
      vi.mocked(mockSqliteQueue.pruneExpired).mockResolvedValue(ok(0));

      const result = await setupDeliveryQueue({
        db: {} as any,
        config: createMockConfig({ drainIntervalMs: 50, pruneIntervalMs: 50 }),
        eventBus: createMockEventBus(),
        logger: createMockLogger(),
        channelAdapters: new Map(),
      });

      await result.drainAndStart();
      // Capture call counts post-startup
      const pendingBefore = vi.mocked(mockSqliteQueue.pendingEntries).mock.calls.length;
      const pruneBefore = vi.mocked(mockSqliteQueue.pruneExpired).mock.calls.length;

      result.shutdown();

      await vi.advanceTimersByTimeAsync(500); // 10x both intervals

      expect(vi.mocked(mockSqliteQueue.pendingEntries).mock.calls.length).toBe(pendingBefore);
      expect(vi.mocked(mockSqliteQueue.pruneExpired).mock.calls.length).toBe(pruneBefore);

      vi.useRealTimers();
    });

    it("single-tick gate prevents concurrent drains", async () => {
      vi.useFakeTimers();
      vi.mocked(mockSqliteQueue.recoverInFlight).mockResolvedValue(ok(0));
      const entry = makeEntry({ id: "slow-1", channelType: "telegram" });
      vi.mocked(mockSqliteQueue.pendingEntries).mockResolvedValue(ok([entry]));

      // Adapter sendMessage stalls indefinitely so the in-flight gate stays
      // held. With drainOnStartup=false, startup drain is skipped and only
      // the recurring timer can fire sendMessage -- that's the path we want
      // to exercise (the recurring tick's `if (draining) return` gate).
      const sendPromise = new Promise<{ ok: true; value: string }>(() => { /* never resolves */ });
      let sendCallCount = 0;
      const adapter: DeliveryAdapter = {
        channelType: "telegram",
        sendMessage: vi.fn(async () => {
          sendCallCount++;
          const r = await sendPromise;
          return ok(r.value);
        }),
      };
      const adapters = new Map<string, DeliveryAdapter>([["telegram", adapter]]);

      const result = await setupDeliveryQueue({
        db: {} as any,
        config: createMockConfig({ drainIntervalMs: 50, drainOnStartup: false }),
        eventBus: createMockEventBus(),
        logger: createMockLogger(),
        channelAdapters: adapters,
      });

      await result.drainAndStart();
      // No tick has fired yet (drainOnStartup=false skips the eager pass).
      expect(sendCallCount).toBe(0);

      // Advance >= 4 intervals. The first tick's sendMessage stalls on
      // sendPromise, holding `draining` non-null. Subsequent ticks see
      // `if (draining) return` and skip without invoking pendingEntries
      // or sendMessage again.
      await vi.advanceTimersByTimeAsync(250);
      // Flush microtasks the timer may have queued.
      await Promise.resolve();
      await Promise.resolve();

      // Exactly ONE sendMessage call across 5 elapsed intervals -- the gate held.
      expect(sendCallCount).toBe(1);

      result.shutdown();
      vi.useRealTimers();
    });

    it("empty-queue ticks do not emit delivery:queue_drained (silent ticks)", async () => {
      vi.useFakeTimers();
      vi.mocked(mockSqliteQueue.recoverInFlight).mockResolvedValue(ok(0));
      vi.mocked(mockSqliteQueue.pendingEntries).mockResolvedValue(ok([]));
      const eventBus = createMockEventBus();

      const result = await setupDeliveryQueue({
        db: {} as any,
        config: createMockConfig({ drainIntervalMs: 50, drainOnStartup: true }),
        eventBus,
        logger: createMockLogger(),
        channelAdapters: new Map(),
      });

      await result.drainAndStart();
      await vi.advanceTimersByTimeAsync(300); // 6 recurring ticks

      const drainEvents = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => c[0] === "delivery:queue_drained",
      );
      // Existing drainDeliveryQueue early-returns when entries.length === 0 BEFORE
      // the emit. So zero drain events should fire over 1 startup + 6 ticks.
      expect(drainEvents.length).toBe(0);

      result.shutdown();
      vi.useRealTimers();
    });

    // Fix B (log-review): transition-gated empty-drain log
    it("Fix B: consecutive empty-drain ticks emit exactly ONE 'transitioned to empty' log line", async () => {
      vi.useFakeTimers();
      vi.mocked(mockSqliteQueue.recoverInFlight).mockResolvedValue(ok(0));
      vi.mocked(mockSqliteQueue.pendingEntries).mockResolvedValue(ok([]));
      const logger = createMockLogger();

      const result = await setupDeliveryQueue({
        db: {} as any,
        config: createMockConfig({ drainIntervalMs: 50, drainOnStartup: true }),
        eventBus: createMockEventBus(),
        logger,
        channelAdapters: new Map(),
      });

      await result.drainAndStart();
      // Advance >= 6 ticks; lastDrainHadPending starts `true`, so the first
      // empty pass logs once, and all subsequent empty passes are silent.
      await vi.advanceTimersByTimeAsync(300);
      await vi.runOnlyPendingTimersAsync();

      const transitionLogs = (logger.debug as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("transitioned to empty"),
      );
      expect(transitionLogs.length).toBe(1);

      result.shutdown();
      vi.useRealTimers();
    });

    it("Fix B: non-empty drain followed by empty drain re-emits the transition log", async () => {
      vi.useFakeTimers();
      vi.mocked(mockSqliteQueue.recoverInFlight).mockResolvedValue(ok(0));
      const entry = makeEntry({ id: "transition-1", channelType: "telegram" });
      // Sequence: empty (startup) → non-empty (first tick) → empty (second tick onwards).
      // The startup empty pass logs ONCE (lastDrainHadPending starts true).
      // The first non-empty tick flips the gate; the second empty tick logs again.
      vi.mocked(mockSqliteQueue.pendingEntries)
        .mockResolvedValueOnce(ok([]))         // startup drain — empty
        .mockResolvedValueOnce(ok([entry]))    // recurring tick 1 — pending
        .mockResolvedValue(ok([]));            // ticks 2+ — empty

      const adapter = createMockAdapter("telegram", [{ ok: true, value: "msg-1" }]);
      const adapters = new Map<string, DeliveryAdapter>([["telegram", adapter]]);
      const logger = createMockLogger();

      const result = await setupDeliveryQueue({
        db: {} as any,
        config: createMockConfig({ drainIntervalMs: 50, drainOnStartup: true }),
        eventBus: createMockEventBus(),
        logger,
        channelAdapters: adapters,
      });

      await result.drainAndStart();
      await vi.advanceTimersByTimeAsync(300);
      await vi.runOnlyPendingTimersAsync();

      const transitionLogs = (logger.debug as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("transitioned to empty"),
      );
      // Two transitions: startup-empty (1st), and after-non-empty-then-empty (2nd).
      expect(transitionLogs.length).toBe(2);

      result.shutdown();
      vi.useRealTimers();
    });

    it("does not start recurring timer when queue is disabled", async () => {
      vi.useFakeTimers();
      const result = await setupDeliveryQueue({
        db: {} as any,
        config: createMockConfig({ enabled: false }),
        eventBus: createMockEventBus(),
        logger: createMockLogger(),
        channelAdapters: new Map(),
      });

      await result.drainAndStart();
      await vi.advanceTimersByTimeAsync(5000);

      expect(mockSqliteQueue.pendingEntries).not.toHaveBeenCalled();
      expect(mockSqliteQueue.recoverInFlight).not.toHaveBeenCalled();

      result.shutdown();
      vi.useRealTimers();
    });

    it("recurring tick delivers a post-startup entry within drainIntervalMs + 500ms", async () => {
      vi.useFakeTimers();
      vi.mocked(mockSqliteQueue.recoverInFlight).mockResolvedValue(ok(0));
      const entry = makeEntry({ id: "post-startup-1", channelType: "telegram" });
      vi.mocked(mockSqliteQueue.pendingEntries)
        .mockResolvedValueOnce(ok([]))             // startup drain -- empty
        .mockResolvedValueOnce(ok([entry]))        // first recurring tick -- has post-startup row
        .mockResolvedValue(ok([]));                // subsequent ticks empty

      const adapter = createMockAdapter("telegram", [{ ok: true, value: "msg-1" }]);
      const adapters = new Map<string, DeliveryAdapter>([["telegram", adapter]]);
      const eventBus = createMockEventBus();

      const result = await setupDeliveryQueue({
        db: {} as any,
        config: createMockConfig({ drainIntervalMs: 250 }),
        eventBus,
        logger: createMockLogger(),
        channelAdapters: adapters,
      });

      await result.drainAndStart();
      await vi.advanceTimersByTimeAsync(750); // drainIntervalMs + 500ms = 750ms
      await vi.runOnlyPendingTimersAsync();

      expect(mockSqliteQueue.ackCalls).toHaveLength(1);
      expect(mockSqliteQueue.ackCalls[0]).toEqual({ id: "post-startup-1", messageId: "msg-1" });

      result.shutdown();
      vi.useRealTimers();
    });

    it("budget exhaustion still yields after the recurring-timer addition", async () => {
      // Mirror the existing budget-exhaustion test shape but on a single tick of
      // the recurring drainer to confirm the budget yield still works post-refactor.
      const entries = [
        makeEntry({ id: "be1", channelType: "telegram" }),
        makeEntry({ id: "be2", channelType: "telegram" }),
        makeEntry({ id: "be3", channelType: "telegram" }),
      ];
      vi.mocked(mockSqliteQueue.recoverInFlight).mockResolvedValue(ok(0));
      vi.mocked(mockSqliteQueue.pendingEntries).mockResolvedValueOnce(ok(entries));

      // Mock Date.now to jump past the budget after the first entry.
      const realDateNow = Date.now;
      let callCount = 0;
      const baseTime = realDateNow();
      vi.spyOn(Date, "now").mockImplementation(() => {
        callCount++;
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

      await result.drainAndStart();

      // Drain (startup) should have stopped before processing all 3 entries.
      const drainEvent = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: unknown[]) => c[0] === "delivery:queue_drained",
      );
      expect(drainEvent).toBeDefined();
      const payload = drainEvent![1] as Record<string, number>;
      expect(payload.entriesAttempted).toBeLessThan(3);

      vi.spyOn(Date, "now").mockRestore();
      result.shutdown();
    });
  });

  // ========================================================================
  // Row-selection invariant -- uses REAL SQLite adapter, NOT the mock.
  //
  // The goal is to catch the row-selection race, which is fully observable
  // in-process. This test seeds 100 'in_flight' rows + 100 'pending' rows
  // simultaneously and proves the recurring drainer's WHERE filter NEVER
  // picks 'in_flight'. The integration test exercises the recurring-drainer
  // notification-path throughput; this test exercises the row-selection
  // race-safety invariant. Together they cover the 100-concurrent intent:
  // throughput at integration tier, race-safety at unit tier -- cleaner than
  // retrofitting an integration RPC that doesn't exist.
  // ========================================================================

  describe("row-selection invariant (real SQLite adapter)", () => {
    it("drainer never picks 'in_flight' rows even when 100 in_flight + 100 pending coexist", async () => {
      // Bypass the file-level vi.mock("@comis/memory") so we exercise the REAL
      // adapter's WHERE status='pending' filter. This is the invariant under test.
      const memoryActual = await vi.importActual<typeof import("@comis/memory")>("@comis/memory");
      const Database = (await import("better-sqlite3")).default;
      // Drive the drain via the now-exported drainDeliveryQueue helper, so we
      // can call exactly N drain passes deterministically against the real queue.
      const { drainDeliveryQueue } = await import("./setup-delivery.js");

      const db = new Database(":memory:");
      memoryActual.initSchema(db, 768);

      const eventBus = createMockEventBus();
      const queue = memoryActual.createSqliteDeliveryQueue(db, eventBus);

      const now = Date.now();
      const seedRow = (id: string, status: "pending" | "in_flight"): void => {
        db.prepare(
          `INSERT INTO delivery_queue (id, text, channel_type, channel_id, tenant_id, agent_id,
                                         conversation_ref, destination_endpoint, options_json, origin,
                                         status, attempt_count, max_attempts,
                                         created_at, scheduled_at, expire_at)
           VALUES (?, ?, 'telegram', 'ch-1', 'def', 'agent-a', ?, ?, '{}', 'channel', ?, 0, 5, ?, ?, ?)`,
        ).run(
          id,
          `msg-${id}`,
          `cv_${"a".repeat(43)}`,
          JSON.stringify({ channelType: "telegram", channelInstanceId: "test-instance", conversationId: "ch-1", conversationKind: "direct" }),
          status,
          now,
          now,
          now + 60_000,
        );
      };

      // 100 in_flight rows that the drainer MUST NOT pick.
      const inFlightIds = new Set<string>();
      for (let i = 0; i < 100; i++) {
        const id = `inflight-${i}`;
        seedRow(id, "in_flight");
        inFlightIds.add(id);
      }
      // 100 pending rows that the drainer MUST deliver exactly once each.
      const pendingIds = new Set<string>();
      for (let i = 0; i < 100; i++) {
        const id = `pending-${i}`;
        seedRow(id, "pending");
        pendingIds.add(id);
      }

      // Sanity: queue depth = 200 (pending + in_flight)
      // Direct SQL read; queue.depth() was removed during port-surface trimming.
      const depthRow = db
        .prepare("SELECT COUNT(*) as count FROM delivery_queue WHERE status IN ('pending', 'in_flight')")
        .get() as { count: number };
      expect(depthRow.count).toBe(200);

      // Spy adapter that records every entryId it was asked to send.
      const sentIds: string[] = [];
      const adapter: DeliveryAdapter = {
        channelType: "telegram",
        sendMessage: vi.fn(async (_channelId: string, text: string) => {
          // Recover the seeded id from the text body.
          const id = text.replace(/^msg-/, "");
          sentIds.push(id);
          return ok(`platform-msg-for-${id}`);
        }),
      };
      const adapters = new Map<string, DeliveryAdapter>([["telegram", adapter]]);

      // Run drain passes until pending is exhausted. Each pass drains up to
      // drainBudgetMs worth of rows; with 100 fast spy sends, one or two passes
      // should suffice. Cap at 10 to prevent an infinite loop on regression.
      for (let pass = 0; pass < 10; pass++) {
        await drainDeliveryQueue({
          deliveryQueue: queue,
          channelAdapters: adapters,
          eventBus,
          logger: createMockLogger(),
          drainBudgetMs: 60_000,
          defaultMaxAttempts: 5,
        });
        const pendingResult = await queue.pendingEntries();
        if (pendingResult.ok && pendingResult.value.length === 0) break;
      }

      // INVARIANT 1: every adapter send was for a 'pending' seed, never for 'in_flight'.
      for (const id of sentIds) {
        expect(inFlightIds.has(id)).toBe(false); // hard assertion
        expect(pendingIds.has(id)).toBe(true);
      }

      // INVARIANT 2: exactly 100 distinct sends, one per pending seed.
      const uniqueSentIds = new Set(sentIds);
      expect(uniqueSentIds.size).toBe(100);
      for (const id of pendingIds) {
        expect(uniqueSentIds.has(id)).toBe(true);
      }

      // INVARIANT 3: the 100 in_flight rows still have status='in_flight' (they only
      // transition via channel-side ack/nack/fail or via recoverInFlight; neither fires here).
      const inFlightRows = db
        .prepare(`SELECT id, status FROM delivery_queue WHERE status = 'in_flight'`)
        .all() as Array<{ id: string; status: string }>;
      expect(inFlightRows.length).toBe(100);
      for (const row of inFlightRows) {
        expect(inFlightIds.has(row.id)).toBe(true);
      }

      db.close();
    });
  });

  describe("recordOutboundMessage capture (agent-authored outbound → trajectory map)", () => {
    it("calls recordOutboundMessage with the platform messageId + trajectory scope on a successful ack (non-null traceId)", async () => {
      const { drainDeliveryQueue } = await import("./setup-delivery.js");
      const entry = makeEntry({
        id: "e1",
        channelType: "telegram",
        text: "agent reply",
        tenantId: "tenant-x",
        agentId: "agent-1",
        traceId: "trace-abc",
      });
      const queue = createMockQueue();
      vi.mocked(queue.pendingEntries).mockResolvedValueOnce(ok([entry]));
      const adapter = createMockAdapter("telegram", [{ ok: true, value: "platform-msg-99" }]);
      const adapters = new Map<string, DeliveryAdapter>([["telegram", adapter]]);

      const recordOutboundMessage = vi.fn();
      await drainDeliveryQueue({
        deliveryQueue: queue,
        channelAdapters: adapters,
        eventBus: createMockEventBus(),
        logger: createMockLogger(),
        drainBudgetMs: 60_000,
        defaultMaxAttempts: 5,
        recordOutboundMessage,
      });

      expect(recordOutboundMessage).toHaveBeenCalledTimes(1);
      expect(recordOutboundMessage).toHaveBeenCalledWith("platform-msg-99", {
        traceId: "trace-abc",
        tenantId: "tenant-x",
        agentId: "agent-1",
        sessionId: "trace-abc",
        participantId: undefined,
      });
    });

    it("does NOT call recordOutboundMessage for an entry with a null traceId (no trajectory → not mapped)", async () => {
      const { drainDeliveryQueue } = await import("./setup-delivery.js");
      const entry = makeEntry({ id: "e1", channelType: "telegram", traceId: null });
      const queue = createMockQueue();
      vi.mocked(queue.pendingEntries).mockResolvedValueOnce(ok([entry]));
      const adapter = createMockAdapter("telegram", [{ ok: true, value: "platform-msg-1" }]);
      const adapters = new Map<string, DeliveryAdapter>([["telegram", adapter]]);

      const recordOutboundMessage = vi.fn();
      await drainDeliveryQueue({
        deliveryQueue: queue,
        channelAdapters: adapters,
        eventBus: createMockEventBus(),
        logger: createMockLogger(),
        drainBudgetMs: 60_000,
        defaultMaxAttempts: 5,
        recordOutboundMessage,
      });

      expect(recordOutboundMessage).not.toHaveBeenCalled();
    });

    it("does NOT call recordOutboundMessage on a send FAILURE (no platform messageId to map)", async () => {
      const { drainDeliveryQueue } = await import("./setup-delivery.js");
      const entry = makeEntry({ id: "e1", channelType: "telegram", traceId: "trace-abc" });
      const queue = createMockQueue();
      vi.mocked(queue.pendingEntries).mockResolvedValueOnce(ok([entry]));
      const adapter = createMockAdapter("telegram", [{ ok: false, error: new Error("chat not found") }]);
      const adapters = new Map<string, DeliveryAdapter>([["telegram", adapter]]);

      const recordOutboundMessage = vi.fn();
      await drainDeliveryQueue({
        deliveryQueue: queue,
        channelAdapters: adapters,
        eventBus: createMockEventBus(),
        logger: createMockLogger(),
        drainBudgetMs: 60_000,
        defaultMaxAttempts: 5,
        recordOutboundMessage,
      });

      expect(recordOutboundMessage).not.toHaveBeenCalled();
    });

    it("records a non-default agent from the structured queue authority", async () => {
      const { drainDeliveryQueue } = await import("./setup-delivery.js");
      // A multi-agent daemon's agent differs from the tenant; the structured
      // queue column is the authority source for drain attribution.
      const entry = makeEntry({
        id: "e1",
        channelType: "telegram",
        text: "agent reply",
        tenantId: "default",
        agentId: "mldag",
        traceId: "trace-abc",
      });
      const queue = createMockQueue();
      vi.mocked(queue.pendingEntries).mockResolvedValueOnce(ok([entry]));
      const adapter = createMockAdapter("telegram", [{ ok: true, value: "platform-msg-7" }]);
      const adapters = new Map<string, DeliveryAdapter>([["telegram", adapter]]);

      const recordOutboundMessage = vi.fn();
      await drainDeliveryQueue({
        deliveryQueue: queue,
        channelAdapters: adapters,
        eventBus: createMockEventBus(),
        logger: createMockLogger(),
        drainBudgetMs: 60_000,
        defaultMaxAttempts: 5,
        recordOutboundMessage,
      });

      expect(recordOutboundMessage).toHaveBeenCalledTimes(1);
      expect(recordOutboundMessage).toHaveBeenCalledWith("platform-msg-7", {
        traceId: "trace-abc",
        tenantId: "default",
        agentId: "mldag",
        sessionId: "trace-abc",
        participantId: undefined,
      });
    });

    it("ignores optionsJson agent metadata and uses the required queue authority", async () => {
      const { drainDeliveryQueue } = await import("./setup-delivery.js");
      const entry = makeEntry({
        id: "e1",
        channelType: "telegram",
        text: "no-agent send",
        tenantId: "default",
        agentId: "agent-structured",
        traceId: "trace-xyz",
        optionsJson: JSON.stringify({ replyTo: "m-1" }),
      });
      const queue = createMockQueue();
      vi.mocked(queue.pendingEntries).mockResolvedValueOnce(ok([entry]));
      const adapter = createMockAdapter("telegram", [{ ok: true, value: "platform-msg-8" }]);
      const adapters = new Map<string, DeliveryAdapter>([["telegram", adapter]]);

      const recordOutboundMessage = vi.fn();
      await drainDeliveryQueue({
        deliveryQueue: queue,
        channelAdapters: adapters,
        eventBus: createMockEventBus(),
        logger: createMockLogger(),
        drainBudgetMs: 60_000,
        defaultMaxAttempts: 5,
        recordOutboundMessage,
      });

      expect(recordOutboundMessage).toHaveBeenCalledWith("platform-msg-8", {
        traceId: "trace-xyz",
        tenantId: "default",
        agentId: "agent-structured",
        sessionId: "trace-xyz",
        participantId: undefined,
      });
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
    const conversationRef = ConversationRefSchema.parse(`cv_${"b".repeat(43)}`);
    const destinationEndpoint = {
      channelType: "telegram",
      channelInstanceId: "test-instance",
      conversationId: "chat-1",
      conversationKind: "direct" as const,
    };
    const ctx = {
      deliveryAuthority: { tenantId: "tenant-a", agentId: "agent-1", conversationRef },
      destinationEndpoint,
    };

    await hookHandler!(event, ctx);

    // Verify record was called
    expect(mockSqliteMirror.record).toHaveBeenCalledTimes(1);
    const recordCall = mockSqliteMirror.recordCalls[0];
    expect(recordCall).toMatchObject({
      tenantId: "tenant-a",
      agentId: "agent-1",
      conversationRef,
      destinationEndpoint,
      text: "Hello world",
      mediaUrls: [],
      channelType: "telegram",
      channelId: "chat-1",
      origin: "agent",
    });
    // Verify idempotencyKey is a string with expected format
    expect(recordCall!.idempotencyKey).toMatch(/^cv_[A-Za-z0-9_-]{43}:[a-f0-9]{16}:\d+$/);

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

// ---------------------------------------------------------------------------
// Drain log includes per-class metric (operator-facing).
//
// An operator-facing debug log line emitted by the housekeeper drain pass
// includes `pruned`, `class`, and `durationMs` fields. The assertion is a
// source-grep over setup-delivery.ts for the new log shape (canonical Pino
// object-first).
// ---------------------------------------------------------------------------
describe("drain log includes per-class metric (operator-facing)", () => {
  it("source-grep: setup-delivery.ts emits a drain log with pruned + class + durationMs", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.resolve(here, "setup-delivery.ts"), "utf-8");
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    // Look for a log line that emits an object containing all three fields.
    // Acceptable shapes: `{ pruned, class, durationMs }` or `{ pruned: ..., class: ..., durationMs: ... }`.
    const hasPerClassLog =
      /pruned[^}]*class[^}]*durationMs/s.test(stripped) ||
      /class[^}]*pruned[^}]*durationMs/s.test(stripped) ||
      /durationMs[^}]*pruned[^}]*class/s.test(stripped);
    expect(hasPerClassLog).toBe(true);
  });
});
