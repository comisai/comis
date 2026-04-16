import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getOrCreateDiscoveryTracker,
  clearDiscoveryTracker,
  cleanupServerFromAllTrackers,
  cleanupToolsFromAllTrackers,
} from "./discovery-tracker.js";
import { wireMcpDisconnectCleanup } from "./mcp-disconnect-cleanup.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Unique session key per test to avoid cross-test pollution. */
let testCounter = 0;
function uniqueKey(label: string): string {
  return `mcp-cleanup-test-${++testCounter}-${label}`;
}

// ---------------------------------------------------------------------------
// cleanupServerFromAllTrackers
// ---------------------------------------------------------------------------

describe("cleanupServerFromAllTrackers", () => {
  const keyA = `cleanup-server-a-${Date.now()}`;
  const keyB = `cleanup-server-b-${Date.now()}`;

  beforeEach(() => {
    clearDiscoveryTracker(keyA);
    clearDiscoveryTracker(keyB);
  });

  it("removes matching mcp:serverName/* entries from all session trackers", () => {
    const trackerA = getOrCreateDiscoveryTracker(keyA, true);
    const trackerB = getOrCreateDiscoveryTracker(keyB, true);

    trackerA.markDiscovered([
      "mcp:ctx7/tool_a",
      "mcp:ctx7/tool_b",
      "mcp:other/tool_c",
      "bash",
    ]);
    trackerB.markDiscovered([
      "mcp:ctx7/tool_a",
      "mcp:ctx7/tool_b",
      "mcp:other/tool_c",
      "bash",
    ]);

    const removed = cleanupServerFromAllTrackers("ctx7");

    // 2 tools x 2 trackers = 4
    expect(removed).toBe(4);

    // ctx7 tools gone from both
    expect(trackerA.isDiscovered("mcp:ctx7/tool_a")).toBe(false);
    expect(trackerA.isDiscovered("mcp:ctx7/tool_b")).toBe(false);
    expect(trackerB.isDiscovered("mcp:ctx7/tool_a")).toBe(false);
    expect(trackerB.isDiscovered("mcp:ctx7/tool_b")).toBe(false);

    // Other tools still present
    expect(trackerA.isDiscovered("mcp:other/tool_c")).toBe(true);
    expect(trackerA.isDiscovered("bash")).toBe(true);
    expect(trackerB.isDiscovered("mcp:other/tool_c")).toBe(true);
    expect(trackerB.isDiscovered("bash")).toBe(true);
  });

  it("returns 0 when no matching entries exist", () => {
    const tracker = getOrCreateDiscoveryTracker(keyA, true);
    tracker.markDiscovered(["mcp:other/tool_c", "bash"]);

    const removed = cleanupServerFromAllTrackers("nonexistent");
    expect(removed).toBe(0);
  });

  it("handles empty session trackers gracefully", () => {
    // Force fresh keys with no trackers populated
    clearDiscoveryTracker(keyA);
    clearDiscoveryTracker(keyB);

    // Call with no active trackers for these keys -- should not error
    const removed = cleanupServerFromAllTrackers("empty");
    expect(removed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// cleanupToolsFromAllTrackers
// ---------------------------------------------------------------------------

describe("cleanupToolsFromAllTrackers", () => {
  const keyA = `cleanup-tools-a-${Date.now()}`;
  const keyB = `cleanup-tools-b-${Date.now()}`;

  beforeEach(() => {
    clearDiscoveryTracker(keyA);
    clearDiscoveryTracker(keyB);
  });

  it("removes specific qualified tool names from all trackers", () => {
    const trackerA = getOrCreateDiscoveryTracker(keyA, true);
    const trackerB = getOrCreateDiscoveryTracker(keyB, true);

    trackerA.markDiscovered([
      "mcp:ctx7/tool_a",
      "mcp:ctx7/tool_b",
      "mcp:ctx7/tool_c",
    ]);
    trackerB.markDiscovered([
      "mcp:ctx7/tool_a",
      "mcp:ctx7/tool_b",
      "mcp:ctx7/tool_c",
    ]);

    const removed = cleanupToolsFromAllTrackers([
      "mcp:ctx7/tool_a",
      "mcp:ctx7/tool_b",
    ]);

    // 2 tools x 2 trackers = 4
    expect(removed).toBe(4);

    // Specified tools removed from both
    expect(trackerA.isDiscovered("mcp:ctx7/tool_a")).toBe(false);
    expect(trackerA.isDiscovered("mcp:ctx7/tool_b")).toBe(false);
    expect(trackerB.isDiscovered("mcp:ctx7/tool_a")).toBe(false);
    expect(trackerB.isDiscovered("mcp:ctx7/tool_b")).toBe(false);

    // Unspecified tool still present
    expect(trackerA.isDiscovered("mcp:ctx7/tool_c")).toBe(true);
    expect(trackerB.isDiscovered("mcp:ctx7/tool_c")).toBe(true);
  });

  it("returns 0 for non-existent tool names", () => {
    const tracker = getOrCreateDiscoveryTracker(keyA, true);
    tracker.markDiscovered(["mcp:srv/alpha"]);

    const removed = cleanupToolsFromAllTrackers([
      "mcp:srv/nonexistent",
      "mcp:other/missing",
    ]);
    expect(removed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// wireMcpDisconnectCleanup
// ---------------------------------------------------------------------------

describe("wireMcpDisconnectCleanup", () => {
  it("subscribes to mcp:server:disconnected and mcp:server:tools_changed", () => {
    const onSpy = vi.fn();
    const eventBus = { on: onSpy };

    wireMcpDisconnectCleanup(eventBus);

    expect(onSpy).toHaveBeenCalledTimes(2);
    expect(onSpy).toHaveBeenCalledWith(
      "mcp:server:disconnected",
      expect.any(Function),
    );
    expect(onSpy).toHaveBeenCalledWith(
      "mcp:server:tools_changed",
      expect.any(Function),
    );
  });

  it("on disconnected, cleans matching tools from all trackers", () => {
    const key = uniqueKey("disconnect");
    const tracker = getOrCreateDiscoveryTracker(key, true);
    tracker.markDiscovered(["mcp:testserver/tool_a", "mcp:testserver/tool_b", "bash"]);

    // Capture handlers
    const handlers: Record<string, Function> = {};
    const eventBus = {
      on: (event: string, handler: Function) => {
        handlers[event] = handler;
      },
    };

    wireMcpDisconnectCleanup(eventBus);

    // Fire disconnected event
    handlers["mcp:server:disconnected"]!({
      serverName: "testserver",
      reason: "transport_closed",
      timestamp: Date.now(),
    });

    expect(tracker.isDiscovered("mcp:testserver/tool_a")).toBe(false);
    expect(tracker.isDiscovered("mcp:testserver/tool_b")).toBe(false);
    expect(tracker.isDiscovered("bash")).toBe(true);

    clearDiscoveryTracker(key);
  });

  it("on tools_changed with removedTools, cleans qualified names from all trackers", () => {
    const key = uniqueKey("tools-changed");
    const tracker = getOrCreateDiscoveryTracker(key, true);
    tracker.markDiscovered(["mcp:srv/alpha", "mcp:srv/beta"]);

    // Capture handlers
    const handlers: Record<string, Function> = {};
    const eventBus = {
      on: (event: string, handler: Function) => {
        handlers[event] = handler;
      },
    };

    wireMcpDisconnectCleanup(eventBus);

    // Fire tools_changed event with one tool removed
    handlers["mcp:server:tools_changed"]!({
      serverName: "srv",
      removedTools: ["alpha"],
      addedTools: [],
      previousToolCount: 2,
      currentToolCount: 1,
    });

    expect(tracker.isDiscovered("mcp:srv/alpha")).toBe(false);
    expect(tracker.isDiscovered("mcp:srv/beta")).toBe(true);

    clearDiscoveryTracker(key);
  });

  it("on tools_changed with empty removedTools, does nothing", () => {
    const key = uniqueKey("empty-removed");
    const tracker = getOrCreateDiscoveryTracker(key, true);
    tracker.markDiscovered(["mcp:srv/alpha"]);

    const handlers: Record<string, Function> = {};
    const eventBus = {
      on: (event: string, handler: Function) => {
        handlers[event] = handler;
      },
    };

    wireMcpDisconnectCleanup(eventBus);

    handlers["mcp:server:tools_changed"]!({
      serverName: "srv",
      removedTools: [],
      addedTools: ["gamma"],
      previousToolCount: 1,
      currentToolCount: 2,
    });

    // Nothing removed
    expect(tracker.isDiscovered("mcp:srv/alpha")).toBe(true);

    clearDiscoveryTracker(key);
  });
});
