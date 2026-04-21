// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TypedEventBus } from "@comis/core";
import { createEventAwaiter, type EventAwaiter } from "./event-awaiter.js";

describe("EventAwaiter", () => {
  let bus: TypedEventBus;
  let awaiter: EventAwaiter;

  beforeEach(() => {
    bus = new TypedEventBus();
    awaiter = createEventAwaiter(bus);
  });

  afterEach(() => {
    awaiter.dispose();
  });

  // ---------------------------------------------------------------------------
  // waitFor
  // ---------------------------------------------------------------------------

  describe("waitFor", () => {
    it("resolves with payload when event fires", async () => {
      const payload = { channelId: "ch-1", messageId: "msg-1", content: "hello" };
      const promise = awaiter.waitFor("message:sent");
      queueMicrotask(() => bus.emit("message:sent", payload));
      const result = await promise;
      expect(result).toEqual(payload);
    });

    it("rejects on timeout", async () => {
      await expect(
        awaiter.waitFor("message:sent", { timeoutMs: 50 }),
      ).rejects.toThrow(
        'EventAwaiter: timeout waiting for "message:sent" after 50ms',
      );
    });

    it("resolves only when filter returns true", async () => {
      const wrongPayload = { channelId: "ch-wrong", messageId: "msg-0", content: "nope" };
      const rightPayload = { channelId: "ch-1", messageId: "msg-1", content: "hello" };

      const promise = awaiter.waitFor("message:sent", {
        filter: (p) => p.channelId === "ch-1",
      });

      queueMicrotask(() => {
        bus.emit("message:sent", wrongPayload);
        bus.emit("message:sent", rightPayload);
      });

      const result = await promise;
      expect(result).toEqual(rightPayload);
    });

    it("cleans up listener after resolve", async () => {
      const payload = { channelId: "ch-1", messageId: "msg-1", content: "hello" };
      const promise = awaiter.waitFor("message:sent");
      queueMicrotask(() => bus.emit("message:sent", payload));
      await promise;
      expect(bus.listenerCount("message:sent")).toBe(0);
    });

    it("cleans up listener after timeout", async () => {
      try {
        await awaiter.waitFor("message:sent", { timeoutMs: 50 });
      } catch {
        // Expected rejection
      }
      expect(bus.listenerCount("message:sent")).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // waitForAll
  // ---------------------------------------------------------------------------

  describe("waitForAll", () => {
    it("collects N events", async () => {
      const payloads = [
        { channelId: "ch-1", messageId: "msg-1", content: "first" },
        { channelId: "ch-1", messageId: "msg-2", content: "second" },
        { channelId: "ch-1", messageId: "msg-3", content: "third" },
      ];

      const promise = awaiter.waitForAll("message:sent", 3);

      queueMicrotask(() => {
        for (const p of payloads) {
          bus.emit("message:sent", p);
        }
      });

      const result = await promise;
      expect(result).toHaveLength(3);
      expect(result[0].content).toBe("first");
      expect(result[1].content).toBe("second");
      expect(result[2].content).toBe("third");
    });

    it("rejects on timeout with partial count", async () => {
      const promise = awaiter.waitForAll("message:sent", 3, { timeoutMs: 50 });

      queueMicrotask(() => {
        bus.emit("message:sent", { channelId: "ch-1", messageId: "msg-1", content: "only-one" });
      });

      await expect(promise).rejects.toThrow(
        /collected 1\/3/,
      );
    });

    it("cleans up listener after collection", async () => {
      const promise = awaiter.waitForAll("message:sent", 2);

      queueMicrotask(() => {
        bus.emit("message:sent", { channelId: "ch-1", messageId: "msg-1", content: "a" });
        bus.emit("message:sent", { channelId: "ch-1", messageId: "msg-2", content: "b" });
      });

      await promise;
      expect(bus.listenerCount("message:sent")).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // waitForSequence
  // ---------------------------------------------------------------------------

  describe("waitForSequence", () => {
    it("resolves when events fire in order", async () => {
      const sessionPayload = {
        sessionKey: { tenantId: "t1", userId: "u1", channelId: "c1" },
        timestamp: Date.now(),
      };
      const messagePayload = { channelId: "ch-1", messageId: "msg-1", content: "hello" };

      const promise = awaiter.waitForSequence(["session:created", "message:sent"]);

      queueMicrotask(() => {
        bus.emit("session:created", sessionPayload);
        bus.emit("message:sent", messagePayload);
      });

      const results = await promise;
      expect(results).toHaveLength(2);
      expect(results[0]).toEqual(sessionPayload);
      expect(results[1]).toEqual(messagePayload);
    });

    it("ignores out-of-order events", async () => {
      const sessionPayload = {
        sessionKey: { tenantId: "t1", userId: "u1", channelId: "c1" },
        timestamp: Date.now(),
      };
      const messagePayload = { channelId: "ch-1", messageId: "msg-1", content: "hello" };

      const promise = awaiter.waitForSequence(["session:created", "message:sent"]);

      queueMicrotask(() => {
        // Emit message:sent first -- should be ignored (sequence expects session:created first)
        bus.emit("message:sent", { channelId: "ch-0", messageId: "msg-0", content: "too-early" });
        // Now the correct order
        bus.emit("session:created", sessionPayload);
        bus.emit("message:sent", messagePayload);
      });

      const results = await promise;
      expect(results).toHaveLength(2);
      expect(results[0]).toEqual(sessionPayload);
      expect(results[1]).toEqual(messagePayload);
    });

    it("rejects on timeout", async () => {
      const sessionPayload = {
        sessionKey: { tenantId: "t1", userId: "u1", channelId: "c1" },
        timestamp: Date.now(),
      };

      const promise = awaiter.waitForSequence(["session:created", "message:sent"], {
        timeoutMs: 50,
      });

      queueMicrotask(() => {
        bus.emit("session:created", sessionPayload);
        // Never emit message:sent
      });

      await expect(promise).rejects.toThrow(
        /timeout waiting for sequence at index 1/,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // collectDuring
  // ---------------------------------------------------------------------------

  describe("collectDuring", () => {
    it("captures events emitted during operation", async () => {
      const result = await awaiter.collectDuring("message:sent", async () => {
        bus.emit("message:sent", { channelId: "ch-1", messageId: "msg-1", content: "first" });
        bus.emit("message:sent", { channelId: "ch-1", messageId: "msg-2", content: "second" });
      });

      expect(result).toHaveLength(2);
      expect(result[0].content).toBe("first");
      expect(result[1].content).toBe("second");
    });

    it("returns empty array when no events emitted", async () => {
      const result = await awaiter.collectDuring("message:sent", async () => {
        // No events
      });
      expect(result).toEqual([]);
    });

    it("removes listener after operation completes", async () => {
      await awaiter.collectDuring("message:sent", async () => {
        bus.emit("message:sent", { channelId: "ch-1", messageId: "msg-1", content: "x" });
      });

      expect(bus.listenerCount("message:sent")).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // dispose
  // ---------------------------------------------------------------------------

  describe("dispose", () => {
    it("removes all active listeners and rejects pending promises", async () => {
      // Start a waitFor that will never resolve naturally
      const promise = awaiter.waitFor("message:sent", { timeoutMs: 60_000 });
      expect(bus.listenerCount("message:sent")).toBe(1);

      awaiter.dispose();

      expect(bus.listenerCount("message:sent")).toBe(0);

      // The promise should be rejected with a "disposed" error
      await expect(promise).rejects.toThrow("EventAwaiter: disposed while waiting");
    });

    it("is safe to call multiple times", () => {
      awaiter.dispose();
      awaiter.dispose();
      // No error thrown
    });
  });
});
