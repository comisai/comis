import { describe, it, expect } from "vitest";
import {
  createDiscoveryTracker,
  getOrCreateDiscoveryTracker,
  clearDiscoveryTracker,
} from "./discovery-tracker.js";

// ---------------------------------------------------------------------------
// createDiscoveryTracker
// ---------------------------------------------------------------------------

describe("createDiscoveryTracker", () => {
  it("markDiscovered adds names, isDiscovered returns true for those names", () => {
    const tracker = createDiscoveryTracker();
    tracker.markDiscovered(["tool_a", "tool_b"]);

    expect(tracker.isDiscovered("tool_a")).toBe(true);
    expect(tracker.isDiscovered("tool_b")).toBe(true);
    expect(tracker.isDiscovered("tool_c")).toBe(false);
  });

  it("markDiscovered with empty array is a no-op", () => {
    const tracker = createDiscoveryTracker();
    tracker.markDiscovered([]);

    expect(tracker.getDiscoveredNames().size).toBe(0);
  });

  it("markUnavailable removes a name, isDiscovered returns false after removal", () => {
    const tracker = createDiscoveryTracker();
    tracker.markDiscovered(["tool_a", "tool_b"]);
    tracker.markUnavailable("tool_a");

    expect(tracker.isDiscovered("tool_a")).toBe(false);
    expect(tracker.isDiscovered("tool_b")).toBe(true);
  });

  it("markUnavailable for non-existent name is a no-op", () => {
    const tracker = createDiscoveryTracker();
    tracker.markDiscovered(["tool_a"]);
    tracker.markUnavailable("tool_x");

    expect(tracker.isDiscovered("tool_a")).toBe(true);
    expect(tracker.getDiscoveredNames().size).toBe(1);
  });

  it("getDiscoveredNames returns ReadonlySet with correct contents", () => {
    const tracker = createDiscoveryTracker();
    tracker.markDiscovered(["tool_a", "tool_b", "tool_c"]);

    const names = tracker.getDiscoveredNames();
    expect(names.size).toBe(3);
    expect(names.has("tool_a")).toBe(true);
    expect(names.has("tool_b")).toBe(true);
    expect(names.has("tool_c")).toBe(true);
  });

  it("serialize returns sorted array", () => {
    const tracker = createDiscoveryTracker();
    tracker.markDiscovered(["zebra", "alpha", "mango"]);

    expect(tracker.serialize()).toEqual(["alpha", "mango", "zebra"]);
  });

  it("restore adds names additively (does not clear existing)", () => {
    const tracker = createDiscoveryTracker();
    tracker.markDiscovered(["tool_a"]);
    tracker.restore(["tool_b", "tool_c"]);

    expect(tracker.isDiscovered("tool_a")).toBe(true);
    expect(tracker.isDiscovered("tool_b")).toBe(true);
    expect(tracker.isDiscovered("tool_c")).toBe(true);
    expect(tracker.getDiscoveredNames().size).toBe(3);
  });

  it("reset clears all names", () => {
    const tracker = createDiscoveryTracker();
    tracker.markDiscovered(["tool_a", "tool_b"]);
    tracker.reset();

    expect(tracker.isDiscovered("tool_a")).toBe(false);
    expect(tracker.isDiscovered("tool_b")).toBe(false);
    expect(tracker.getDiscoveredNames().size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getOrCreateDiscoveryTracker
// ---------------------------------------------------------------------------

describe("getOrCreateDiscoveryTracker", () => {
  it("returns a new tracker for unknown session key", () => {
    const key = `test-${Date.now()}-new`;
    const tracker = getOrCreateDiscoveryTracker(key, false);

    expect(tracker).toBeDefined();
    expect(tracker.getDiscoveredNames().size).toBe(0);

    // Cleanup
    clearDiscoveryTracker(key);
  });

  it("returns the same tracker for same session key on subsequent calls", () => {
    const key = `test-${Date.now()}-same`;
    const tracker1 = getOrCreateDiscoveryTracker(key, false);
    tracker1.markDiscovered(["tool_a"]);
    const tracker2 = getOrCreateDiscoveryTracker(key, false);

    expect(tracker2).toBe(tracker1);
    expect(tracker2.isDiscovered("tool_a")).toBe(true);

    // Cleanup
    clearDiscoveryTracker(key);
  });

  it("creates fresh tracker when isFirstMessage is true, replacing existing", () => {
    const key = `test-${Date.now()}-first`;
    const tracker1 = getOrCreateDiscoveryTracker(key, false);
    tracker1.markDiscovered(["tool_a"]);
    const tracker2 = getOrCreateDiscoveryTracker(key, true);

    expect(tracker2).not.toBe(tracker1);
    expect(tracker2.isDiscovered("tool_a")).toBe(false);
    expect(tracker2.getDiscoveredNames().size).toBe(0);

    // Cleanup
    clearDiscoveryTracker(key);
  });

  it("different session keys get independent trackers", () => {
    const keyA = `test-${Date.now()}-a`;
    const keyB = `test-${Date.now()}-b`;
    const trackerA = getOrCreateDiscoveryTracker(keyA, false);
    const trackerB = getOrCreateDiscoveryTracker(keyB, false);

    trackerA.markDiscovered(["tool_a"]);

    expect(trackerA.isDiscovered("tool_a")).toBe(true);
    expect(trackerB.isDiscovered("tool_a")).toBe(false);

    // Cleanup
    clearDiscoveryTracker(keyA);
    clearDiscoveryTracker(keyB);
  });
});

// ---------------------------------------------------------------------------
// clearDiscoveryTracker
// ---------------------------------------------------------------------------

describe("clearDiscoveryTracker", () => {
  it("removes tracker for session key", () => {
    const key = `test-${Date.now()}-clear`;
    const tracker1 = getOrCreateDiscoveryTracker(key, false);
    tracker1.markDiscovered(["tool_a"]);

    clearDiscoveryTracker(key);

    // Next call should create a fresh tracker
    const tracker2 = getOrCreateDiscoveryTracker(key, false);
    expect(tracker2).not.toBe(tracker1);
    expect(tracker2.isDiscovered("tool_a")).toBe(false);

    // Cleanup
    clearDiscoveryTracker(key);
  });

  it("subsequent getOrCreateDiscoveryTracker creates fresh tracker", () => {
    const key = `test-${Date.now()}-fresh`;
    const tracker1 = getOrCreateDiscoveryTracker(key, false);
    tracker1.markDiscovered(["tool_a", "tool_b"]);

    clearDiscoveryTracker(key);

    const tracker2 = getOrCreateDiscoveryTracker(key, false);
    expect(tracker2.getDiscoveredNames().size).toBe(0);
    expect(tracker2.serialize()).toEqual([]);

    // Cleanup
    clearDiscoveryTracker(key);
  });

  it("clearing non-existent key is a no-op", () => {
    // Should not throw
    clearDiscoveryTracker("non-existent-key-12345");
  });
});

// ---------------------------------------------------------------------------
// lifecycle demotion clears discovery state
// ---------------------------------------------------------------------------

describe("lifecycle demotion clears discovery state", () => {
  it("markUnavailable removes tool from discovered set, requiring re-discovery", () => {
    const tracker = createDiscoveryTracker();
    tracker.markDiscovered(["mcp:srv/tool_a", "bash"]);

    // Simulate lifecycle demotion: tool becomes unavailable
    tracker.markUnavailable("mcp:srv/tool_a");

    // Demoted tool must be re-discovered
    expect(tracker.isDiscovered("mcp:srv/tool_a")).toBe(false);

    // Other tools unaffected
    expect(tracker.isDiscovered("bash")).toBe(true);
  });

  it("demoted tool can be re-discovered after markUnavailable", () => {
    const tracker = createDiscoveryTracker();
    tracker.markDiscovered(["mcp:srv/tool_a"]);
    tracker.markUnavailable("mcp:srv/tool_a");

    expect(tracker.isDiscovered("mcp:srv/tool_a")).toBe(false);

    // Re-discover the tool
    tracker.markDiscovered(["mcp:srv/tool_a"]);
    expect(tracker.isDiscovered("mcp:srv/tool_a")).toBe(true);
  });
});
