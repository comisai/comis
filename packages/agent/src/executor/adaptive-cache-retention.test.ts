import { describe, it, expect, vi } from "vitest";
import { createAdaptiveCacheRetention, createStaticRetention, FAST_PATH_CACHE_WRITE_THRESHOLD, PREFIX_INSTABILITY_THRESHOLD } from "./adaptive-cache-retention.js";
import type { AdaptiveCacheRetentionConfig } from "./adaptive-cache-retention.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createDefaultConfig(overrides?: Partial<AdaptiveCacheRetentionConfig>): AdaptiveCacheRetentionConfig {
  return {
    coldStartRetention: "short",
    warmRetention: "long",
    escalationThreshold: 1000,
    escalationMode: "tokens",  // Existing tests use token-based escalation
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createAdaptiveCacheRetention", () => {
  it("starts with coldStartRetention ('short')", () => {
    const retention = createAdaptiveCacheRetention(createDefaultConfig());

    expect(retention.getRetention()).toBe("short");
  });

  it("does not escalate below threshold (999 tokens with threshold 1000)", () => {
    const retention = createAdaptiveCacheRetention(createDefaultConfig());

    retention.recordCacheReads(999);

    expect(retention.getRetention()).toBe("short");
  });

  it("escalates exactly at threshold (1000 tokens with threshold 1000)", () => {
    const retention = createAdaptiveCacheRetention(createDefaultConfig());

    retention.recordCacheReads(1000);

    expect(retention.getRetention()).toBe("long");
  });

  it("escalates on cumulative reads across multiple calls (500 + 500 = 1000)", () => {
    const retention = createAdaptiveCacheRetention(createDefaultConfig());

    retention.recordCacheReads(500);
    expect(retention.getRetention()).toBe("short");

    retention.recordCacheReads(500);
    expect(retention.getRetention()).toBe("long");
  });

  it("once escalated, stays at warmRetention even if no further reads", () => {
    const retention = createAdaptiveCacheRetention(createDefaultConfig());

    retention.recordCacheReads(2000);
    expect(retention.getRetention()).toBe("long");

    // No further reads -- should remain "long"
    expect(retention.getRetention()).toBe("long");
    expect(retention.getRetention()).toBe("long");
  });

  it("getMessageRetention() returns 'short' before escalation", () => {
    const retention = createAdaptiveCacheRetention(createDefaultConfig());

    // Before escalation -- message retention tracks coldStartRetention
    expect(retention.getMessageRetention()).toBe("short");
  });

  it("getMessageRetention() returns 'long' after escalation (turn-based)", () => {
    const retention = createAdaptiveCacheRetention(createDefaultConfig());

    // Before escalation
    expect(retention.getMessageRetention()).toBe("short");

    // Escalate via cache reads
    retention.recordCacheReads(5000);
    expect(retention.getRetention()).toBe("long");

    // After escalation -- message retention tracks warm retention
    expect(retention.getMessageRetention()).toBe("long");
  });

  it("getMessageRetention() returns 'short' after reset", () => {
    const retention = createAdaptiveCacheRetention(createDefaultConfig());

    // Escalate
    retention.recordCacheReads(5000);
    expect(retention.getMessageRetention()).toBe("long");

    // Reset restores cold-start behavior
    retention.reset();
    expect(retention.getMessageRetention()).toBe("short");
  });

  it("recordCacheReads(0) does not escalate", () => {
    const retention = createAdaptiveCacheRetention(createDefaultConfig());

    retention.recordCacheReads(0);
    retention.recordCacheReads(0);
    retention.recordCacheReads(0);

    expect(retention.getRetention()).toBe("short");
  });

  it("respects custom escalation threshold", () => {
    const retention = createAdaptiveCacheRetention(createDefaultConfig({
      escalationThreshold: 5000,
    }));

    retention.recordCacheReads(4999);
    expect(retention.getRetention()).toBe("short");

    retention.recordCacheReads(1);
    expect(retention.getRetention()).toBe("long");
  });

  it("escalates above threshold with large single read", () => {
    const retention = createAdaptiveCacheRetention(createDefaultConfig());

    retention.recordCacheReads(50000);

    expect(retention.getRetention()).toBe("long");
  });

  it("hasEscalated() returns false before threshold", () => {
    const retention = createAdaptiveCacheRetention(createDefaultConfig());

    retention.recordCacheReads(500);

    expect(retention.hasEscalated()).toBe(false);
  });

  it("hasEscalated() returns true after threshold", () => {
    const retention = createAdaptiveCacheRetention(createDefaultConfig());

    retention.recordCacheReads(1000);

    expect(retention.hasEscalated()).toBe(true);
  });

  it("hasEscalated() remains true once set (one-way)", () => {
    const retention = createAdaptiveCacheRetention(createDefaultConfig());

    retention.recordCacheReads(2000);
    expect(retention.hasEscalated()).toBe(true);

    // No further reads -- should remain true
    expect(retention.hasEscalated()).toBe(true);
    expect(retention.hasEscalated()).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // onEscalated callback tests
  // ---------------------------------------------------------------------------

  it("calls onEscalated callback when retention escalates", () => {
    const onEscalated = vi.fn();
    const retention = createAdaptiveCacheRetention(createDefaultConfig({
      onEscalated,
    }));

    retention.recordCacheReads(1000);

    expect(onEscalated).toHaveBeenCalledOnce();
    expect(retention.hasEscalated()).toBe(true);
  });

  it("does not call onEscalated below threshold", () => {
    const onEscalated = vi.fn();
    const retention = createAdaptiveCacheRetention(createDefaultConfig({
      onEscalated,
    }));

    retention.recordCacheReads(999);

    expect(onEscalated).not.toHaveBeenCalled();
    expect(retention.hasEscalated()).toBe(false);
  });

  it("onEscalated called only once even with multiple reads past threshold", () => {
    const onEscalated = vi.fn();
    const retention = createAdaptiveCacheRetention(createDefaultConfig({
      onEscalated,
    }));

    retention.recordCacheReads(500);
    retention.recordCacheReads(500);  // Crosses threshold
    retention.recordCacheReads(500);  // Well past

    expect(onEscalated).toHaveBeenCalledOnce();
  });

  it("works without onEscalated callback (backward compat)", () => {
    // Omit onEscalated entirely -- explicitly use token mode
    const retention = createAdaptiveCacheRetention({
      coldStartRetention: "short",
      warmRetention: "long",
      escalationThreshold: 1000,
      escalationMode: "tokens",
    });

    retention.recordCacheReads(2000);

    expect(retention.hasEscalated()).toBe(true);
    expect(retention.getRetention()).toBe("long");
  });

  it("warm session starts with configRetention as coldStart", () => {
    // Simulates warm session: coldStartRetention is already "long"
    const retention = createAdaptiveCacheRetention(createDefaultConfig({
      coldStartRetention: "long",
      warmRetention: "long",
    }));

    // Immediately returns "long" -- no escalation needed
    expect(retention.getRetention()).toBe("long");

    retention.recordCacheReads(0);
    expect(retention.getRetention()).toBe("long");
  });

  // ---------------------------------------------------------------------------
  // reset() — cold-start restoration
  // ---------------------------------------------------------------------------

  describe("reset()", () => {
    it("after escalation, reset() restores coldStartRetention ('short')", () => {
      const retention = createAdaptiveCacheRetention(createDefaultConfig());

      // Escalate
      retention.recordCacheReads(2000);
      expect(retention.getRetention()).toBe("long");

      // Reset
      retention.reset();

      expect(retention.getRetention()).toBe("short");
    });

    it("after reset(), hasEscalated() returns false", () => {
      const retention = createAdaptiveCacheRetention(createDefaultConfig());

      retention.recordCacheReads(2000);
      expect(retention.hasEscalated()).toBe(true);

      retention.reset();

      expect(retention.hasEscalated()).toBe(false);
    });

    it("after reset(), recordCacheReads can re-escalate to warmRetention", () => {
      const retention = createAdaptiveCacheRetention(createDefaultConfig());

      // Escalate
      retention.recordCacheReads(2000);
      expect(retention.getRetention()).toBe("long");

      // Reset
      retention.reset();
      expect(retention.getRetention()).toBe("short");

      // Re-escalate
      retention.recordCacheReads(1000);
      expect(retention.getRetention()).toBe("long");
      expect(retention.hasEscalated()).toBe(true);
    });

    it("after reset(), onEscalated callback fires again on next escalation", () => {
      const onEscalated = vi.fn();
      const retention = createAdaptiveCacheRetention(createDefaultConfig({
        onEscalated,
      }));

      // First escalation
      retention.recordCacheReads(1000);
      expect(onEscalated).toHaveBeenCalledTimes(1);

      // Reset
      retention.reset();

      // Second escalation -- callback should fire again
      retention.recordCacheReads(1000);
      expect(onEscalated).toHaveBeenCalledTimes(2);
    });

    it("reset() before any escalation is a no-op (still returns coldStartRetention)", () => {
      const retention = createAdaptiveCacheRetention(createDefaultConfig());

      // No escalation yet
      expect(retention.getRetention()).toBe("short");
      expect(retention.hasEscalated()).toBe(false);

      // Reset is a no-op
      retention.reset();

      expect(retention.getRetention()).toBe("short");
      expect(retention.hasEscalated()).toBe(false);
    });

    it("after reset(), totalCacheReads is 0 (999 tokens does not escalate with threshold 1000)", () => {
      const retention = createAdaptiveCacheRetention(createDefaultConfig());

      // Escalate
      retention.recordCacheReads(5000);
      expect(retention.getRetention()).toBe("long");

      // Reset
      retention.reset();

      // Record 999 tokens -- should NOT escalate (threshold is 1000)
      retention.recordCacheReads(999);
      expect(retention.getRetention()).toBe("short");
      expect(retention.hasEscalated()).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// createStaticRetention
// ---------------------------------------------------------------------------

describe("createStaticRetention", () => {
  it("getRetention() returns the fixed retention value ('short')", () => {
    const retention = createStaticRetention("short");

    expect(retention.getRetention()).toBe("short");
  });

  it("getRetention() returns the fixed retention value ('long')", () => {
    const retention = createStaticRetention("long");

    expect(retention.getRetention()).toBe("long");
  });

  it("recordCacheReads() is a no-op -- getRetention() still returns fixed value", () => {
    const retention = createStaticRetention("short");

    retention.recordCacheReads(5000);

    expect(retention.getRetention()).toBe("short");
  });

  it("getMessageRetention() returns 'short' when retention is 'short'", () => {
    const retention = createStaticRetention("short");

    expect(retention.getMessageRetention()).toBe("short");
  });

  it("getMessageRetention() returns 'long' when retention is 'long'", () => {
    const retention = createStaticRetention("long");

    expect(retention.getMessageRetention()).toBe("long");
  });

  it("hasEscalated() always returns false", () => {
    const retention = createStaticRetention("short");

    retention.recordCacheReads(999999);

    expect(retention.hasEscalated()).toBe(false);
  });

  it("reset() is a no-op -- getRetention() still returns fixed value", () => {
    const retention = createStaticRetention("short");

    retention.reset();

    expect(retention.getRetention()).toBe("short");
  });

  it("recordTurn() is a no-op -- no escalation regardless of turns", () => {
    const retention = createStaticRetention("long");

    retention.recordTurn();
    retention.recordTurn();
    retention.recordTurn();
    retention.recordTurn();

    expect(retention.getRetention()).toBe("long");
    expect(retention.hasEscalated()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Turn-count-based escalation mode (design 2.4)
// ---------------------------------------------------------------------------

describe("createAdaptiveCacheRetention with turn-based escalation", () => {
  it("does NOT escalate after 1 turn with 50K cache reads (default mode)", () => {
    const retention = createAdaptiveCacheRetention({
      coldStartRetention: "short",
      warmRetention: "long",
      escalationThreshold: 1000,
    });

    retention.recordTurn();
    retention.recordCacheReads(50_000);

    expect(retention.getRetention()).toBe("short");
    expect(retention.hasEscalated()).toBe(false);
  });

  it("does NOT escalate after 2 turns with cache reads", () => {
    const retention = createAdaptiveCacheRetention({
      coldStartRetention: "short",
      warmRetention: "long",
      escalationThreshold: 1000,
    });

    retention.recordTurn();
    retention.recordCacheReads(50_000);
    retention.recordTurn();
    retention.recordCacheReads(50_000);

    expect(retention.getRetention()).toBe("short");
    expect(retention.hasEscalated()).toBe(false);
  });

  it("escalates after 3 turns with cache reads (meets default threshold)", () => {
    const retention = createAdaptiveCacheRetention({
      coldStartRetention: "short",
      warmRetention: "long",
      escalationThreshold: 1000,
    });

    retention.recordTurn();
    retention.recordCacheReads(10_000);
    retention.recordTurn();
    retention.recordCacheReads(10_000);
    retention.recordTurn();
    retention.recordCacheReads(10_000);

    expect(retention.getRetention()).toBe("long");
    expect(retention.hasEscalated()).toBe(true);
  });

  it("does NOT escalate after 3 turns with zero cache reads", () => {
    const retention = createAdaptiveCacheRetention({
      coldStartRetention: "short",
      warmRetention: "long",
      escalationThreshold: 1000,
    });

    retention.recordTurn();
    retention.recordTurn();
    retention.recordTurn();

    expect(retention.getRetention()).toBe("short");
    expect(retention.hasEscalated()).toBe(false);
  });

  it("respects custom escalationTurnThreshold", () => {
    const retention = createAdaptiveCacheRetention({
      coldStartRetention: "short",
      warmRetention: "long",
      escalationThreshold: 1000,
      escalationTurnThreshold: 5,
    });

    // 4 turns with cache reads -- should NOT escalate
    for (let i = 0; i < 4; i++) {
      retention.recordTurn();
      retention.recordCacheReads(10_000);
    }
    expect(retention.getRetention()).toBe("short");

    // 5th turn -- should escalate
    retention.recordTurn();
    retention.recordCacheReads(10_000);
    expect(retention.getRetention()).toBe("long");
  });

  it("token-mode escalation works when explicitly set", () => {
    const retention = createAdaptiveCacheRetention({
      coldStartRetention: "short",
      warmRetention: "long",
      escalationThreshold: 1000,
      escalationMode: "tokens",
    });

    // Single turn with enough tokens should escalate in token mode
    retention.recordCacheReads(1000);

    expect(retention.getRetention()).toBe("long");
    expect(retention.hasEscalated()).toBe(true);
  });

  it("non-graph subagents with static 'short' do not escalate", () => {
    // Non-graph subagents use createStaticRetention("short")
    const retention = createStaticRetention("short");

    retention.recordTurn();
    retention.recordTurn();
    retention.recordTurn();
    retention.recordCacheReads(50_000);

    expect(retention.getRetention()).toBe("short");
    expect(retention.hasEscalated()).toBe(false);
  });

  it("graph subagents with static 'long' do not escalate", () => {
    // Graph subagents use createStaticRetention("long") -- always "long", never escalates
    const retention = createStaticRetention("long");

    retention.recordTurn();
    retention.recordTurn();
    retention.recordTurn();
    retention.recordCacheReads(50_000);

    expect(retention.getRetention()).toBe("long");
    expect(retention.hasEscalated()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fast-path escalation via recordTurnWithCacheWrite
// ---------------------------------------------------------------------------

describe("Fast-path escalation", () => {
  it("fast-path: escalates on turn 2 when first turn wrote >20K tokens and cache reads > 0", () => {
    const onEscalated = vi.fn();
    const retention = createAdaptiveCacheRetention(createDefaultConfig({
      escalationMode: "turns",
      onEscalated,
    }));

    // Turn 1: large system prompt write (>FAST_PATH_CACHE_WRITE_THRESHOLD)
    retention.recordTurnWithCacheWrite(25_000);
    expect(retention.hasEscalated()).toBe(false);

    // Turn 2: cache reads confirm content is being reused, then turn completes
    retention.recordCacheReads(100);
    retention.recordTurnWithCacheWrite(5_000);
    expect(retention.hasEscalated()).toBe(true);
    expect(retention.getRetention()).toBe("long");
    expect(onEscalated).toHaveBeenCalledOnce();
  });

  it("no fast-path: first turn wrote <20K tokens -- standard 3-turn threshold applies", () => {
    const onEscalated = vi.fn();
    const retention = createAdaptiveCacheRetention(createDefaultConfig({
      escalationMode: "turns",
      onEscalated,
    }));

    // Turn 1: small cache write (<FAST_PATH_CACHE_WRITE_THRESHOLD)
    retention.recordTurnWithCacheWrite(15_000);
    expect(retention.hasEscalated()).toBe(false);

    // Turn 2: cache reads + turn end
    retention.recordCacheReads(100);
    retention.recordTurnWithCacheWrite(5_000);
    expect(retention.hasEscalated()).toBe(false);
    expect(onEscalated).not.toHaveBeenCalled();
  });

  it("fast-path requires totalCacheReads > 0 -- zero cache reads on turn 2 does not escalate", () => {
    const retention = createAdaptiveCacheRetention(createDefaultConfig({
      escalationMode: "turns",
    }));

    // Turn 1: large write but no cache reads recorded anywhere
    retention.recordTurnWithCacheWrite(25_000);

    // Turn 2: still no cache reads -- fast-path guard prevents escalation
    retention.recordTurnWithCacheWrite(5_000);
    expect(retention.hasEscalated()).toBe(false);
  });

  it("recordTurnWithCacheWrite increments turnCount -- standard escalation triggers at 3 turns", () => {
    const onEscalated = vi.fn();
    const retention = createAdaptiveCacheRetention(createDefaultConfig({
      escalationMode: "turns",
      onEscalated,
    }));

    // 3 turns with small writes and cache reads -- standard threshold
    retention.recordCacheReads(100);
    retention.recordTurnWithCacheWrite(5_000);
    expect(retention.hasEscalated()).toBe(false);

    retention.recordCacheReads(100);
    retention.recordTurnWithCacheWrite(5_000);
    expect(retention.hasEscalated()).toBe(false);

    retention.recordCacheReads(100);
    retention.recordTurnWithCacheWrite(5_000);
    expect(retention.hasEscalated()).toBe(true);
    expect(onEscalated).toHaveBeenCalledOnce();
  });

  it("reset() clears fast-path state (lastCacheWriteTokens resets to 0)", () => {
    const retention = createAdaptiveCacheRetention(createDefaultConfig({
      escalationMode: "turns",
    }));

    // Turn 1: large write
    retention.recordTurnWithCacheWrite(25_000);
    retention.recordCacheReads(100);

    // Reset before turn 2 -- fast-path state should be cleared
    retention.reset();

    // Turn 2: the previous large write should no longer trigger fast-path
    retention.recordCacheReads(100);
    retention.recordTurnWithCacheWrite(5_000);
    expect(retention.hasEscalated()).toBe(false);
  });

  it("createStaticRetention has recordTurnWithCacheWrite as a no-op", () => {
    const retention = createStaticRetention("short");

    retention.recordTurnWithCacheWrite(50_000);
    retention.recordTurnWithCacheWrite(50_000);

    expect(retention.getRetention()).toBe("short");
    expect(retention.hasEscalated()).toBe(false);
  });

  it("FAST_PATH_CACHE_WRITE_THRESHOLD is exported and equals 20_000", () => {
    expect(FAST_PATH_CACHE_WRITE_THRESHOLD).toBe(20_000);
  });
});

// ---------------------------------------------------------------------------
// Cost-aware TTL gating
// ---------------------------------------------------------------------------

describe("cost-aware TTL gating", () => {
  it("costGateOpen=false requires turnThreshold+2 turns to escalate (default: 3+2=5 turns)", () => {
    const retention = createAdaptiveCacheRetention({
      coldStartRetention: "short",
      warmRetention: "long",
      escalationThreshold: 1000,
      // default escalationMode = "turns", escalationTurnThreshold = 3
    });

    retention.setCostGateOpen(false);

    // Turns 1-4: should NOT escalate (need 3+2=5)
    for (let i = 0; i < 4; i++) {
      retention.recordTurn();
      retention.recordCacheReads(10_000);
    }
    expect(retention.hasEscalated()).toBe(false);
    expect(retention.getRetention()).toBe("short");

    // Turn 5: should escalate
    retention.recordTurn();
    retention.recordCacheReads(10_000);
    expect(retention.hasEscalated()).toBe(true);
    expect(retention.getRetention()).toBe("long");
  });

  it("costGateOpen=true escalates at normal turnThreshold (3 turns)", () => {
    const retention = createAdaptiveCacheRetention({
      coldStartRetention: "short",
      warmRetention: "long",
      escalationThreshold: 1000,
    });

    retention.setCostGateOpen(true);

    // 3 turns with cache reads -- should escalate normally
    for (let i = 0; i < 3; i++) {
      retention.recordTurn();
      retention.recordCacheReads(10_000);
    }
    expect(retention.hasEscalated()).toBe(true);
    expect(retention.getRetention()).toBe("long");
  });

  it("fast-path (>20K first-turn write) still escalates on turn 2 even when costGateOpen=false", () => {
    const retention = createAdaptiveCacheRetention({
      coldStartRetention: "short",
      warmRetention: "long",
      escalationThreshold: 1000,
    });

    retention.setCostGateOpen(false);

    // Turn 1: large system prompt write (>FAST_PATH_CACHE_WRITE_THRESHOLD)
    retention.recordTurnWithCacheWrite(25_000);
    expect(retention.hasEscalated()).toBe(false);

    // Turn 2: cache reads confirm content is being reused, then turn completes
    retention.recordCacheReads(100);
    retention.recordTurnWithCacheWrite(5_000);
    expect(retention.hasEscalated()).toBe(true);
    expect(retention.getRetention()).toBe("long");
  });

  it("setCostGateOpen(true) after being false restores normal threshold", () => {
    const retention = createAdaptiveCacheRetention({
      coldStartRetention: "short",
      warmRetention: "long",
      escalationThreshold: 1000,
    });

    retention.setCostGateOpen(false);

    // 3 turns: won't escalate (cost gate closed requires 5)
    for (let i = 0; i < 3; i++) {
      retention.recordTurn();
      retention.recordCacheReads(10_000);
    }
    expect(retention.hasEscalated()).toBe(false);

    // Open the gate -- should immediately re-evaluate and escalate
    // (already at 3 turns with totalCacheReads > 0)
    retention.setCostGateOpen(true);
    // Need a trigger to re-evaluate (next recordTurn or recordCacheReads)
    retention.recordCacheReads(1);
    expect(retention.hasEscalated()).toBe(true);
    expect(retention.getRetention()).toBe("long");
  });

  it("reset() on AdaptiveCacheRetention also resets costGateOpen to true (default open)", () => {
    const retention = createAdaptiveCacheRetention({
      coldStartRetention: "short",
      warmRetention: "long",
      escalationThreshold: 1000,
    });

    retention.setCostGateOpen(false);
    retention.reset();

    // After reset, cost gate should be open (default)
    // 3 turns should escalate (normal threshold, not 5)
    for (let i = 0; i < 3; i++) {
      retention.recordTurn();
      retention.recordCacheReads(10_000);
    }
    expect(retention.hasEscalated()).toBe(true);
    expect(retention.getRetention()).toBe("long");
  });
});

// ---------------------------------------------------------------------------
// Prefix instability detection
// ---------------------------------------------------------------------------

describe("prefix instability detection", () => {
  it("forces retention to 'short' after PREFIX_INSTABILITY_THRESHOLD consecutive baseline reads", () => {
    const retention = createAdaptiveCacheRetention(createDefaultConfig({
      escalationMode: "turns",
      escalationTurnThreshold: 3,
    }));
    // Escalate first
    for (let i = 0; i < 3; i++) {
      retention.recordTurn();
      retention.recordCacheReads(10_000);
    }
    expect(retention.getRetention()).toBe("long");

    // Simulate PREFIX_INSTABILITY_THRESHOLD consecutive baseline-only reads
    const baseline = 24_250;
    for (let i = 0; i < PREFIX_INSTABILITY_THRESHOLD; i++) {
      const forced = retention.recordCacheReadForStability(baseline, baseline);
      if (i < PREFIX_INSTABILITY_THRESHOLD - 1) {
        expect(forced).toBe(false);
      } else {
        expect(forced).toBe(true);
      }
    }

    // Retention should now be forced to "short"
    expect(retention.getRetention()).toBe("short");
  });

  it("recovers when cacheRead exceeds baseline", () => {
    const retention = createAdaptiveCacheRetention(createDefaultConfig({
      escalationMode: "turns",
      escalationTurnThreshold: 3,
    }));
    // Escalate
    for (let i = 0; i < 3; i++) {
      retention.recordTurn();
      retention.recordCacheReads(10_000);
    }
    // Trigger instability
    const baseline = 24_250;
    for (let i = 0; i < PREFIX_INSTABILITY_THRESHOLD; i++) {
      retention.recordCacheReadForStability(baseline, baseline);
    }
    expect(retention.getRetention()).toBe("short");

    // Recovery: cache reads exceed baseline
    retention.recordCacheReadForStability(50_000, baseline);
    expect(retention.getRetention()).toBe("long");
  });

  it("does not trigger when not escalated", () => {
    const retention = createAdaptiveCacheRetention(createDefaultConfig({
      escalationMode: "turns",
      escalationTurnThreshold: 3,
    }));
    // Not escalated yet
    const baseline = 24_250;
    for (let i = 0; i < PREFIX_INSTABILITY_THRESHOLD + 5; i++) {
      retention.recordCacheReadForStability(baseline, baseline);
    }
    // Should remain "short" (cold start) — not forced
    expect(retention.getRetention()).toBe("short");
  });

  it("reset clears instability state", () => {
    const retention = createAdaptiveCacheRetention(createDefaultConfig({
      escalationMode: "turns",
      escalationTurnThreshold: 3,
    }));
    // Escalate
    for (let i = 0; i < 3; i++) {
      retention.recordTurn();
      retention.recordCacheReads(10_000);
    }
    // Trigger instability
    for (let i = 0; i < PREFIX_INSTABILITY_THRESHOLD; i++) {
      retention.recordCacheReadForStability(24_250, 24_250);
    }
    expect(retention.getRetention()).toBe("short");

    // Reset clears instability
    retention.reset();
    expect(retention.getRetention()).toBe("short"); // cold-start, not forced
    // Re-escalate
    for (let i = 0; i < 3; i++) {
      retention.recordTurn();
      retention.recordCacheReads(10_000);
    }
    expect(retention.getRetention()).toBe("long"); // instability cleared
  });

  it("static retention recordCacheReadForStability is no-op", () => {
    const retention = createStaticRetention("long");
    expect(retention.recordCacheReadForStability(100, 100)).toBe(false);
    expect(retention.getRetention()).toBe("long");
  });
});
