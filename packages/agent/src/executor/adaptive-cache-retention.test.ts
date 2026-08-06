// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { coldStartRetentionFor, resolveColdStartRetention, createAdaptiveCacheRetention, createStaticRetention, FAST_PATH_CACHE_WRITE_THRESHOLD, PREFIX_INSTABILITY_THRESHOLD } from "./adaptive-cache-retention.js";
import type { AdaptiveCacheRetentionConfig } from "./adaptive-cache-retention.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createDefaultConfig(overrides?: Partial<AdaptiveCacheRetentionConfig>): AdaptiveCacheRetentionConfig {
  return {
    coldStartRetention: "short",
    warmRetention: "long",
    escalationThreshold: 1000,
    ...overrides,
  };
}

/** Drive the turn-based escalation past its default 3-turn threshold. */
function escalateViaTurns(retention: ReturnType<typeof createAdaptiveCacheRetention>, turnsBeyondThreshold = 0): void {
  for (let i = 0; i < 3 + turnsBeyondThreshold; i++) {
    retention.recordTurn();
    retention.recordCacheReads(10_000);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createAdaptiveCacheRetention", () => {
  it("starts with coldStartRetention ('short')", () => {
    const retention = createAdaptiveCacheRetention(createDefaultConfig());

    expect(retention.getRetention()).toBe("short");
  });

  it("does not escalate after 1 turn with cache reads", () => {
    const retention = createAdaptiveCacheRetention(createDefaultConfig());

    retention.recordTurn();
    retention.recordCacheReads(50_000);

    expect(retention.getRetention()).toBe("short");
  });

  it("escalates after 3 turns with cache reads (default turn-based threshold)", () => {
    const retention = createAdaptiveCacheRetention(createDefaultConfig());

    escalateViaTurns(retention);

    expect(retention.getRetention()).toBe("long");
  });

  it("once escalated, stays at warmRetention even if no further reads", () => {
    const retention = createAdaptiveCacheRetention(createDefaultConfig());

    escalateViaTurns(retention);
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

    // Escalate via 3 turns + reads
    escalateViaTurns(retention);
    expect(retention.getRetention()).toBe("long");

    // After escalation -- message retention tracks warm retention
    expect(retention.getMessageRetention()).toBe("long");
  });

  it("getMessageRetention() returns 'short' after reset", () => {
    const retention = createAdaptiveCacheRetention(createDefaultConfig());

    // Escalate
    escalateViaTurns(retention);
    expect(retention.getMessageRetention()).toBe("long");

    // Reset restores cold-start behavior
    retention.reset();
    expect(retention.getMessageRetention()).toBe("short");
  });

  it("recordTurn() with zero cache reads does not escalate", () => {
    const retention = createAdaptiveCacheRetention(createDefaultConfig());

    retention.recordTurn();
    retention.recordTurn();
    retention.recordTurn();
    // No cache reads recorded -- turn-based escalation requires totalCacheReads > 0

    expect(retention.getRetention()).toBe("short");
  });

  it("respects custom escalationTurnThreshold", () => {
    const retention = createAdaptiveCacheRetention(createDefaultConfig({
      escalationTurnThreshold: 5,
    }));

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

  it("hasEscalated() returns false before threshold", () => {
    const retention = createAdaptiveCacheRetention(createDefaultConfig());

    retention.recordTurn();
    retention.recordCacheReads(1_500);

    expect(retention.hasEscalated()).toBe(false);
  });

  it("hasEscalated() returns true after threshold", () => {
    const retention = createAdaptiveCacheRetention(createDefaultConfig());

    escalateViaTurns(retention);

    expect(retention.hasEscalated()).toBe(true);
  });

  it("hasEscalated() remains true once set (one-way)", () => {
    const retention = createAdaptiveCacheRetention(createDefaultConfig());

    escalateViaTurns(retention);
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

    escalateViaTurns(retention);

    expect(onEscalated).toHaveBeenCalledOnce();
    expect(retention.hasEscalated()).toBe(true);
  });

  it("does not call onEscalated below threshold", () => {
    const onEscalated = vi.fn();
    const retention = createAdaptiveCacheRetention(createDefaultConfig({
      onEscalated,
    }));

    retention.recordTurn();
    retention.recordCacheReads(999);

    expect(onEscalated).not.toHaveBeenCalled();
    expect(retention.hasEscalated()).toBe(false);
  });

  it("onEscalated called only once even with additional turns past threshold", () => {
    const onEscalated = vi.fn();
    const retention = createAdaptiveCacheRetention(createDefaultConfig({
      onEscalated,
    }));

    escalateViaTurns(retention, 2);

    expect(onEscalated).toHaveBeenCalledOnce();
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

      escalateViaTurns(retention);
      expect(retention.getRetention()).toBe("long");

      retention.reset();

      expect(retention.getRetention()).toBe("short");
    });

    it("after reset(), hasEscalated() returns false", () => {
      const retention = createAdaptiveCacheRetention(createDefaultConfig());

      escalateViaTurns(retention);
      expect(retention.hasEscalated()).toBe(true);

      retention.reset();

      expect(retention.hasEscalated()).toBe(false);
    });

    it("after reset(), the retention can re-escalate to warmRetention", () => {
      const retention = createAdaptiveCacheRetention(createDefaultConfig());

      escalateViaTurns(retention);
      expect(retention.getRetention()).toBe("long");

      retention.reset();
      expect(retention.getRetention()).toBe("short");

      escalateViaTurns(retention);
      expect(retention.getRetention()).toBe("long");
      expect(retention.hasEscalated()).toBe(true);
    });

    it("after reset(), onEscalated callback fires again on next escalation", () => {
      const onEscalated = vi.fn();
      const retention = createAdaptiveCacheRetention(createDefaultConfig({
        onEscalated,
      }));

      // First escalation
      escalateViaTurns(retention);
      expect(onEscalated).toHaveBeenCalledTimes(1);

      // Reset
      retention.reset();

      // Second escalation -- callback should fire again
      escalateViaTurns(retention);
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

    it("after reset(), turnCount is 0 (2 turns post-reset do not re-escalate)", () => {
      const retention = createAdaptiveCacheRetention(createDefaultConfig());

      // Escalate
      escalateViaTurns(retention);
      expect(retention.getRetention()).toBe("long");

      // Reset
      retention.reset();

      // 2 post-reset turns -- below the default threshold of 3
      retention.recordTurn();
      retention.recordCacheReads(10_000);
      retention.recordTurn();
      retention.recordCacheReads(10_000);
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
// Turn-count-based escalation
// ---------------------------------------------------------------------------

describe("createAdaptiveCacheRetention turn-based escalation", () => {
  it("does NOT escalate after 1 turn with 50K cache reads", () => {
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

  it("escalates after 3 turns with cache reads (default threshold)", () => {
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
  // Reads must MEET escalationThreshold (1000), not merely be non-zero — a single
  // cached token is not evidence a large prefix is being reused.
  it("fast-path: escalates on turn 2 when the first turn wrote >20K and reads meet the threshold", () => {
    const onEscalated = vi.fn();
    const retention = createAdaptiveCacheRetention(createDefaultConfig({
      onEscalated,
    }));

    // Turn 1: large system prompt write (>FAST_PATH_CACHE_WRITE_THRESHOLD)
    retention.recordTurnWithCacheWrite(25_000);
    expect(retention.hasEscalated()).toBe(false);

    // Turn 2: cache reads confirm content is being reused, then turn completes
    retention.recordCacheReads(1_500);
    retention.recordTurnWithCacheWrite(5_000);
    expect(retention.hasEscalated()).toBe(true);
    expect(retention.getRetention()).toBe("long");
    expect(onEscalated).toHaveBeenCalledOnce();
  });

  it("no fast-path: first turn wrote <20K tokens -- standard 3-turn threshold applies", () => {
    const onEscalated = vi.fn();
    const retention = createAdaptiveCacheRetention(createDefaultConfig({
      onEscalated,
    }));

    // Turn 1: small cache write (<FAST_PATH_CACHE_WRITE_THRESHOLD)
    retention.recordTurnWithCacheWrite(15_000);
    expect(retention.hasEscalated()).toBe(false);

    // Turn 2: cache reads + turn end
    retention.recordCacheReads(1_500);
    retention.recordTurnWithCacheWrite(5_000);
    expect(retention.hasEscalated()).toBe(false);
    expect(onEscalated).not.toHaveBeenCalled();
  });

  it("fast-path requires totalCacheReads > 0 -- zero cache reads on turn 2 does not escalate", () => {
    const retention = createAdaptiveCacheRetention(createDefaultConfig());

    // Turn 1: large write but no cache reads recorded anywhere
    retention.recordTurnWithCacheWrite(25_000);

    // Turn 2: still no cache reads -- fast-path guard prevents escalation
    retention.recordTurnWithCacheWrite(5_000);
    expect(retention.hasEscalated()).toBe(false);
  });

  it("recordTurnWithCacheWrite increments turnCount -- standard escalation triggers at 3 turns", () => {
    const onEscalated = vi.fn();
    const retention = createAdaptiveCacheRetention(createDefaultConfig({
      onEscalated,
    }));

    // 3 turns with small writes and cache reads -- standard threshold
    retention.recordCacheReads(1_500);
    retention.recordTurnWithCacheWrite(5_000);
    expect(retention.hasEscalated()).toBe(false);

    retention.recordCacheReads(1_500);
    retention.recordTurnWithCacheWrite(5_000);
    expect(retention.hasEscalated()).toBe(false);

    retention.recordCacheReads(1_500);
    retention.recordTurnWithCacheWrite(5_000);
    expect(retention.hasEscalated()).toBe(true);
    expect(onEscalated).toHaveBeenCalledOnce();
  });

  it("reset() clears fast-path state (lastCacheWriteTokens resets to 0)", () => {
    const retention = createAdaptiveCacheRetention(createDefaultConfig());

    // Turn 1: large write
    retention.recordTurnWithCacheWrite(25_000);
    retention.recordCacheReads(1_500);

    // Reset before turn 2 -- fast-path state should be cleared
    retention.reset();

    // Turn 2: the previous large write should no longer trigger fast-path
    retention.recordCacheReads(1_500);
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
      // default escalationTurnThreshold = 3
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
    retention.recordCacheReads(1_500);
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

  // -------------------------------------------------------------------------
  // Cold-start derivation
  //
  // The ladder only works when cold and warm DIFFER: tryEscalate() returns
  // early on `currentRetention === config.warmRetention`. Passing the same
  // value for both pins `escalated` false forever, which disables the
  // escalation, the onEscalated warm-state callback, AND the
  // prefix-instability downgrade (it falls back to coldStartRetention, i.e.
  // the same "long" it was meant to escape).
  // -------------------------------------------------------------------------

  it("starts an already-warm session at the warm retention instead of re-climbing the ladder", () => {
    // The ladder is rebuilt per EXECUTION, not per session. A session that already
    // escalated has its prefix cached at the warm TTL, so starting cold again writes
    // the whole prefix at 5m and then re-writes it at 1h on re-escalation — 6.25N +
    // 10N where 10N would have done, every execution. Live: `reason=retention_changed`
    // dropping 627,920 tokens in ~9.5h. The escalation already records the warm state;
    // nothing read it back (getCacheWarm had exactly one reference repo-wide: its own
    // definition).
    expect(resolveColdStartRetention("long", true)).toBe("long");
  });

  it("starts a session that has never escalated at the cold retention", () => {
    // Unchanged for a genuinely cold prefix: no evidence the cache will be read yet,
    // so do not pay the 2x 1h write premium up front.
    expect(resolveColdStartRetention("long", false)).toBe("short");
    expect(resolveColdStartRetention("long", undefined)).toBe("short");
  });

  it("leaves a non-escalating retention alone whatever the warm state", () => {
    for (const warm of [true, false, undefined]) {
      expect(resolveColdStartRetention("short", warm)).toBe("short");
      expect(resolveColdStartRetention("none", warm)).toBe("none");
    }
  });

  it("derives a cheaper cold start for a long warm target", () => {
    expect(coldStartRetentionFor("long")).toBe("short");
  });

  it("leaves a non-long warm target unchanged (nothing to step down from)", () => {
    expect(coldStartRetentionFor("short")).toBe("short");
    expect(coldStartRetentionFor("none")).toBe("none");
  });

  it("escalates to the warm target when cold and warm differ", () => {
    const retention = createAdaptiveCacheRetention({
      coldStartRetention: coldStartRetentionFor("long"),
      warmRetention: "long",
      escalationThreshold: 1000,
    });
    expect(retention.getRetention()).toBe("short");
    for (let i = 0; i < 3; i++) {
      retention.recordTurn();
      retention.recordCacheReads(10_000);
    }
    expect(retention.hasEscalated()).toBe(true);
    expect(retention.getRetention()).toBe("long");
  });

  it("never escalates when cold and warm are the same value", () => {
    // Regression lock on the defect: a session configured long/long can never
    // report escalation, so the warm-state callback never fires and the
    // instability downgrade has nowhere to step down to.
    const onEscalated = vi.fn();
    const retention = createAdaptiveCacheRetention({
      coldStartRetention: "long",
      warmRetention: "long",
      escalationThreshold: 1000,
      onEscalated,
    });
    for (let i = 0; i < 10; i++) {
      retention.recordTurn();
      retention.recordCacheReads(10_000);
    }
    expect(retention.hasEscalated()).toBe(false);
    expect(onEscalated).not.toHaveBeenCalled();
  });

  it("promotes on turn 2 via the large-first-write fast path", () => {
    const retention = createAdaptiveCacheRetention({
      coldStartRetention: coldStartRetentionFor("long"),
      warmRetention: "long",
      escalationThreshold: 1000,
    });
    // Measured live: cold writes averaged ~38K tokens, well over the 20K gate,
    // so a real session pays the cheap 5m rate for exactly one turn.
    retention.recordTurnWithCacheWrite(FAST_PATH_CACHE_WRITE_THRESHOLD + 18_000);
    retention.recordCacheReads(5_000);
    retention.recordTurnWithCacheWrite(0);
    expect(retention.getRetention()).toBe("long");
  });

  it("static retention recordCacheReadForStability is no-op", () => {
    const retention = createStaticRetention("long");
    expect(retention.recordCacheReadForStability(100, 100)).toBe(false);
    expect(retention.getRetention()).toBe("long");
  });
});

// ---------------------------------------------------------------------------
// Cross-execution escalation progress
//
// The ladder is rebuilt per EXECUTION (session-bootstrap.ts), and `turnCount`
// is incremented per MODEL CALL by the bridge. A cheap conversational turn --
// a greeting, a status poll, a short answer -- is exactly ONE model call, so a
// per-instance counter tops out at 1 and can never reach the >=2/>=3 gate.
// Escalation is the only caller of setCacheWarm(true), so such a conversation
// stays pinned at the 5m cold rate forever and re-buys its whole cached prefix
// on every inter-turn gap longer than 5 minutes.
//
// Measured live on comis-moshe (2026-08-06, claude-haiku-4-5): three cheap
// turns after a restart all shipped retention "short"; turn 2 arrived 9m47s
// after turn 1 and re-wrote the full prefix (141,074 then 141,103 tokens,
// cache_read 0 both times) because the 5m TTL had expired.
//
// The designed 3-turn heuristic is kept -- the counter it was written for must
// simply survive the per-execution rebuild.
// ---------------------------------------------------------------------------

describe("createAdaptiveCacheRetention cross-execution progress", () => {
  /** One execution's ladder, wired the way session-bootstrap wires it. */
  function ladderForExecution(state: {
    warm?: boolean;
    progress?: { turns: number; reads: number };
  }) {
    return createAdaptiveCacheRetention({
      coldStartRetention: resolveColdStartRetention("long", state.warm),
      warmRetention: "long",
      escalationThreshold: 1000,
      ...(state.progress !== undefined && {
        initialTurnCount: state.progress.turns,
        initialCacheReads: state.progress.reads,
      }),
      onProgress: (progress) => { state.progress = progress; },
      onEscalated: () => { state.warm = true; },
    });
  }

  it("escalates a conversation of cheap single-model-call turns by the third turn", () => {
    const state: { warm?: boolean; progress?: { turns: number; reads: number } } = {};

    // Turn 1: cold. Full prefix write, nothing cached yet to read.
    const first = ladderForExecution(state);
    expect(first.getRetention()).toBe("short");
    first.recordTurnWithCacheWrite(141_074);
    first.recordCacheReads(0);

    // Turn 2: the prefix is live now, so this turn reads it.
    const second = ladderForExecution(state);
    second.recordTurnWithCacheWrite(4_255);
    second.recordCacheReads(136_909);

    // Turn 3: the session has now shown three turns and real reads. The 1h TTL
    // has been earned -- without this the session writes at 5m indefinitely.
    const third = ladderForExecution(state);
    third.recordTurnWithCacheWrite(4_255);
    third.recordCacheReads(136_909);

    expect(state.warm).toBe(true);
    expect(ladderForExecution(state).getRetention()).toBe("long");
  });

  it("carries accumulated reads across executions so a missed turn cannot withhold escalation", () => {
    // Both escalation paths require totalCacheReads > 0. A gap-turn whose 5m
    // prefix expired reads 0, so a per-instance counter lets the miss withhold
    // the escalation that would have prevented it. Accumulated reads break that
    // self-reinforcing loop.
    const state: { warm?: boolean; progress?: { turns: number; reads: number } } = {};

    const first = ladderForExecution(state);
    first.recordTurnWithCacheWrite(141_074);
    first.recordCacheReads(136_909);

    const second = ladderForExecution(state);
    second.recordTurnWithCacheWrite(141_103);
    second.recordCacheReads(0); // 5m TTL expired during the user's think-time

    const third = ladderForExecution(state);
    third.recordTurnWithCacheWrite(0);
    third.recordCacheReads(0);

    expect(state.warm).toBe(true);
  });

  // `escalationThreshold` is documented "Minimum cumulative cacheRead tokens
  // before escalating. Default: 1000" and session-bootstrap passes 1000, but the
  // implementation gated on `totalCacheReads > 0` and never read the field — so
  // the knob an operator would reach for did nothing, and a single cached token
  // counted as proof the prefix was worth 1h.
  it("honours escalationThreshold instead of escalating on any non-zero read", () => {
    const belowThreshold = createAdaptiveCacheRetention(createDefaultConfig({
      coldStartRetention: "short", warmRetention: "long", escalationThreshold: 1000,
    }));
    for (let i = 0; i < 4; i++) {
      belowThreshold.recordTurn();
      belowThreshold.recordCacheReads(100); // 400 total — under 1000
    }
    expect(belowThreshold.getRetention()).toBe("short");
    expect(belowThreshold.hasEscalated()).toBe(false);

    const atThreshold = createAdaptiveCacheRetention(createDefaultConfig({
      coldStartRetention: "short", warmRetention: "long", escalationThreshold: 1000,
    }));
    for (let i = 0; i < 4; i++) {
      atThreshold.recordTurn();
      atThreshold.recordCacheReads(250); // 1000 total — meets the threshold
    }
    expect(atThreshold.getRetention()).toBe("long");
  });

  it("still pays the cheap 5m rate on a genuinely new session's first turn", () => {
    // The ladder exists so a cold start does not pay the 2x 1h write premium.
    // Seeding must not defeat that: with no prior progress and no reads yet,
    // turn 1 stays "short".
    const state: { warm?: boolean; progress?: { turns: number; reads: number } } = {};
    const first = ladderForExecution(state);

    expect(first.getRetention()).toBe("short");
    first.recordTurnWithCacheWrite(141_074);
    first.recordCacheReads(0);
    expect(first.getRetention()).toBe("short");
    expect(state.warm).toBeUndefined();
  });
});
