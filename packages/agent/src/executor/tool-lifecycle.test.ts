import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ToolLifecycleTracker,
  getOrCreateTracker,
  clearSessionTracker,
  resetTrackerTimers,
} from "./tool-lifecycle.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Advance a tracker by N turns with no tool usage on each turn.
 */
function advanceTurns(tracker: ToolLifecycleTracker, turns: number): void {
  for (let i = 0; i < turns; i++) {
    tracker.recordTurn(new Set());
  }
}

// ---------------------------------------------------------------------------
// ToolLifecycleTracker
// ---------------------------------------------------------------------------

describe("ToolLifecycleTracker", () => {
  let tracker: ToolLifecycleTracker;

  beforeEach(() => {
    tracker = new ToolLifecycleTracker();
  });

  it("increments turn counter on each recordTurn call", () => {
    expect(tracker.getCurrentTurn()).toBe(0);
    tracker.recordTurn(new Set(["read"]));
    expect(tracker.getCurrentTurn()).toBe(1);
    tracker.recordTurn(new Set(["write"]));
    expect(tracker.getCurrentTurn()).toBe(2);
    tracker.recordTurn(new Set());
    expect(tracker.getCurrentTurn()).toBe(3);
  });

  it("records tool usage on correct turn", () => {
    // Turn 1: use "read" and "write"
    tracker.recordTurn(new Set(["read", "write"]));
    // Turn 2: use "exec"
    tracker.recordTurn(new Set(["exec"]));

    // With threshold 1: "read" and "write" were last used on turn 1,
    // current turn is 2, so 2 - 1 = 1 >= 1 -> demoted
    // "exec" was used on turn 2, so 2 - 2 = 0 < 1 -> not demoted
    const demoted = tracker.getDemotedToolNames(
      ["read", "write", "exec"],
      1,
      new Set(),
    );
    expect(demoted).toContain("read");
    expect(demoted).toContain("write");
    expect(demoted).not.toContain("exec");
  });

  it("never demotes exempt tools", () => {
    // Advance 25 turns with no usage
    advanceTurns(tracker, 25);

    // "read" and "write" are exempt
    const demoted = tracker.getDemotedToolNames(
      ["read", "write", "special_tool"],
      20,
      new Set(["read", "write"]),
    );
    expect(demoted).not.toContain("read");
    expect(demoted).not.toContain("write");
    expect(demoted).toContain("special_tool");
  });

  it("never demotes discover_tools regardless of exemptTools", () => {
    // Advance 25 turns with no usage
    advanceTurns(tracker, 25);

    // Empty exemptTools -- discover_tools still exempt by name check
    const demoted = tracker.getDemotedToolNames(
      ["discover_tools", "some_tool"],
      20,
      new Set(),
    );
    expect(demoted).not.toContain("discover_tools");
    expect(demoted).toContain("some_tool");
  });

  it("tools not yet seen default to turn 0", () => {
    // Advance to turn 21
    advanceTurns(tracker, 21);

    // "never_seen" was never recorded, defaults to turn 0
    // 21 - 0 = 21 >= 20 -> demoted
    const demoted = tracker.getDemotedToolNames(
      ["never_seen"],
      20,
      new Set(),
    );
    expect(demoted).toContain("never_seen");
  });

  it("resetTimers sets all tools' last-used to current turn", () => {
    // Use tools on turn 1
    tracker.recordTurn(new Set(["toolA", "toolB"]));

    // Advance to turn 19 (no usage)
    advanceTurns(tracker, 18);
    expect(tracker.getCurrentTurn()).toBe(19);

    // Reset timers: last-used for toolA and toolB set to turn 19
    tracker.resetTimers();

    // Advance one more turn to turn 20
    advanceTurns(tracker, 1);
    expect(tracker.getCurrentTurn()).toBe(20);

    // 20 - 19 = 1 < 20 -> NOT demoted
    const demoted = tracker.getDemotedToolNames(
      ["toolA", "toolB"],
      20,
      new Set(),
    );
    expect(demoted.size).toBe(0);
  });

  it("reset clears all state", () => {
    // Use tools and advance
    tracker.recordTurn(new Set(["toolA"]));
    advanceTurns(tracker, 4);
    expect(tracker.getCurrentTurn()).toBe(5);

    // Full reset
    tracker.reset();
    expect(tracker.getCurrentTurn()).toBe(0);

    // With threshold 1 and turn at 0, nothing should be demoted
    // (0 - 0 = 0 < 1)
    const demoted = tracker.getDemotedToolNames(
      ["toolA"],
      1,
      new Set(),
    );
    expect(demoted.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Session tracker storage
// ---------------------------------------------------------------------------

describe("session tracker storage", () => {
  const testKey = "test:session:key";

  beforeEach(() => {
    // Clean up any state from previous tests
    clearSessionTracker(testKey);
    clearSessionTracker("other:key");
  });

  it("getOrCreateTracker returns same instance for same key", () => {
    const tracker1 = getOrCreateTracker(testKey, false);
    const tracker2 = getOrCreateTracker(testKey, false);
    expect(tracker1).toBe(tracker2);
  });

  it("getOrCreateTracker creates fresh tracker on isFirstMessage=true", () => {
    const tracker1 = getOrCreateTracker(testKey, false);
    // Advance it to verify it has state
    tracker1.recordTurn(new Set(["tool"]));
    expect(tracker1.getCurrentTurn()).toBe(1);

    // isFirstMessage creates a fresh tracker
    const tracker2 = getOrCreateTracker(testKey, true);
    expect(tracker2).not.toBe(tracker1);
    expect(tracker2.getCurrentTurn()).toBe(0);
  });

  it("clearSessionTracker removes tracker", () => {
    const tracker1 = getOrCreateTracker(testKey, false);
    tracker1.recordTurn(new Set(["tool"]));

    clearSessionTracker(testKey);

    // Getting tracker again returns a fresh instance
    const tracker2 = getOrCreateTracker(testKey, false);
    expect(tracker2).not.toBe(tracker1);
    expect(tracker2.getCurrentTurn()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// resetTrackerTimers
// ---------------------------------------------------------------------------

describe("resetTrackerTimers", () => {
  const testKey = "reset:test:key";

  beforeEach(() => {
    clearSessionTracker(testKey);
    clearSessionTracker("nonexistent:key");
  });

  it("returns true and resets when tracker exists", () => {
    const tracker = getOrCreateTracker(testKey, false);
    // Use tool on turn 1
    tracker.recordTurn(new Set(["toolA"]));
    // Advance to turn 10
    advanceTurns(tracker, 9);
    expect(tracker.getCurrentTurn()).toBe(10);

    const result = resetTrackerTimers(testKey);
    expect(result).toBe(true);

    // After reset, toolA's last-used is set to turn 10
    // So even at turn 29 (10 + 19 turns), toolA should not be demoted (29 - 10 = 19 < 20)
    advanceTurns(tracker, 19);
    expect(tracker.getCurrentTurn()).toBe(29);
    const demoted = tracker.getDemotedToolNames(["toolA"], 20, new Set());
    expect(demoted.size).toBe(0);
  });

  it("returns false when no tracker exists", () => {
    const result = resetTrackerTimers("nonexistent:key");
    expect(result).toBe(false);

    // Verify no stale entry was created -- getOrCreateTracker should return a fresh tracker
    const tracker = getOrCreateTracker("nonexistent:key", false);
    expect(tracker.getCurrentTurn()).toBe(0);
  });
});
