// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the per-conversation single-flight ingest serializer,
 * `createIngestSerializer`.
 *
 * The serializer is the integrity boundary the deferred compaction requires: once the
 * afterTurn leaf/condense compaction is DEFERRED off the turn, a detached
 * compaction write can race the NEXT turn's synchronous ingest on the same
 * conversation's `(conversation_id, seq)` index. Routing BOTH writers through a
 * per-conversation `PQueue({ concurrency: 1 })` makes them strictly one-at-a-time
 * so they can never interleave. Different conversations keep their own queue, so
 * they run concurrently (per-conversation, not a global lock).
 *
 * Contracts proven RED → GREEN:
 *  - same conversationId ⇒ strictly serialized (no overlap window);
 *  - different conversationIds ⇒ concurrent (a fast op on B finishes before a
 *    slow op on A even though A was enqueued first);
 *  - FIFO + value pass-through within one conversation;
 *  - a rejecting op does NOT wedge the queue for that conversation (it recovers).
 */
import { describe, it, expect } from "vitest";
import { createIngestSerializer } from "./lcd-ingest-serializer.js";

/** A microtask-yielding delay built on awaited Promise.resolve() ticks — no
 *  real timer (the globals gate forbids raw setTimeout; we only need ordering,
 *  not wall-clock duration). Yields `ticks` times so a concurrently-scheduled
 *  faster op (fewer ticks) can complete first. */
async function yieldTicks(ticks: number): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
  }
}

describe("createIngestSerializer — per-conversation single-flight", () => {
  it("two operations enqueued for the same conversationId run strictly one-at-a-time (no overlap)", async () => {
    const serializer = createIngestSerializer();
    const events: string[] = [];

    // Two ops on the SAME conversation. If they overlapped, the start/end
    // markers would interleave (e.g. a-start, b-start, …). Serialized ⇒ the
    // first fully ends before the second starts.
    const first = serializer.runOnConversation("conv-x", async () => {
      events.push("a-start");
      await yieldTicks(5);
      events.push("a-end");
    });
    const second = serializer.runOnConversation("conv-x", async () => {
      events.push("b-start");
      await yieldTicks(1);
      events.push("b-end");
    });

    await Promise.all([first, second]);

    // Strict serialization: a fully completes before b begins.
    expect(events).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("operations for different conversationIds run concurrently (the serializer is per-conversation, not global)", async () => {
    const serializer = createIngestSerializer();
    const completed: string[] = [];

    // A SLOW op on conv-x enqueued FIRST, then a FAST op on conv-y. A global
    // lock would force y to wait for x (x completes first). A per-conversation
    // serializer lets them run concurrently ⇒ the fast y finishes before x.
    const slow = serializer.runOnConversation("conv-x", async () => {
      await yieldTicks(10);
      completed.push("x");
    });
    const fast = serializer.runOnConversation("conv-y", async () => {
      await yieldTicks(1);
      completed.push("y");
    });

    await Promise.all([slow, fast]);

    // Different conversations ⇒ concurrent ⇒ the fast one (y) completes first.
    expect(completed).toEqual(["y", "x"]);
  });

  it("the serializer resolves to each operation's return value in enqueue order for one conversation", async () => {
    const serializer = createIngestSerializer();
    const order: number[] = [];

    // FIFO: enqueue three value-returning ops; each records its run order and
    // returns a distinct value. The returned values must match the enqueue order.
    const r1 = serializer.runOnConversation("conv-z", async () => {
      await yieldTicks(3);
      order.push(1);
      return "one";
    });
    const r2 = serializer.runOnConversation("conv-z", async () => {
      await yieldTicks(2);
      order.push(2);
      return "two";
    });
    const r3 = serializer.runOnConversation("conv-z", async () => {
      await yieldTicks(1);
      order.push(3);
      return "three";
    });

    const values = await Promise.all([r1, r2, r3]);

    expect(values).toEqual(["one", "two", "three"]); // value pass-through, in order
    expect(order).toEqual([1, 2, 3]); // FIFO despite descending self-delays
  });

  it("a rejected operation does not wedge the queue for that conversation (the queue recovers)", async () => {
    const serializer = createIngestSerializer();

    // A rejecting op MUST surface its rejection to its own caller …
    const rejecting = serializer.runOnConversation("conv-r", async () => {
      await yieldTicks(1);
      throw new Error("ingest write failed");
    });
    await expect(rejecting).rejects.toThrow("ingest write failed");

    // … but the next op on the SAME conversation must still run (concurrency:1
    // queue with `concurrency` slot freed on rejection — not wedged forever).
    const after = await serializer.runOnConversation("conv-r", async () => {
      return "recovered";
    });
    expect(after).toBe("recovered");
  });

  it("supports a synchronous (non-Promise) operation and resolves to its return value", async () => {
    const serializer = createIngestSerializer();
    // BOTH writers can be sync (the live ingest's append is synchronous
    // better-sqlite3) — the serializer must accept `() => T` as well as
    // `() => Promise<T>`.
    const value = await serializer.runOnConversation("conv-sync", () => 42);
    expect(value).toBe(42);
  });
});
