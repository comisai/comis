// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "./schema.js";
import { createSqliteDeliveryQueue } from "./delivery-queue-adapter.js";
import {
  AMBIGUOUS_SEND_OUTCOME_ERROR,
  ConversationRefSchema,
  TypedEventBus,
  type DeliveryQueuePort,
} from "@comis/core";

const CONVERSATION_REF = ConversationRefSchema.parse(`cv_${"a".repeat(43)}`);
const DESTINATION_ENDPOINT = {
  channelType: "telegram",
  channelInstanceId: "telegram-account",
  conversationId: "ch-123",
  conversationKind: "direct" as const,
};

// Inline mock event bus -- adapter only needs Pick<TypedEventBus, "emit">,
// so an 8-line spy is sufficient. Mirrors the local-mock pattern used in
// delivery-queue-logger.test.ts in the daemon package (in-package tests do
// NOT reach into repo-root test/support/ -- that path is reserved for
// integration tests per AGENTS section 2.5).
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

describe("SqliteDeliveryQueueAdapter", () => {
  let db: Database.Database;
  let queue: DeliveryQueuePort;
  let eventBus: ReturnType<typeof createMockEventBus>;

  const now = Date.now();

  /** Helper to create a minimal enqueue input. */
  function makeEntry(overrides: Record<string, unknown> = {}) {
    return {
      text: "Hello, world!",
      channelType: "telegram",
      channelId: "ch-123",
      tenantId: "default",
      agentId: "agent-a",
      conversationRef: CONVERSATION_REF,
      destinationEndpoint: DESTINATION_ENDPOINT,
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

  /**
   * Helper that reads active delivery_queue depth via direct SQL. Replaces the
   * deleted queue.depth() port method (removed in a prior port-trim cleanup);
   * the count semantics — pending + in_flight — are preserved verbatim.
   */
  function readDepth(): number {
    const row = db
      .prepare("SELECT COUNT(*) as count FROM delivery_queue WHERE status IN ('pending', 'in_flight')")
      .get() as { count: number };
    return row.count;
  }

  // -----------------------------------------------------------------------
  // enqueue
  // -----------------------------------------------------------------------

  describe("enqueue", () => {
    it("returns ok with a UUID string", async () => {
      const result = await queue.enqueue(makeEntry());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
      }
    });

    it("increments depth to 1 after enqueue", async () => {
      await queue.enqueue(makeEntry());
      expect(readDepth()).toBe(1);
    });

    it("persists all fields correctly", async () => {
      await queue.enqueue(makeEntry());
      const pending = await queue.pendingEntries();
      expect(pending.ok).toBe(true);
      if (pending.ok) {
        const entry = pending.value[0]!;
        expect(entry.text).toBe("Hello, world!");
        expect(entry.channelType).toBe("telegram");
        expect(entry.channelId).toBe("ch-123");
        expect(entry.tenantId).toBe("default");
        expect(entry.optionsJson).toBe("{}");
        expect(entry.origin).toBe("agent");
        expect(entry.status).toBe("pending");
        expect(entry.attemptCount).toBe(0);
        expect(entry.maxAttempts).toBe(5);
        expect(entry.traceId).toBe("trace-abc");
        expect(entry.lastAttemptAt).toBeNull();
        expect(entry.nextRetryAt).toBeNull();
        expect(entry.lastError).toBeNull();
      }
    });
  });

  // -----------------------------------------------------------------------
  // ack
  // -----------------------------------------------------------------------

  describe("ack", () => {
    it("marks entry as delivered and removes from depth count", async () => {
      const enqResult = await queue.enqueue(makeEntry());
      expect(enqResult.ok).toBe(true);
      if (!enqResult.ok) return;

      const ackResult = await queue.ack(enqResult.value, "msg-telegram-42");
      expect(ackResult.ok).toBe(true);

      expect(readDepth()).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // nack
  // -----------------------------------------------------------------------

  describe("nack", () => {
    it("increments attempt_count, sets next_retry_at and last_error", async () => {
      const enqResult = await queue.enqueue(makeEntry());
      expect(enqResult.ok).toBe(true);
      if (!enqResult.ok) return;

      const retryAt = now + 60_000;
      const nackResult = await queue.nack(enqResult.value, "timeout", retryAt);
      expect(nackResult.ok).toBe(true);

      // Read back the entry to verify fields
      const row = db
        .prepare("SELECT * FROM delivery_queue WHERE id = ?")
        .get(enqResult.value) as Record<string, unknown>;
      expect(row.attempt_count).toBe(1);
      expect(row.next_retry_at).toBe(retryAt);
      expect(row.last_error).toBe("timeout");
      expect(row.status).toBe("pending");
      expect(row.last_attempt_at).toBeTypeOf("number");
    });

    it("keeps entry in pending state (still counted in depth)", async () => {
      const enqResult = await queue.enqueue(makeEntry());
      if (!enqResult.ok) return;

      await queue.nack(enqResult.value, "err", now + 60_000);

      // Depth should be 1 (nacked still in pending)
      expect(readDepth()).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // fail
  // -----------------------------------------------------------------------

  describe("fail", () => {
    it("marks entry as permanently failed and removes from depth count", async () => {
      const enqResult = await queue.enqueue(makeEntry());
      expect(enqResult.ok).toBe(true);
      if (!enqResult.ok) return;

      const failResult = await queue.fail(
        enqResult.value,
        "permanent: channel not found",
      );
      expect(failResult.ok).toBe(true);

      // Verify status
      const row = db
        .prepare("SELECT status, last_error FROM delivery_queue WHERE id = ?")
        .get(enqResult.value) as Record<string, unknown>;
      expect(row.status).toBe("failed");
      expect(row.last_error).toBe("permanent: channel not found");

      // Depth should be 0 (failed entries excluded)
      expect(readDepth()).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // pendingEntries
  // -----------------------------------------------------------------------

  describe("pendingEntries", () => {
    it("returns only entries where scheduled_at <= now, ordered by created_at ASC", async () => {
      // Entry 1: scheduled in the past (should appear)
      await queue.enqueue(
        makeEntry({ text: "old", createdAt: now - 3000, scheduledAt: now - 2000 }),
      );
      // Entry 2: scheduled now (should appear)
      await queue.enqueue(
        makeEntry({ text: "current", createdAt: now - 2000, scheduledAt: now }),
      );
      // Entry 3: scheduled in the future (should NOT appear)
      await queue.enqueue(
        makeEntry({
          text: "future",
          createdAt: now - 1000,
          scheduledAt: now + 60_000,
        }),
      );

      const result = await queue.pendingEntries();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(2);
        expect(result.value[0]!.text).toBe("old");
        expect(result.value[1]!.text).toBe("current");
      }
    });

    it("excludes non-pending statuses", async () => {
      const enqResult = await queue.enqueue(makeEntry());
      if (!enqResult.ok) return;

      await queue.ack(enqResult.value, "msg-1");

      const result = await queue.pendingEntries();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(0);
      }
    });

    it("does not return a nacked row before its retry deadline", async () => {
      const enqResult = await queue.enqueue(makeEntry());
      expect(enqResult.ok).toBe(true);
      if (!enqResult.ok) return;

      await queue.nack(enqResult.value, "rate limited", now + 60_000);

      const result = await queue.pendingEntries();
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // claim (atomic drainer ownership)
  // -----------------------------------------------------------------------

  describe("claim", () => {
    it("allows exactly one atomic pending-to-in-flight claimant", async () => {
      const enqResult = await queue.enqueue(makeEntry());
      expect(enqResult.ok).toBe(true);
      if (!enqResult.ok) return;

      const claimable = queue as unknown as {
        claim(id: string): Promise<{ ok: true; value: boolean } | { ok: false; error: Error }>;
      };
      const [first, second] = await Promise.all([
        claimable.claim(enqResult.value),
        claimable.claim(enqResult.value),
      ]);

      expect(first.ok && first.value).toBe(true);
      expect(second.ok && second.value).toBe(false);
      const row = db
        .prepare("SELECT status, last_attempt_at FROM delivery_queue WHERE id = ?")
        .get(enqResult.value) as { status: string; last_attempt_at: number | null };
      expect(row.status).toBe("in_flight");
      expect(row.last_attempt_at).toBeTypeOf("number");
    });
  });

  // -----------------------------------------------------------------------
  // pruneExpired
  // -----------------------------------------------------------------------

  describe("pruneExpired", () => {
    it("removes expired non-delivered entries", async () => {
      // Entry with expire_at in the past
      await queue.enqueue(makeEntry({ expireAt: now - 1000 }));

      const result = await queue.pruneExpired();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(1);
      }

      expect(readDepth()).toBe(0);
    });

    it("does NOT prune delivered entries even if expired", async () => {
      const enqResult = await queue.enqueue(makeEntry({ expireAt: now - 1000 }));
      if (!enqResult.ok) return;

      // Ack it so status = delivered
      await queue.ack(enqResult.value, "msg-1");

      const result = await queue.pruneExpired();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(0);
      }

      // Verify the row still exists
      const count = db
        .prepare("SELECT COUNT(*) as c FROM delivery_queue")
        .get() as { c: number };
      expect(count.c).toBe(1);
    });

    it("returns 0 when nothing to prune", async () => {
      const result = await queue.pruneExpired();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(0);
      }
    });
  });

  // NOTE: describe("depth") was removed in a prior port-trim cleanup along with
  // the queue.depth() port method. The status-counting semantics live on
  // queue.statusCounts() (pending + in_flight equivalents).

  // -----------------------------------------------------------------------
  // enqueue eventBus emission
  // -----------------------------------------------------------------------

  describe("enqueue eventBus emission", () => {
    it("emits exactly one delivery:enqueued event per enqueue", async () => {
      const result = await queue.enqueue(makeEntry({ origin: "agent" }));
      expect(result.ok).toBe(true);
      expect(eventBus.emit).toHaveBeenCalledTimes(1);
      const [eventName, payload] = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(eventName).toBe("delivery:enqueued");
      expect(payload).toMatchObject({
        entryId: result.ok ? result.value : "",
        channelId: "ch-123",
        channelType: "telegram",
        origin: "agent",
      });
      expect(typeof (payload as { timestamp: number }).timestamp).toBe("number");
    });

    it("does not emit when enqueue fails (SQL error -> no event)", async () => {
      db.close();
      const result = await queue.enqueue(makeEntry());
      expect(result.ok).toBe(false);
      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    it("keeps the persisted entry id and reaches later listeners when one subscriber throws", async () => {
      const realBus = new TypedEventBus();
      const laterListener = vi.fn();
      realBus.on("delivery:enqueued", () => {
        throw new Error("subscriber failed");
      });
      realBus.on("delivery:enqueued", laterListener);
      const isolatedQueue = createSqliteDeliveryQueue(db, realBus);

      const result = await isolatedQueue.enqueueInFlight(makeEntry());

      expect(result.ok).toBe(true);
      expect(laterListener).toHaveBeenCalledTimes(1);
      const count = db.prepare("SELECT COUNT(*) AS count FROM delivery_queue")
        .get() as { count: number };
      expect(count.count).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // enqueueInFlight (race safety)
  // -----------------------------------------------------------------------

  describe("enqueueInFlight", () => {
    it("inserts row with status='in_flight'", async () => {
      const result = await queue.enqueueInFlight(makeEntry());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const row = db
        .prepare("SELECT status FROM delivery_queue WHERE id = ?")
        .get(result.value) as { status: string };
      expect(row.status).toBe("in_flight");
    });

    it("emits the same delivery:enqueued event as enqueue", async () => {
      const result = await queue.enqueueInFlight(makeEntry({ origin: "channel" }));
      expect(result.ok).toBe(true);
      expect(eventBus.emit).toHaveBeenCalledTimes(1);
      const [eventName, payload] = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(eventName).toBe("delivery:enqueued");
      expect(payload).toMatchObject({
        entryId: result.ok ? result.value : "",
        channelId: "ch-123",
        channelType: "telegram",
        origin: "channel",
      });
    });

    it("in_flight rows are NOT visible to pendingEntries (race safety)", async () => {
      await queue.enqueueInFlight(makeEntry());
      const pending = await queue.pendingEntries();
      expect(pending.ok).toBe(true);
      if (pending.ok) expect(pending.value).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // unconfirmedEntries (MCP resources/read CONFIRMED-only leak guard)
  //
  // pendingEntries() is scoped to the drainer ("due to send now" =
  // status='pending' AND scheduled_at<=now) and intentionally hides in_flight
  // rows. The MCP resources/read CONFIRMED-only filter needs the OPPOSITE: the
  // full set of NOT-yet-delivered entries (anything except 'delivered') so an
  // in-flight / failed / future-scheduled outbound message is never reported as
  // confirmed and leaked to an MCP client. unconfirmedEntries() is that query.
  // -----------------------------------------------------------------------

  describe("unconfirmedEntries", () => {
    it("returns pending + in_flight + failed entries and excludes delivered", async () => {
      // pending (also future-scheduled, to prove no scheduled_at gate)
      await queue.enqueue(makeEntry({ text: "p-now", scheduledAt: now }));
      await queue.enqueue(makeEntry({ text: "p-future", scheduledAt: now + 60_000 }));
      // in_flight
      await queue.enqueueInFlight(makeEntry({ text: "inflight" }));
      // failed
      const failResult = await queue.enqueue(makeEntry({ text: "failed" }));
      if (failResult.ok) await queue.fail(failResult.value, "boom");
      // delivered (must be excluded)
      const okResult = await queue.enqueue(makeEntry({ text: "delivered" }));
      if (okResult.ok) await queue.ack(okResult.value, "msg-1");

      const result = await queue.unconfirmedEntries();
      expect(result.ok).toBe(true);
      if (result.ok) {
        const texts = result.value.map((e) => e.text).sort();
        expect(texts).toEqual(["failed", "inflight", "p-future", "p-now"]);
        expect(texts).not.toContain("delivered");
      }
    });

    it("includes in_flight rows that pendingEntries hides (the leak the filter must close)", async () => {
      await queue.enqueueInFlight(makeEntry({ text: "inflight-only" }));

      const pending = await queue.pendingEntries();
      const unconfirmed = await queue.unconfirmedEntries();
      expect(pending.ok && unconfirmed.ok).toBe(true);
      if (pending.ok) expect(pending.value).toHaveLength(0);
      if (unconfirmed.ok) {
        expect(unconfirmed.value.map((e) => e.text)).toEqual(["inflight-only"]);
      }
    });
  });

  // -----------------------------------------------------------------------
  // recoverInFlight (startup sweep)
  // -----------------------------------------------------------------------

  describe("recoverInFlight", () => {
    it("parks all stale in_flight rows as failed with a content-free uncertainty reason", async () => {
      // Two crashed rows directly via raw SQL
      db.prepare(
        `INSERT INTO delivery_queue (id, text, channel_type, channel_id, tenant_id, agent_id,
                                       conversation_ref, destination_endpoint, options_json, origin,
                                       status, attempt_count, max_attempts,
                                       created_at, scheduled_at, expire_at, last_error)
         VALUES ('crashed-1', 't', 'tg', 'c1', 'def', 'agent-a', ?, ?, '{}', 'channel', 'in_flight', 0, 5, ?, ?, ?, 'crashed mid-send')`,
      ).run(CONVERSATION_REF, JSON.stringify(DESTINATION_ENDPOINT), now, now, now + 60_000);
      db.prepare(
        `INSERT INTO delivery_queue (id, text, channel_type, channel_id, tenant_id, agent_id,
                                       conversation_ref, destination_endpoint, options_json, origin,
                                       status, attempt_count, max_attempts,
                                       created_at, scheduled_at, expire_at, last_error)
         VALUES ('crashed-2', 't', 'tg', 'c1', 'def', 'agent-a', ?, ?, '{}', 'channel', 'in_flight', 0, 5, ?, ?, ?, NULL)`,
      ).run(CONVERSATION_REF, JSON.stringify(DESTINATION_ENDPOINT), now, now, now + 60_000);
      // One pending row via the public API (still works after constructor change)
      await queue.enqueue(makeEntry({ text: "fresh" }));

      const recovered = await queue.recoverInFlight();
      expect(recovered.ok).toBe(true);
      if (recovered.ok) expect(recovered.value).toBe(2);

      // A crash can happen after the platform accepted the message but before
      // the acknowledgement was stored. Recovery must preserve that ambiguity
      // instead of replaying the body.
      const rows = db
        .prepare(`SELECT id, status, last_error FROM delivery_queue WHERE id IN ('crashed-1', 'crashed-2')`)
        .all() as Array<{ id: string; status: string; last_error: string | null }>;
      for (const row of rows) {
        expect(row.status).toBe("failed");
        expect(row.last_error).toBe(AMBIGUOUS_SEND_OUTCOME_ERROR);
      }

      // Only the genuinely pending row remains drainable.
      const pending = await queue.pendingEntries();
      expect(pending.ok).toBe(true);
      if (pending.ok) expect(pending.value.map((entry) => entry.text)).toEqual(["fresh"]);
    });

    it("returns 0 when no in_flight rows exist", async () => {
      await queue.enqueue(makeEntry());
      const recovered = await queue.recoverInFlight();
      expect(recovered.ok).toBe(true);
      if (recovered.ok) expect(recovered.value).toBe(0);
    });
  });
});
