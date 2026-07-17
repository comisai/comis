// SPDX-License-Identifier: Apache-2.0
/**
 * Branch-gap coverage for delivery-queue-adapter.ts.
 *
 * Targets the uncovered error-path branches in every Result-returning method
 * (enqueue/enqueueInFlight/claim/ack/nack/fail/pendingEntries/pruneExpired/depth/
 * statusCounts/recoverInFlight) plus the per-status branches in statusCounts'
 * switch statement and the nullish-traceId branch in enqueue/enqueueInFlight.
 *
 * Strategy: close the underlying DB before invoking each method to force a
 * SQLITE_MISUSE error, then assert err() shape. Seed rows with raw SQL for
 * each delivery_queue.status value so statusCounts walks every switch case.
 *
 * @module
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "./schema.js";
import { createSqliteDeliveryQueue } from "./delivery-queue-adapter.js";
import type { DeliveryQueuePort } from "@comis/core";

function createMockEventBus(): {
  emit: ReturnType<typeof vi.fn>;
  emitSafely: ReturnType<typeof vi.fn>;
} {
  const emit = vi.fn();
  return {
    emit,
    emitSafely: vi.fn((event, payload) => {
      emit(event, payload);
      return { hadListeners: false, failures: [], pendingFailures: Promise.resolve([]) };
    }),
  };
}

describe("SqliteDeliveryQueueAdapter — branch-gap coverage", () => {
  let db: Database.Database;
  let queue: DeliveryQueuePort;
  let eventBus: ReturnType<typeof createMockEventBus>;
  const now = Date.now();

  function makeEntry(overrides: Record<string, unknown> = {}) {
    return {
      text: "Hello, world!",
      channelType: "telegram",
      channelId: "ch-123",
      tenantId: "default",
      optionsJson: "{}",
      origin: "agent",
      maxAttempts: 5,
      createdAt: now,
      scheduledAt: now,
      expireAt: now + 3_600_000,
      traceId: "trace-abc",
      ...overrides,
    };
  }

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 768);
    eventBus = createMockEventBus();
    queue = createSqliteDeliveryQueue(db, eventBus);
  });

  // ---- traceId nullish-coalescing branch (line 184/217) -------------------

  describe("enqueue traceId branch", () => {
    it("persists null trace_id when enqueue input omits traceId field", async () => {
      const entry = makeEntry();
      delete (entry as Record<string, unknown>).traceId;
      const result = await queue.enqueue(entry as ReturnType<typeof makeEntry>);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const row = db
        .prepare("SELECT trace_id FROM delivery_queue WHERE id = ?")
        .get(result.value) as { trace_id: string | null };
      expect(row.trace_id).toBeNull();
    });

    it("persists null trace_id when enqueueInFlight input omits traceId field", async () => {
      const entry = makeEntry();
      delete (entry as Record<string, unknown>).traceId;
      const result = await queue.enqueueInFlight(entry as ReturnType<typeof makeEntry>);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const row = db
        .prepare("SELECT trace_id FROM delivery_queue WHERE id = ?")
        .get(result.value) as { trace_id: string | null };
      expect(row.trace_id).toBeNull();
    });
  });

  // ---- catch-block error paths (lines 196, 229, 238, 247, 256, 265, 274, 283, 302, 311) ----

  describe("error path returns err() when database is unavailable", () => {
    it("returns err result when enqueueInFlight runs against a closed database", async () => {
      db.close();
      const result = await queue.enqueueInFlight(makeEntry());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(Error);
      }
      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    it("returns err result when ack runs against a closed database", async () => {
      db.close();
      const result = await queue.ack("missing-id", "msg-x");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(Error);
      }
    });

    it("returns err result when claim runs against a closed database", async () => {
      db.close();
      const result = await queue.claim("missing-id");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(Error);
      }
    });

    it("returns err result when nack runs against a closed database", async () => {
      db.close();
      const result = await queue.nack("missing-id", "timeout", now + 60_000);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(Error);
      }
    });

    it("returns err result when fail runs against a closed database", async () => {
      db.close();
      const result = await queue.fail("missing-id", "permanent");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(Error);
      }
    });

    it("returns err result when pendingEntries runs against a closed database", async () => {
      db.close();
      const result = await queue.pendingEntries();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(Error);
      }
    });

    it("returns err result when pruneExpired runs against a closed database", async () => {
      db.close();
      const result = await queue.pruneExpired();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(Error);
      }
    });

    // NOTE: "depth runs against a closed database" branch test was removed in
    // a prior port-trim cleanup along with the queue.depth() port method. The
    // surviving statusCounts() closed-DB test below covers the equivalent path.

    it("returns err result when statusCounts runs against a closed database", async () => {
      db.close();
      const result = await queue.statusCounts();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(Error);
      }
    });

    it("returns err result when recoverInFlight runs against a closed database", async () => {
      db.close();
      const result = await queue.recoverInFlight();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(Error);
      }
    });
  });

  // ---- statusCounts switch-statement branches (lines 293-297) -------------

  describe("statusCounts switch statement walks every status", () => {
    function insertWithStatus(status: string, channelType = "telegram") {
      db.prepare(
        `INSERT INTO delivery_queue (id, text, channel_type, channel_id, tenant_id, options_json, origin,
                                       status, attempt_count, max_attempts,
                                       created_at, scheduled_at, expire_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        `id-${status}-${channelType}-${Math.random()}`,
        "t",
        channelType,
        "ch-1",
        "default",
        "{}",
        "agent",
        status,
        0,
        5,
        now,
        now,
        now + 60_000,
      );
    }

    it("returns counts grouped by every delivery_queue status enum value", async () => {
      // Seed one row per status enum value so the switch hits every case
      insertWithStatus("pending");
      insertWithStatus("in_flight");
      insertWithStatus("failed");
      insertWithStatus("delivered");
      insertWithStatus("expired");
      const result = await queue.statusCounts();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.pending).toBe(1);
      expect(result.value.inFlight).toBe(1);
      expect(result.value.failed).toBe(1);
      expect(result.value.delivered).toBe(1);
      expect(result.value.expired).toBe(1);
    });

    it("applies channelType filter and returns counts only for matching rows", async () => {
      insertWithStatus("pending", "telegram");
      insertWithStatus("pending", "discord");
      insertWithStatus("delivered", "telegram");
      const result = await queue.statusCounts("telegram");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.pending).toBe(1);
      expect(result.value.delivered).toBe(1);
    });

    it("returns all zero counts when delivery_queue table is empty", async () => {
      const result = await queue.statusCounts();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual({
        pending: 0,
        inFlight: 0,
        failed: 0,
        delivered: 0,
        expired: 0,
      });
    });

    it("rejects insert of unrecognized status via delivery_queue CHECK constraint", () => {
      // The delivery_queue.status column has a CHECK constraint enforcing
      // ('pending', 'in_flight', 'delivered', 'failed', 'expired'). The switch
      // intentionally has no default branch — this is safe because the schema
      // CHECK constraint is the upstream gate.
      expect(() => {
        db.prepare(
          `INSERT INTO delivery_queue (id, text, channel_type, channel_id, tenant_id, options_json, origin,
                                         status, attempt_count, max_attempts,
                                         created_at, scheduled_at, expire_at)
           VALUES ('weird-id', 't', 'tg', 'c1', 'def', '{}', 'agent', 'mystery_status', 0, 5, ?, ?, ?)`,
        ).run(now, now, now + 60_000);
      }).toThrow(/CHECK constraint failed/);
    });
  });
});
