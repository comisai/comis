// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for createSessionTrackerRegistry.
 *
 * Covers the four invariants that make the per-session tracker pool safe:
 *   - stable instance per key (reuse across turns)
 *   - independence across keys (no cross-session leakage)
 *   - size accounting on get/release
 *   - idempotent release (no-op on missing key)
 */

import { describe, it, expect } from "vitest";
import { createSessionTrackerRegistry, type FileStateTrackerLike } from "./session-tracker-registry.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Minimal FileStateTracker stand-in -- implements a small subset of the
 * real `FileStateTracker` contract (recordRead + hasBeenRead) so the tests
 * can verify cross-session isolation without pulling in @comis/skills.
 */
interface TestTracker extends FileStateTrackerLike {
  hasBeenRead(path: string): boolean;
  readonly id: number;
}

function createTestTracker(id: number): TestTracker {
  const reads = new Set<string>();
  return {
    id,
    recordRead(path: string): void {
      reads.add(path);
    },
    hasBeenRead(path: string): boolean {
      return reads.has(path);
    },
  };
}

function makeFactory(): () => TestTracker {
  let counter = 0;
  return () => createTestTracker(++counter);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSessionTrackerRegistry", () => {
  it("Test 1: returns { get, release, size } with function shape", () => {
    const registry = createSessionTrackerRegistry<TestTracker>(makeFactory());
    expect(typeof registry.get).toBe("function");
    expect(typeof registry.release).toBe("function");
    expect(typeof registry.size).toBe("function");
    expect(registry.size()).toBe(0);
  });

  it("Test 2: same sessionKey returns the same tracker instance across calls", () => {
    const registry = createSessionTrackerRegistry<TestTracker>(makeFactory());
    const first = registry.get("sess-a");
    const second = registry.get("sess-a");
    expect(first).toBe(second);
    expect(first.id).toBe(second.id);
  });

  it("Test 3: different sessionKeys return independent trackers; writes do not leak", () => {
    const registry = createSessionTrackerRegistry<TestTracker>(makeFactory());
    const a = registry.get("sess-a");
    const b = registry.get("sess-b");
    expect(a).not.toBe(b);
    expect(a.id).not.toBe(b.id);

    a.recordRead("/path/one", 1000);
    expect(a.hasBeenRead("/path/one")).toBe(true);
    // Critical isolation invariant: B must not see A's recorded reads.
    expect(b.hasBeenRead("/path/one")).toBe(false);
  });

  it("Test 4: size() reflects get/release operations correctly", () => {
    const registry = createSessionTrackerRegistry<TestTracker>(makeFactory());
    expect(registry.size()).toBe(0);

    registry.get("sess-a");
    expect(registry.size()).toBe(1);

    registry.get("sess-b");
    expect(registry.size()).toBe(2);

    // Re-getting an existing key does not grow the registry.
    registry.get("sess-a");
    expect(registry.size()).toBe(2);

    registry.release("sess-a");
    expect(registry.size()).toBe(1);

    registry.release("sess-b");
    expect(registry.size()).toBe(0);
  });

  it("Test 5: release() on unknown key is a no-op (does not throw, does not change size)", () => {
    const registry = createSessionTrackerRegistry<TestTracker>(makeFactory());
    expect(() => registry.release("never-existed")).not.toThrow();
    expect(registry.size()).toBe(0);

    registry.get("sess-a");
    expect(() => registry.release("nonexistent")).not.toThrow();
    expect(registry.size()).toBe(1);
  });

  it("Test 6: after release, re-get returns a FRESH tracker (entry was dropped, state reset)", () => {
    const registry = createSessionTrackerRegistry<TestTracker>(makeFactory());
    const first = registry.get("sess-a");
    first.recordRead("/file", 1000);
    expect(first.hasBeenRead("/file")).toBe(true);

    registry.release("sess-a");
    // After release, a subsequent get must not return the released tracker.
    // The registry merely drops its map entry; new entries come from the factory.
    const second = registry.get("sess-a");
    expect(second).not.toBe(first);
    expect(second.hasBeenRead("/file")).toBe(false);
  });

  it("Test 7: released trackers remain functional for external references (GC-eligible only)", () => {
    const registry = createSessionTrackerRegistry<TestTracker>(makeFactory());
    const tracker = registry.get("sess-a");
    tracker.recordRead("/file", 1000);

    registry.release("sess-a");
    // The registry dropped its entry but the tracker object itself is intact;
    // the caller's reference is still fully functional. This matches the
    // "registry merely drops its map entry" contract in the docstring.
    expect(tracker.hasBeenRead("/file")).toBe(true);
    tracker.recordRead("/file-2", 2000);
    expect(tracker.hasBeenRead("/file-2")).toBe(true);
  });
});
