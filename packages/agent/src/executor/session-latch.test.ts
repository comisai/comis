/**
 * Unit tests for SessionLatch utility and session latch container (SESS-LATCH).
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { createSessionLatch, createAccumulativeLatch } from "./session-latch.js";
import type { SessionLatch, AccumulativeLatch } from "./session-latch.js";
import { _clearSessionLatchesForTest, _getOrCreateSessionLatchesForTest } from "./pi-executor.js";

describe("SessionLatch", () => {
  describe("createSessionLatch() with no args", () => {
    it("get() returns null initially", () => {
      const latch = createSessionLatch<number>();
      expect(latch.get()).toBeNull();
    });
  });

  describe("createSessionLatch(initial)", () => {
    it("get() returns the initial value", () => {
      const latch = createSessionLatch(42);
      expect(latch.get()).toBe(42);
    });

    it("setOnce(99) returns 42 (already latched)", () => {
      const latch = createSessionLatch(42);
      expect(latch.setOnce(99)).toBe(42);
      expect(latch.get()).toBe(42);
    });
  });

  describe("setOnce semantics", () => {
    it("setOnce(value) latches and get() returns it", () => {
      const latch = createSessionLatch<number>();
      const result = latch.setOnce(10);
      expect(result).toBe(10);
      expect(latch.get()).toBe(10);
    });

    it("subsequent setOnce(different) returns original value without overwriting", () => {
      const latch = createSessionLatch<number>();
      latch.setOnce(10);
      const result = latch.setOnce(20);
      expect(result).toBe(10);
      expect(latch.get()).toBe(10);
    });
  });

  describe("reset", () => {
    it("reset() clears the value to null", () => {
      const latch = createSessionLatch<number>();
      latch.setOnce(10);
      latch.reset();
      expect(latch.get()).toBeNull();
    });

    it("setOnce(newValue) succeeds after reset", () => {
      const latch = createSessionLatch<number>();
      latch.setOnce(10);
      latch.reset();
      const result = latch.setOnce(20);
      expect(result).toBe(20);
      expect(latch.get()).toBe(20);
    });
  });

  describe("type safety", () => {
    it("works with string type", () => {
      const latch: SessionLatch<string> = createSessionLatch<string>();
      latch.setOnce("hello");
      expect(latch.get()).toBe("hello");
      expect(latch.setOnce("world")).toBe("hello");
    });

    it("works with object type (reference preserved)", () => {
      const obj = { foo: "bar" };
      const latch = createSessionLatch<{ foo: string }>();
      latch.setOnce(obj);
      expect(latch.get()).toBe(obj); // Same reference
      const other = { foo: "baz" };
      expect(latch.setOnce(other)).toBe(obj); // Original reference
    });
  });

  describe("multiple reset/setOnce cycles", () => {
    it("supports repeated reset/setOnce cycles correctly", () => {
      const latch = createSessionLatch<number>();

      // Cycle 1
      latch.setOnce(1);
      expect(latch.get()).toBe(1);
      latch.reset();
      expect(latch.get()).toBeNull();

      // Cycle 2
      latch.setOnce(2);
      expect(latch.get()).toBe(2);
      latch.reset();
      expect(latch.get()).toBeNull();

      // Cycle 3
      latch.setOnce(3);
      expect(latch.get()).toBe(3);
      expect(latch.setOnce(4)).toBe(3); // Still latched at 3
    });
  });
});

// ---------------------------------------------------------------------------
// AccumulativeLatch: Accumulative value container
// ---------------------------------------------------------------------------

describe("AccumulativeLatch", () => {
  it("getAll() returns empty ReadonlySet initially", () => {
    const latch = createAccumulativeLatch<string>();
    expect(latch.getAll().size).toBe(0);
  });

  it("add() returns true for new value, false for duplicate", () => {
    const latch = createAccumulativeLatch<string>();
    expect(latch.add("a")).toBe(true);
    expect(latch.add("a")).toBe(false);
  });

  it("has() returns true after add, false for unadded values", () => {
    const latch = createAccumulativeLatch<string>();
    latch.add("a");
    expect(latch.has("a")).toBe(true);
    expect(latch.has("b")).toBe(false);
  });

  it("size() returns correct count after add/reset", () => {
    const latch = createAccumulativeLatch<string>();
    expect(latch.size()).toBe(0);
    latch.add("a");
    expect(latch.size()).toBe(1);
    latch.add("b");
    expect(latch.size()).toBe(2);
    latch.add("a"); // duplicate
    expect(latch.size()).toBe(2);
    latch.reset();
    expect(latch.size()).toBe(0);
  });

  it("reset() clears all values, subsequent getAll() returns empty set", () => {
    const latch = createAccumulativeLatch<string>();
    latch.add("a");
    latch.add("b");
    latch.reset();
    expect(latch.getAll().size).toBe(0);
    expect(latch.has("a")).toBe(false);
  });

  it("multiple values accumulate correctly", () => {
    const latch = createAccumulativeLatch<string>();
    latch.add("a");
    latch.add("b");
    latch.add("c");
    const all = latch.getAll();
    expect(all.size).toBe(3);
    expect(all.has("a")).toBe(true);
    expect(all.has("b")).toBe(true);
    expect(all.has("c")).toBe(true);
  });

  it("getAll() returns ReadonlySet reflecting internal state", () => {
    const latch = createAccumulativeLatch<string>();
    const ref1 = latch.getAll();
    latch.add("x");
    // Same reference, reflects mutations
    expect(ref1.has("x")).toBe(true);
    expect(ref1.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// SESS-LATCH: Session latch container tests (pi-executor integration)
// ---------------------------------------------------------------------------

describe("SessionLatch container (SESS-LATCH)", () => {
  const sessionA = "agent:platform:channelA:userA";
  const sessionB = "agent:platform:channelB:userB";

  it("creates independent latches per session key", () => {
    // Clean up before test
    _clearSessionLatchesForTest(sessionA);
    _clearSessionLatchesForTest(sessionB);

    const latchesA = _getOrCreateSessionLatchesForTest(sessionA);
    const latchesB = _getOrCreateSessionLatchesForTest(sessionB);

    // Session A sets a beta header value
    latchesA.betaHeader.setOnce("beta-value-a");
    // Session B should still be null
    expect(latchesB.betaHeader.get()).toBeNull();

    // Session B sets a different value
    latchesB.betaHeader.setOnce("beta-value-b");
    // Session A should still have its original value
    expect(latchesA.betaHeader.get()).toBe("beta-value-a");
    expect(latchesB.betaHeader.get()).toBe("beta-value-b");

    // Cleanup
    _clearSessionLatchesForTest(sessionA);
    _clearSessionLatchesForTest(sessionB);
  });

  it("getOrCreate returns the same container for the same session key", () => {
    _clearSessionLatchesForTest(sessionA);

    const latches1 = _getOrCreateSessionLatchesForTest(sessionA);
    latches1.retention.setOnce("long" as any);

    const latches2 = _getOrCreateSessionLatchesForTest(sessionA);
    expect(latches2.retention.get()).toBe("long");

    _clearSessionLatchesForTest(sessionA);
  });

  it("clearSessionLatches resets all latch values for a session", () => {
    _clearSessionLatchesForTest(sessionA);

    const latches = _getOrCreateSessionLatchesForTest(sessionA);
    latches.betaHeader.setOnce("beta");
    latches.retention.setOnce("long" as any);
    latches.deferLoading.setOnce(true);

    // All latched
    expect(latches.betaHeader.get()).toBe("beta");
    expect(latches.retention.get()).toBe("long");
    expect(latches.deferLoading.get()).toBe(true);

    // Clear
    _clearSessionLatchesForTest(sessionA);

    // After clear, new latches created fresh (old ones are gone)
    const newLatches = _getOrCreateSessionLatchesForTest(sessionA);
    expect(newLatches.betaHeader.get()).toBeNull();
    expect(newLatches.retention.get()).toBeNull();
    expect(newLatches.deferLoading.get()).toBeNull();

    _clearSessionLatchesForTest(sessionA);
  });

  it("latch values persist across multiple getOrCreate calls within same session", () => {
    _clearSessionLatchesForTest(sessionA);

    // Simulate first execute() call
    const latches1 = _getOrCreateSessionLatchesForTest(sessionA);
    latches1.betaHeader.setOnce("context-1m-2025-08-07");
    latches1.retention.setOnce("long" as any);
    latches1.deferLoading.setOnce(true);

    // Simulate second execute() call (same session)
    const latches2 = _getOrCreateSessionLatchesForTest(sessionA);
    // Values should persist
    expect(latches2.betaHeader.get()).toBe("context-1m-2025-08-07");
    expect(latches2.retention.get()).toBe("long");
    expect(latches2.deferLoading.get()).toBe(true);

    // setOnce should return latched values without changing them
    expect(latches2.betaHeader.setOnce("different")).toBe("context-1m-2025-08-07");
    expect(latches2.retention.setOnce("short" as any)).toBe("long");
    expect(latches2.deferLoading.setOnce(false)).toBe(true);

    _clearSessionLatchesForTest(sessionA);
  });
});
