// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "./schema.js";
import { createSqliteDeliveryQueue } from "./delivery-queue-adapter.js";
import type { DeliveryQueuePort } from "@comis/core";

describe("SqliteDeliveryQueueAdapter", () => {
  let db: Database.Database;
  let queue: DeliveryQueuePort;

  const now = Date.now();

  /** Helper to create a minimal enqueue input. */
  function makeEntry(overrides: Record<string, unknown> = {}) {
    return {
      text: "Hello, world!",
      channelType: "telegram",
      channelId: "ch-123",
      tenantId: "default",
      optionsJson: "{}",
      origin: "agent",
      formatApplied: false,
      chunkingApplied: false,
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
    queue = createSqliteDeliveryQueue(db);
  });

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
      const depth = await queue.depth();
      expect(depth.ok).toBe(true);
      if (depth.ok) {
        expect(depth.value).toBe(1);
      }
    });

    it("persists all fields correctly", async () => {
      await queue.enqueue(
        makeEntry({ formatApplied: true, chunkingApplied: true }),
      );
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
        expect(entry.formatApplied).toBe(true);
        expect(entry.chunkingApplied).toBe(true);
        expect(entry.status).toBe("pending");
        expect(entry.attemptCount).toBe(0);
        expect(entry.maxAttempts).toBe(5);
        expect(entry.traceId).toBe("trace-abc");
        expect(entry.markdownFallbackApplied).toBe(false);
        expect(entry.deliveredMessageId).toBeNull();
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

      const depth = await queue.depth();
      expect(depth.ok).toBe(true);
      if (depth.ok) {
        expect(depth.value).toBe(0);
      }
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

      const depth = await queue.depth();
      expect(depth.ok).toBe(true);
      if (depth.ok) {
        expect(depth.value).toBe(1);
      }
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
      const depth = await queue.depth();
      expect(depth.ok).toBe(true);
      if (depth.ok) {
        expect(depth.value).toBe(0);
      }
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

      const depth = await queue.depth();
      expect(depth.ok).toBe(true);
      if (depth.ok) {
        expect(depth.value).toBe(0);
      }
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

  // -----------------------------------------------------------------------
  // depth
  // -----------------------------------------------------------------------

  describe("depth", () => {
    it("counts pending and in_flight entries only", async () => {
      // 2 pending entries
      await queue.enqueue(makeEntry({ text: "a" }));
      await queue.enqueue(makeEntry({ text: "b" }));
      // 1 entry acked (delivered)
      const ackResult = await queue.enqueue(makeEntry({ text: "c" }));
      if (ackResult.ok) await queue.ack(ackResult.value, "msg-c");
      // 1 entry failed
      const failResult = await queue.enqueue(makeEntry({ text: "d" }));
      if (failResult.ok) await queue.fail(failResult.value, "permanent");

      const depth = await queue.depth();
      expect(depth.ok).toBe(true);
      if (depth.ok) {
        expect(depth.value).toBe(2); // only the 2 pending entries
      }
    });

    it("returns 0 on empty queue", async () => {
      const depth = await queue.depth();
      expect(depth.ok).toBe(true);
      if (depth.ok) {
        expect(depth.value).toBe(0);
      }
    });
  });
});
