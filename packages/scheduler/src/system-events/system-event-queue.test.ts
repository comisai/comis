import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSystemEventQueue } from "./system-event-queue.js";
import type { SystemEventQueue } from "./system-event-queue.js";

function makeLogger() {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return logger;
}

describe("SystemEventQueue", () => {
  let queue: SystemEventQueue;
  let logger: ReturnType<typeof makeLogger>;
  let clock: number;

  beforeEach(() => {
    logger = makeLogger();
    clock = 1000;
    queue = createSystemEventQueue({
      logger,
      maxCapacity: 20,
      nowMs: () => clock++,
    });
  });

  // ---- Capacity enforcement ----
  describe("capacity enforcement", () => {
    it("drops oldest event when queue exceeds maxCapacity", () => {
      const q = createSystemEventQueue({
        logger,
        maxCapacity: 20,
        nowMs: () => clock++,
      });

      for (let i = 0; i < 21; i++) {
        q.enqueue(`event-${i}`, { contextKey: "test:cap", sessionKey: "sess-a" });
      }

      expect(q.size("sess-a")).toBe(20);

      const entries = q.peek("sess-a");
      // Oldest (event-0) should be dropped; newest (event-20) should be present
      expect(entries[0]!.text).toBe("event-1");
      expect(entries[entries.length - 1]!.text).toBe("event-20");
    });
  });

  // ---- Enqueue API shape ----
  describe("enqueue API", () => {
    it("enqueues event with text, contextKey, and enqueuedAt timestamp", () => {
      const q = createSystemEventQueue({
        logger,
        nowMs: () => 5000,
      });

      q.enqueue("disk check", { contextKey: "cron:disk-1", sessionKey: "default:user1:ch1" });
      const entries = q.peek("default:user1:ch1");

      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual({
        text: "disk check",
        contextKey: "cron:disk-1",
        enqueuedAt: 5000,
      });
    });
  });

  // ---- Peek is non-destructive ----
  describe("peek non-destructive", () => {
    it("does not consume entries when peeking", () => {
      queue.enqueue("a", { contextKey: "test:1", sessionKey: "s1" });
      queue.enqueue("b", { contextKey: "test:2", sessionKey: "s1" });
      queue.enqueue("c", { contextKey: "test:3", sessionKey: "s1" });

      const peeked = queue.peek("s1");
      expect(peeked).toHaveLength(3);
      expect(queue.size("s1")).toBe(3);

      // Peek again to confirm same result
      const peekedAgain = queue.peek("s1");
      expect(peekedAgain).toHaveLength(3);
      expect(peekedAgain).toEqual(peeked);
    });
  });

  // ---- Drain is destructive ----
  describe("drain destructive", () => {
    it("returns all entries and removes them from the queue", () => {
      queue.enqueue("x", { contextKey: "test:x", sessionKey: "s1" });
      queue.enqueue("y", { contextKey: "test:y", sessionKey: "s1" });
      queue.enqueue("z", { contextKey: "test:z", sessionKey: "s1" });

      const drained = queue.drain("s1");
      expect(drained).toHaveLength(3);
      expect(drained.map((e) => e.text)).toEqual(["x", "y", "z"]);

      // Queue should be empty after drain
      expect(queue.size("s1")).toBe(0);
      expect(queue.peek("s1")).toEqual([]);
    });
  });

  // ---- Consecutive duplicate deduplication ----
  describe("consecutive dedup", () => {
    it("collapses consecutive duplicate text but keeps non-consecutive duplicates", () => {
      queue.enqueue("A", { contextKey: "test:a1", sessionKey: "s1" });
      queue.enqueue("A", { contextKey: "test:a2", sessionKey: "s1" }); // collapsed
      queue.enqueue("B", { contextKey: "test:b1", sessionKey: "s1" });
      queue.enqueue("A", { contextKey: "test:a3", sessionKey: "s1" }); // kept (non-consecutive)

      const entries = queue.peek("s1");
      expect(entries).toHaveLength(3);
      expect(entries.map((e) => e.text)).toEqual(["A", "B", "A"]);
    });
  });

  // ---- Context key preserved ----
  describe("contextKey", () => {
    it("preserves distinct contextKeys on each entry", () => {
      queue.enqueue("cron result", { contextKey: "cron:job-1", sessionKey: "s1" });
      queue.enqueue("exec result", { contextKey: "exec:cmd-2", sessionKey: "s1" });

      const entries = queue.peek("s1");
      expect(entries[0]!.contextKey).toBe("cron:job-1");
      expect(entries[1]!.contextKey).toBe("exec:cmd-2");
    });
  });

  // ---- Logging ----
  describe("logging", () => {
    it("logs at DEBUG on enqueue", () => {
      queue.enqueue("hello", { contextKey: "test:1", sessionKey: "s1" });

      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "s1",
          contextKey: "test:1",
          text: "hello",
          queueSize: 1,
        }),
        "System event enqueued",
      );
    });

    it("logs at DEBUG on drain with count", () => {
      queue.enqueue("a", { contextKey: "test:a", sessionKey: "s1" });
      queue.enqueue("b", { contextKey: "test:b", sessionKey: "s1" });
      logger.debug.mockClear();

      queue.drain("s1");

      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ sessionKey: "s1", count: 2 }),
        "System events drained",
      );
    });

    it("logs at WARN on capacity overflow with hint and errorKind", () => {
      const q = createSystemEventQueue({
        logger,
        maxCapacity: 2,
        nowMs: () => clock++,
      });

      q.enqueue("first", { contextKey: "test:1", sessionKey: "s1" });
      q.enqueue("second", { contextKey: "test:2", sessionKey: "s1" });
      q.enqueue("third", { contextKey: "test:3", sessionKey: "s1" }); // triggers overflow

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "s1",
          droppedText: "first",
          hint: expect.stringContaining("oldest event dropped"),
          errorKind: "resource",
        }),
        "System event dropped (capacity overflow)",
      );
    });

    it("logs at DEBUG on consecutive duplicate collapse", () => {
      queue.enqueue("dup", { contextKey: "test:d", sessionKey: "s1" });
      logger.debug.mockClear();

      queue.enqueue("dup", { contextKey: "test:d2", sessionKey: "s1" });

      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "s1",
          text: "dup",
        }),
        "Consecutive duplicate collapsed",
      );
    });
  });

  // ---- Session isolation ----
  describe("session isolation", () => {
    it("events from different sessions do not cross-pollinate", () => {
      queue.enqueue("for-a", { contextKey: "test:a", sessionKey: "sess-a" });
      queue.enqueue("for-b", { contextKey: "test:b", sessionKey: "sess-b" });

      const aEntries = queue.peek("sess-a");
      const bEntries = queue.peek("sess-b");

      expect(aEntries).toHaveLength(1);
      expect(aEntries[0]!.text).toBe("for-a");
      expect(bEntries).toHaveLength(1);
      expect(bEntries[0]!.text).toBe("for-b");
    });
  });

  // ---- Peek returns frozen copy ----
  describe("peek returns frozen copy", () => {
    it("returned array is frozen and mutation does not affect queue", () => {
      queue.enqueue("item", { contextKey: "test:1", sessionKey: "s1" });
      const peeked = queue.peek("s1");

      expect(Object.isFrozen(peeked)).toBe(true);

      // Verify the array cannot be mutated
      expect(() => {
        (peeked as SystemEventEntry[]).push({
          text: "injected",
          contextKey: "evil",
          enqueuedAt: 0,
        });
      }).toThrow();

      // Original queue unaffected
      expect(queue.size("s1")).toBe(1);
    });
  });

  // ---- Clear ----
  describe("clear", () => {
    it("removes all entries for a session", () => {
      queue.enqueue("a", { contextKey: "test:a", sessionKey: "s1" });
      queue.enqueue("b", { contextKey: "test:b", sessionKey: "s1" });

      queue.clear("s1");

      expect(queue.size("s1")).toBe(0);
      expect(queue.peek("s1")).toEqual([]);
    });
  });

  // ---- ClearAll ----
  describe("clearAll", () => {
    it("removes entries for all sessions", () => {
      queue.enqueue("a", { contextKey: "test:a", sessionKey: "sess-a" });
      queue.enqueue("b", { contextKey: "test:b", sessionKey: "sess-b" });
      queue.enqueue("c", { contextKey: "test:c", sessionKey: "sess-c" });

      queue.clearAll();

      expect(queue.size("sess-a")).toBe(0);
      expect(queue.size("sess-b")).toBe(0);
      expect(queue.size("sess-c")).toBe(0);
    });
  });

  // ---- Drain empty session ----
  describe("drain empty session", () => {
    it("returns empty array without error for unknown session", () => {
      const result = queue.drain("nonexistent");
      expect(result).toEqual([]);
    });
  });
});
