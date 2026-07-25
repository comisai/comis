// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { TypedEventBus } from "@comis/core";
import {
  createObservabilityStore,
  initSchema,
  type ObsTableName,
} from "@comis/memory";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindObsExportHandlers } from "../api/obs-handlers/obs-export.js";
import type { ObsHandlerDeps } from "../api/obs-handlers/obs-helpers.js";
import {
  createObsWriteBuffer,
  setupObsPersistence,
  type ObsPersistenceResult,
  type ObsWriteBuffer,
} from "./obs-persistence-wiring.js";

type ResettableTable = ObsTableName | "all";

type DiscardableBuffer<T> = ObsWriteBuffer<T> & {
  discard(): number;
};

type ResettablePersistence = ObsPersistenceResult & {
  discardPending(table: ResettableTable): number;
};

type FlushablePersistence = ObsPersistenceResult & {
  flushPending(table: ResettableTable): void;
};

function emitMessageProcessed(eventBus: TypedEventBus): void {
  eventBus.emit("diagnostic:message_processed", {
    messageId: "message-1",
    channelId: "channel-1",
    channelType: "telegram",
    agentId: "agent-1",
    tenantId: "tenant",
    conversationRef: `cv_${"o".repeat(43)}` as never,
    destinationEndpoint: {
      channelType: "telegram",
      channelInstanceId: "telegram-test",
      conversationId: "channel-1",
      conversationKind: "direct",
    },
    sessionKey: "tenant:user:agent-1",
    traceId: "trace-1",
    toolCalls: 1,
    llmCalls: 2,
    receivedAt: 900,
    executionDurationMs: 80,
    deliveryDurationMs: 20,
    totalDurationMs: 100,
    tokensUsed: 25,
    cost: 0.01,
    status: "success",
    finishReason: "end_turn",
    timestamp: 1_000,
  });
}

function emitAuditEvent(eventBus: TypedEventBus): void {
  eventBus.emit("audit:event", {
    timestamp: 1_001,
    agentId: "agent-1",
    tenantId: "tenant",
    actionType: "config.read",
    kind: "audit",
    classification: "read",
    outcome: "success",
  });
}

function setupRealPersistence(): {
  db: Database.Database;
  eventBus: TypedEventBus;
  persistence: ObsPersistenceResult;
  store: ReturnType<typeof createObservabilityStore>;
} {
  const db = new Database(":memory:");
  initSchema(db, 1_536);
  const store = createObservabilityStore(db);
  const eventBus = new TypedEventBus();
  const persistence = setupObsPersistence({
    eventBus,
    obsStore: store,
    db: { transaction: <T,>(fn: () => T) => db.transaction(fn) },
    channelActivityTracker: {
      getAll: () => [],
    } as never,
    startupTimestamp: 0,
    snapshotIntervalMs: 300_000,
  });
  return { db, eventBus, persistence, store };
}

function makeResetHandlerDeps(overrides: Record<string, unknown>): ObsHandlerDeps {
  return {
    diagnosticCollector: { reset: vi.fn() },
    billingEstimator: {},
    channelActivityTracker: { reset: vi.fn() },
    deliveryTracer: { reset: vi.fn() },
    agents: {},
    ...overrides,
  } as unknown as ObsHandlerDeps;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("observability pending-write reset control", () => {
  it("discards buffered rows without flushing them", () => {
    vi.useFakeTimers();
    const flushFn = vi.fn();
    const buffer = createObsWriteBuffer({ flushFn }) as DiscardableBuffer<number>;

    try {
      buffer.push(1);
      buffer.push(2);

      expect(buffer.discard()).toBe(2);
      expect(buffer.pending).toBe(0);
      buffer.flush();
      expect(flushFn).not.toHaveBeenCalled();
    } finally {
      buffer.drain();
    }
  });

  it("keeps buffered rows queued when a flush fails", () => {
    vi.useFakeTimers();
    let nowMs = 0;
    const flushFn = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error("transient write failure");
      })
      .mockImplementation(() => undefined);
    const buffer = createObsWriteBuffer({ flushFn, maxSize: 10, nowMs: () => nowMs });

    try {
      buffer.push(1);

      expect(buffer.flush()).toEqual({
        ok: false,
        error: expect.objectContaining({ kind: "persistence_unavailable", pending: 1 }),
      });
      expect(buffer.pending).toBe(1);

      nowMs = 500;
      buffer.flush();
      expect(buffer.pending).toBe(0);
      expect(flushFn.mock.calls).toEqual([[[1]], [[1]]]);
    } finally {
      buffer.drain();
    }
  });

  it("contains periodic flush failures and retries the queued batch", () => {
    vi.useFakeTimers();
    const onFlushError = vi.fn();
    const flushFn = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error("database unavailable");
      })
      .mockImplementation(() => undefined);
    const buffer = createObsWriteBuffer({
      flushFn,
      intervalMs: 500,
      onFlushError,
    });

    try {
      buffer.push(1);

      expect(() => vi.advanceTimersByTime(500)).not.toThrow();
      expect(buffer.pending).toBe(1);
      expect(onFlushError).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "persistence_unavailable",
          pending: 1,
          dropped: 0,
        }),
      );
      expect(JSON.stringify(onFlushError.mock.calls)).not.toContain("database unavailable");

      vi.advanceTimersByTime(500);
      expect(buffer.pending).toBe(0);
      expect(flushFn.mock.calls).toEqual([[[1]], [[1]]]);
    } finally {
      buffer.drain();
    }
  });

  it("contains throwing failure and recovery observers around the durable queue", () => {
    vi.useFakeTimers();
    let nowMs = 0;
    let sinkAvailable = false;
    const buffer = createObsWriteBuffer({
      maxSize: 1,
      nowMs: () => nowMs,
      flushFn: () => {
        if (!sinkAvailable) throw new Error("sink unavailable");
      },
      onFlushError: () => {
        throw new Error("broken warning sink");
      },
      onRecovery: () => {
        throw new Error("broken recovery sink");
      },
    });

    try {
      expect(() => buffer.push(1)).not.toThrow();
      expect(buffer.pending).toBe(1);

      sinkAvailable = true;
      nowMs = 500;
      expect(() => buffer.flush()).not.toThrow();
      expect(buffer.pending).toBe(0);
    } finally {
      buffer.drain();
    }
  });

  it("bounds a failed queue and deterministically retains the newest rows", () => {
    vi.useFakeTimers();
    const durableRows: number[] = [];
    let sinkAvailable = false;
    let nowMs = 0;
    const buffer = createObsWriteBuffer({
      maxSize: 2,
      maxPending: 3,
      nowMs: () => nowMs,
      flushFn: (items: number[]) => {
        if (!sinkAvailable) throw new Error("row-content-must-not-reach-health-logs");
        durableRows.push(...items);
      },
    });

    try {
      expect(() => {
        for (const item of [1, 2, 3, 4, 5]) buffer.push(item);
      }).not.toThrow();
      expect(buffer.pending).toBe(3);
      expect(buffer.dropped).toBe(2);

      sinkAvailable = true;
      nowMs = 500;
      const recovered = buffer.flush() as unknown;
      expect(recovered).toEqual({
        ok: true,
        value: { flushed: 3, pending: 0, dropped: 2 },
      });
      expect(durableRows).toEqual([3, 4, 5]);

      buffer.flush();
      expect(durableRows).toEqual([3, 4, 5]);
    } finally {
      buffer.drain();
    }
  });

  it("throttles content-free failure reports while retrying with backoff", () => {
    vi.useFakeTimers();
    let nowMs = 0;
    const onFlushError = vi.fn();
    const flushFn = vi.fn(() => {
      throw new Error("sensitive-row-value");
    });
    const buffer = createObsWriteBuffer({
      flushFn,
      maxSize: 1,
      maxPending: 2,
      intervalMs: 100,
      reportIntervalMs: 1_000,
      nowMs: () => nowMs,
      onFlushError,
    });

    try {
      buffer.push(1);
      buffer.push(2);
      buffer.push(3);
      expect(onFlushError).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(onFlushError.mock.calls)).not.toContain("sensitive-row-value");

      for (let elapsed = 100; elapsed < 1_000; elapsed += 100) {
        nowMs = elapsed;
        vi.advanceTimersByTime(100);
      }
      expect(onFlushError).toHaveBeenCalledTimes(1);
      expect(flushFn.mock.calls.length).toBeLessThan(10);

      nowMs = 1_000;
      vi.advanceTimersByTime(100);
      expect(onFlushError).toHaveBeenCalledTimes(2);
      expect(onFlushError).toHaveBeenLastCalledWith(expect.objectContaining({
        kind: "persistence_unavailable",
        pending: 2,
        dropped: 1,
      }));
    } finally {
      buffer.discard();
      buffer.drain();
    }
  });

  it("returns a content-free flush failure and recovers retained rows exactly once", () => {
    vi.useFakeTimers();
    const eventBus = new TypedEventBus();
    let sinkAvailable = false;
    const inserted: number[] = [];
    const warning = vi.fn();
    const persistence = setupObsPersistence({
      eventBus,
      obsStore: {
        insertTokenUsage: (row: { timestamp: number }) => {
          if (!sinkAvailable) throw new Error("credential-shaped-row-content");
          inserted.push(row.timestamp);
        },
        insertDelivery: vi.fn(),
        insertDiagnostic: vi.fn(),
        insertChannelSnapshot: vi.fn(),
        insertAuditEvent: vi.fn(),
      } as never,
      db: { transaction: <T,>(fn: () => T) => fn },
      channelActivityTracker: { getAll: () => [] } as never,
      startupTimestamp: 0,
      snapshotIntervalMs: 300_000,
      logger: {
        warn: warning,
        info: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        audit: vi.fn(),
      } as never,
    });

    try {
      eventBus.emit("observability:token_usage", {
        timestamp: 1,
        traceId: "trace-1",
        agentId: "agent-1",
        channelId: "channel-1",
        executionId: "execution-1",
        provider: "provider",
        model: "model",
        tokens: { prompt: 1, completion: 1, total: 2 },
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        latencyMs: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        sessionKey: "tenant:user:agent",
        savedVsUncached: 0,
        cacheEligible: false,
      });

      const failed = persistence.flushPending("token_usage") as unknown;
      expect(failed).toEqual({
        ok: false,
        error: {
          kind: "persistence_unavailable",
          tables: ["token_usage"],
          pending: 1,
          dropped: 0,
        },
      });
      expect(JSON.stringify(failed)).not.toContain("credential-shaped-row-content");
      expect(warning).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledWith(
        expect.objectContaining({
          bufferName: "token_usage",
          pending: 1,
          dropped: 0,
          hint: expect.any(String),
          errorKind: "resource",
        }),
        "Observability persistence is degraded",
      );
      expect(JSON.stringify(warning.mock.calls)).not.toContain("credential-shaped-row-content");

      sinkAvailable = true;
      vi.advanceTimersByTime(500);
      const recovered = persistence.flushPending("token_usage") as unknown;
      expect(recovered).toEqual({
        ok: true,
        value: {
          tables: ["token_usage"],
          flushed: 0,
          pending: 0,
          dropped: 0,
        },
      });
      expect(inserted).toEqual([1]);
    } finally {
      clearInterval(persistence.snapshotTimer);
      persistence.drainAll();
    }
  });

  it("discards only the selected pending table before a table reset", () => {
    vi.useFakeTimers();
    const { db, eventBus, persistence, store } = setupRealPersistence();

    try {
      emitMessageProcessed(eventBus);
      emitAuditEvent(eventBus);

      const discarded = (persistence as ResettablePersistence).discardPending("delivery");
      expect(discarded).toBe(1);
      store.resetTable("delivery");
      persistence.drainAll();

      expect(store.queryDelivery()).toHaveLength(0);
      expect(store.queryDiagnostics()).toHaveLength(1);
      expect(store.queryAuditEvents({ limit: 10 })).toHaveLength(1);
    } finally {
      clearInterval(persistence.snapshotTimer);
      persistence.drainAll();
      db.close();
    }
  });

  it("flushes only the selected pending table for a canonical read", () => {
    vi.useFakeTimers();
    const { db, eventBus, persistence, store } = setupRealPersistence();

    try {
      emitMessageProcessed(eventBus);

      (persistence as FlushablePersistence).flushPending("delivery");

      expect(store.queryDelivery()).toHaveLength(1);
      expect(store.queryDiagnostics()).toHaveLength(0);
    } finally {
      clearInterval(persistence.snapshotTimer);
      persistence.drainAll();
      db.close();
    }
  });

  it("prevents reset-all rows from being resurrected while preserving audit", () => {
    vi.useFakeTimers();
    const { db, eventBus, persistence, store } = setupRealPersistence();

    try {
      emitMessageProcessed(eventBus);
      emitAuditEvent(eventBus);

      const discarded = (persistence as ResettablePersistence).discardPending("all");
      expect(discarded).toBe(2);
      store.resetAll();
      persistence.drainAll();

      expect(store.queryDelivery()).toHaveLength(0);
      expect(store.queryDiagnostics()).toHaveLength(0);
      expect(store.queryAuditEvents({ limit: 10 })).toHaveLength(1);
    } finally {
      clearInterval(persistence.snapshotTimer);
      persistence.drainAll();
      db.close();
    }
  });
});

describe("observability reset handler pending-write ordering", () => {
  it("discards the selected buffer before deleting its SQLite table", async () => {
    const order: string[] = [];
    const obsPersistence = {
      discardPending: vi.fn((table: ResettableTable) => {
        order.push(`discard:${table}`);
        return 1;
      }),
    };
    const obsStore = {
      resetTable: vi.fn((table: ObsTableName) => {
        order.push(`reset:${table}`);
        return 1;
      }),
    };
    const handlers = bindObsExportHandlers(makeResetHandlerDeps({
      obsPersistence,
      obsStore,
    }));

    await handlers["obs.reset.table"]!({
      _trustLevel: "admin",
      table: "delivery",
    });

    expect(order).toEqual(["discard:delivery", "reset:delivery"]);
  });

  it("discards all resettable buffers before deleting all SQLite rows", async () => {
    const order: string[] = [];
    const obsPersistence = {
      discardPending: vi.fn((table: ResettableTable) => {
        order.push(`discard:${table}`);
        return 2;
      }),
    };
    const obsStore = {
      resetAll: vi.fn(() => {
        order.push("reset:all");
        return { tokenUsage: 0, delivery: 1, diagnostics: 1, channels: 0 };
      }),
    };
    const handlers = bindObsExportHandlers(makeResetHandlerDeps({
      obsPersistence,
      obsStore,
    }));

    await handlers["obs.reset"]!({ _trustLevel: "admin" });

    expect(order).toEqual(["discard:all", "reset:all"]);
  });
});

describe("observability reset persistence composition", () => {
  it("threads the live persistence control into RPC dispatch dependencies", () => {
    const daemonSource = readFileSync(new URL("../daemon.ts", import.meta.url), "utf8");

    expect(/obsPersistence:\s*c\.obsPersistence/.test(daemonSource)).toBe(true);
  });
});
