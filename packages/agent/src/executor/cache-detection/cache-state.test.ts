// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for cache-detection/cache-state.ts.
 *
 * Covers `createCacheBreakDetector`, `clearCacheBreakDetectorSession`,
 * `MAX_TRACKING_ENTRIES`, and all detector behavior (recordPromptState,
 * checkResponseForCacheBreak, notifyCompaction, notifyTtlExpiry,
 * notifyContentModification, aliasSession, LRU bounds, model exclusion,
 * tiered server-side attribution, lookback-aware attribution, API error
 * suppression, effort value tracking, cacheControlHash, lazy
 * buildDiffableContent). Cross-cutting tests that exercise the Anthropic
 * adapter together with the detector remain here, not in
 * anthropic-extractor.test.ts.
 *
 * @module
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ClockPort } from "@comis/core";

// Test-only clock stub.
const testClock: ClockPort = { now: () => Date.now(), nowDate: () => new Date() };

import {
  MAX_TRACKING_ENTRIES,
  clearCacheBreakDetectorSession,
  createCacheBreakDetector,
} from "./cache-state.js";
import type {
  CacheBreakDetector,
  CacheBreakEvent,
  RecordPromptStateInput,
} from "./cache-state-types.js";
import { extractAnthropicPromptState } from "./anthropic-extractor.js";
import {
  CACHE_BREAK_RELATIVE_THRESHOLD,
  CACHE_BREAK_ABSOLUTE_THRESHOLD,
} from "../../context-engine/constants.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const noopLogger = {
  debug: () => {},
  info: () => {},
};

function makeBaseInput(overrides: Partial<RecordPromptStateInput> = {}): RecordPromptStateInput {
  return {
    sessionKey: "test-session",
    agentId: "agent-1",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    systemHash: 12345,
    toolsHash: 67890,
    cacheMetadataHash: null,
    toolNames: ["bash", "file_read"],
    perToolHashes: { bash: 111, file_read: 222 },
    retention: "short",
    headersHash: null,
    extraBodyHash: null,
    ...overrides,
  };
}

const fixtureParams = {
  system: [
    { type: "text", text: "You are a helpful assistant", cache_control: { type: "ephemeral" } },
  ],
  tools: [
    { name: "bash", description: "Run bash", input_schema: { type: "object", properties: { cmd: { type: "string" } } }, cache_control: { type: "ephemeral" } },
    { name: "file_read", description: "Read file", input_schema: { type: "object", properties: { path: { type: "string" } } } },
  ],
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("cache break threshold constants", () => {
  it("CACHE_BREAK_RELATIVE_THRESHOLD equals 0.05", () => {
    expect(CACHE_BREAK_RELATIVE_THRESHOLD).toBe(0.05);
  });

  it("CACHE_BREAK_ABSOLUTE_THRESHOLD equals 2000", () => {
    expect(CACHE_BREAK_ABSOLUTE_THRESHOLD).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// recordPromptState
// ---------------------------------------------------------------------------

describe("recordPromptState", () => {
  let detector: CacheBreakDetector;

  beforeEach(() => {
    detector = createCacheBreakDetector(noopLogger, { clock: testClock });
    detector.reset();
  });

  it("first call records state, subsequent call with same state shows no pending changes", () => {
    const input = makeBaseInput();
    detector.recordPromptState(input);
    // Record same state again
    detector.recordPromptState(input);
    // No break should be detected since nothing changed
    // We verify via checkResponseForCacheBreak returning null even with token drop (no prompt-state changes -> server_eviction only)
    detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000 });
    // second check with drop
    const event = detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 40000, cacheWriteTokens: 0, totalInputTokens: 60000 });
    // No prompt-state changes, so if break detected it should be server_eviction
    if (event) {
      expect(event.reason).toBe("server_eviction");
      expect(event.changes.systemChanged).toBe(false);
      expect(event.changes.toolsChanged).toBe(false);
    }
  });

  it("second call with changed system hash shows systemChanged = true", () => {
    detector.recordPromptState(makeBaseInput());
    detector.recordPromptState(makeBaseInput({ systemHash: 99999 }));
    // Set baseline
    detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000 });
    const event = detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 40000, cacheWriteTokens: 0, totalInputTokens: 60000 });
    expect(event).not.toBeNull();
    expect(event!.changes.systemChanged).toBe(true);
  });

  it("second call with added tool shows addedTools containing the new tool name", () => {
    detector.recordPromptState(makeBaseInput());
    detector.recordPromptState(makeBaseInput({
      toolNames: ["bash", "file_read", "web_search"],
      perToolHashes: { bash: 111, file_read: 222, web_search: 333 },
      toolsHash: 99999, // must change toolsHash to trigger per-tool diff
    }));
    detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000 });
    const event = detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 40000, cacheWriteTokens: 0, totalInputTokens: 60000 });
    expect(event).not.toBeNull();
    expect(event!.changes.addedTools).toContain("web_search");
    expect(event!.changes.toolsChanged).toBe(true);
  });

  it("second call with removed tool shows removedTools containing the old tool name", () => {
    detector.recordPromptState(makeBaseInput());
    detector.recordPromptState(makeBaseInput({
      toolNames: ["bash"],
      perToolHashes: { bash: 111 },
      toolsHash: 99999, // must change toolsHash to trigger per-tool diff
    }));
    detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000 });
    const event = detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 40000, cacheWriteTokens: 0, totalInputTokens: 60000 });
    expect(event).not.toBeNull();
    expect(event!.changes.removedTools).toContain("file_read");
    expect(event!.changes.toolsChanged).toBe(true);
  });

  it("second call with changed tool schema shows changedSchemaTools", () => {
    detector.recordPromptState(makeBaseInput());
    detector.recordPromptState(makeBaseInput({
      perToolHashes: { bash: 999, file_read: 222 },
      toolsHash: 99999, // must change toolsHash to trigger per-tool diff
    }));
    detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000 });
    const event = detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 40000, cacheWriteTokens: 0, totalInputTokens: 60000 });
    expect(event).not.toBeNull();
    expect(event!.changes.changedSchemaTools).toContain("bash");
    expect(event!.changes.toolsChanged).toBe(true);
  });

  it("second call with changed model shows modelChanged = true", () => {
    detector.recordPromptState(makeBaseInput());
    detector.recordPromptState(makeBaseInput({ model: "claude-opus-4-5" }));
    detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000 });
    const event = detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 40000, cacheWriteTokens: 0, totalInputTokens: 60000 });
    expect(event).not.toBeNull();
    expect(event!.changes.modelChanged).toBe(true);
  });

  it("second call with changed retention shows retentionChanged = true", () => {
    detector.recordPromptState(makeBaseInput());
    detector.recordPromptState(makeBaseInput({ retention: "long" }));
    detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000 });
    const event = detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 40000, cacheWriteTokens: 0, totalInputTokens: 60000 });
    expect(event).not.toBeNull();
    expect(event!.changes.retentionChanged).toBe(true);
  });

  it("second call with changed cacheMetadataHash shows metadataChanged = true", () => {
    detector.recordPromptState(makeBaseInput());
    detector.recordPromptState(makeBaseInput({ cacheMetadataHash: 55555 }));
    detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000 });
    const event = detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 40000, cacheWriteTokens: 0, totalInputTokens: 60000 });
    expect(event).not.toBeNull();
    expect(event!.changes.metadataChanged).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkResponseForCacheBreak
// ---------------------------------------------------------------------------

describe("checkResponseForCacheBreak", () => {
  let detector: CacheBreakDetector;

  beforeEach(() => {
    detector = createCacheBreakDetector(noopLogger, { clock: testClock });
    detector.reset();
  });

  it("first call (no previous state) returns null", () => {
    detector.recordPromptState(makeBaseInput());
    const event = detector.checkResponseForCacheBreak({
      sessionKey: "test-session",
      provider: "anthropic",
      cacheReadTokens: 50000,
      cacheWriteTokens: 5000,
      totalInputTokens: 60000,
    });
    expect(event).toBeNull();
  });

  it("cacheRead drops 20% / 10000 abs with tools changed -> returns CacheBreakEvent with reason tools_changed", () => {
    detector.recordPromptState(makeBaseInput());
    // Set baseline
    detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000 });
    // Record changed tools
    detector.recordPromptState(makeBaseInput({
      toolNames: ["bash", "file_read", "web_search"],
      perToolHashes: { bash: 111, file_read: 222, web_search: 333 },
      toolsHash: 99999, // must change toolsHash to trigger per-tool diff
    }));
    // Check with drop
    const event = detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 40000, cacheWriteTokens: 0, totalInputTokens: 60000 });
    expect(event).not.toBeNull();
    expect(event!.reason).toBe("tools_changed");
    expect(event!.tokenDrop).toBe(10000);
  });

  it("cacheRead drops 2% / 1000 abs -> returns null (neither threshold exceeded)", () => {
    detector.recordPromptState(makeBaseInput());
    detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000 });
    detector.recordPromptState(makeBaseInput({ systemHash: 99999 }));
    const event = detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 49000, cacheWriteTokens: 0, totalInputTokens: 60000 });
    expect(event).toBeNull();
  });

  it("cacheRead drops 5% / 2500 abs -> returns CacheBreakEvent (both thresholds exceeded)", () => {
    detector.recordPromptState(makeBaseInput());
    detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000 });
    detector.recordPromptState(makeBaseInput({ systemHash: 99999 }));
    // 50000 - 47500 = 2500 abs, 2500/50000 = 5% relative -> need STRICTLY > 5%
    // Actually 5% exactly should NOT trigger (strict greater-than)
    // Let's use 47400 -> drop = 2600 abs, 2600/50000 = 5.2% relative
    const event = detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 47400, cacheWriteTokens: 0, totalInputTokens: 60000 });
    expect(event).not.toBeNull();
    expect(event!.reason).toBe("system_changed");
  });

  it("cacheRead drops 4% / 2000 abs -> returns null (neither threshold strictly exceeded)", () => {
    detector.recordPromptState(makeBaseInput());
    detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000 });
    detector.recordPromptState(makeBaseInput({ systemHash: 99999 }));
    // 50000 - 48000 = 2000 abs, 2000/50000 = 4% relative -> below 5%
    const event = detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 48000, cacheWriteTokens: 0, totalInputTokens: 60000 });
    expect(event).toBeNull();
  });

  it("complete cache miss (cacheRead drops to 0) with no prompt-state changes -> server_eviction", () => {
    detector.recordPromptState(makeBaseInput());
    detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000 });
    detector.recordPromptState(makeBaseInput());
    const event = detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 0, cacheWriteTokens: 0, totalInputTokens: 60000 });
    expect(event).not.toBeNull();
    expect(event!.reason).toBe("server_eviction");
  });

  it("event payload includes all required fields", () => {
    detector.recordPromptState(makeBaseInput());
    detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000 });
    detector.recordPromptState(makeBaseInput({ systemHash: 99999 }));
    const event = detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 40000, cacheWriteTokens: 0, totalInputTokens: 60000 });
    expect(event).not.toBeNull();
    expect(event!.provider).toBe("anthropic");
    expect(event!.reason).toBeTypeOf("string");
    expect(event!.tokenDrop).toBe(10000);
    expect(event!.tokenDropRelative).toBeCloseTo(0.2, 5);
    expect(event!.previousCacheRead).toBe(50000);
    expect(event!.currentCacheRead).toBe(40000);
    expect(event!.callCount).toBeTypeOf("number");
    expect(event!.changes).toBeDefined();
    expect(event!.toolsChanged).toBeDefined();
    expect(event!.timestamp).toBeTypeOf("number");
    expect(event!.agentId).toBe("agent-1");
    expect(event!.sessionKey).toBe("test-session");
  });
});

// ---------------------------------------------------------------------------
// AND-based cache break threshold
// ---------------------------------------------------------------------------

describe("AND-based cache break threshold", () => {
  let detector: CacheBreakDetector;
  beforeEach(() => {
    detector = createCacheBreakDetector(noopLogger as any, { clock: testClock });
  });

  it("returns null when only absolute exceeds (3K drop on 200K context)", () => {
    detector.recordPromptState(makeBaseInput());
    detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 200000, cacheWriteTokens: 0, totalInputTokens: 250000 });
    detector.recordPromptState(makeBaseInput({ systemHash: 99999 }));
    // 200000 - 197000 = 3000 abs (>2000), 3000/200000 = 1.5% rel (<=5%)
    // AND logic: only absolute exceeds, relative does not -- suppressed
    const event = detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 197000, cacheWriteTokens: 0, totalInputTokens: 250000 });
    expect(event).toBeNull();
  });

  it("returns null when only relative exceeds (6% drop on 10K context)", () => {
    detector.recordPromptState(makeBaseInput());
    detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 10000, cacheWriteTokens: 0, totalInputTokens: 15000 });
    detector.recordPromptState(makeBaseInput({ systemHash: 99999 }));
    // 10000 - 9400 = 600 abs (<=2000), 600/10000 = 6% rel (>5%)
    // AND logic: only relative exceeds, absolute does not -- suppressed
    const event = detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 9400, cacheWriteTokens: 0, totalInputTokens: 15000 });
    expect(event).toBeNull();
  });

  it("returns null when neither threshold exceeded (1K drop on 50K context)", () => {
    detector.recordPromptState(makeBaseInput());
    detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000 });
    detector.recordPromptState(makeBaseInput({ systemHash: 99999 }));
    // 50000 - 49000 = 1000 abs (<=2000), 1000/50000 = 2% rel (<=5%)
    const event = detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 49000, cacheWriteTokens: 0, totalInputTokens: 60000 });
    expect(event).toBeNull();
  });

  it("detects break when BOTH thresholds exceeded (5K drop on 50K context)", () => {
    detector.recordPromptState(makeBaseInput());
    detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000 });
    detector.recordPromptState(makeBaseInput({ systemHash: 99999 }));
    // 50000 - 45000 = 5000 abs (>2000), 5000/50000 = 10% rel (>5%)
    // AND logic: both thresholds exceeded -- detected
    const event = detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 45000, cacheWriteTokens: 0, totalInputTokens: 60000 });
    expect(event).not.toBeNull();
    expect(event!.tokenDrop).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// lazy per-tool hash comparison
// ---------------------------------------------------------------------------

describe("lazy per-tool hash comparison", () => {
  let detector: CacheBreakDetector;
  beforeEach(() => {
    detector = createCacheBreakDetector(noopLogger as any, { clock: testClock });
  });

  it("skips per-tool diff when toolsHash unchanged", () => {
    // Record state with specific tools
    detector.recordPromptState(makeBaseInput({
      toolNames: ["bash", "file_read"],
      perToolHashes: { bash: 100, file_read: 200 },
      toolsHash: 500,
    }));
    // Set baseline
    detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000 });
    // Record same state again (identical toolsHash: 500)
    detector.recordPromptState(makeBaseInput({
      toolNames: ["bash", "file_read"],
      perToolHashes: { bash: 100, file_read: 200 },
      toolsHash: 500,
      systemHash: 99999, // Change system to trigger a break
    }));
    // Trigger with a large drop (both thresholds exceeded)
    const event = detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 0, cacheWriteTokens: 0, totalInputTokens: 60000 });
    expect(event).not.toBeNull();
    expect(event!.changes.toolsChanged).toBe(false);
    expect(event!.changes.addedTools.length).toBe(0);
    expect(event!.changes.removedTools.length).toBe(0);
    expect(event!.changes.changedSchemaTools.length).toBe(0);
  });

  it("computes per-tool diff when toolsHash changes", () => {
    // Record state with initial tools
    detector.recordPromptState(makeBaseInput({
      toolNames: ["bash", "file_read"],
      perToolHashes: { bash: 100, file_read: 200 },
      toolsHash: 500,
    }));
    // Set baseline
    detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000 });
    // Record state with different tools (different toolsHash: 999)
    detector.recordPromptState(makeBaseInput({
      toolNames: ["bash", "web_search"],
      perToolHashes: { bash: 100, web_search: 300 },
      toolsHash: 999,
    }));
    // Trigger break
    const event = detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 0, cacheWriteTokens: 0, totalInputTokens: 60000 });
    expect(event).not.toBeNull();
    expect(event!.changes.toolsChanged).toBe(true);
    expect(event!.changes.addedTools).toContain("web_search");
    expect(event!.changes.removedTools).toContain("file_read");
  });
});

// ---------------------------------------------------------------------------
// attributeReason priority
// ---------------------------------------------------------------------------

describe("attributeReason priority", () => {
  let detector: CacheBreakDetector;

  beforeEach(() => {
    detector = createCacheBreakDetector(noopLogger, { clock: testClock });
    detector.reset();
  });

  function triggerBreakWithChanges(changes: Partial<RecordPromptStateInput>): CacheBreakEvent | null {
    detector.recordPromptState(makeBaseInput());
    detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000 });
    detector.recordPromptState(makeBaseInput(changes));
    return detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 0, cacheWriteTokens: 0, totalInputTokens: 60000 });
  }

  it("when modelChanged AND systemChanged, reason is model_changed", () => {
    const event = triggerBreakWithChanges({ model: "claude-opus-4-5", systemHash: 99999 });
    expect(event).not.toBeNull();
    expect(event!.reason).toBe("model_changed");
  });

  it("when systemChanged AND toolsChanged, reason is system_changed", () => {
    const event = triggerBreakWithChanges({
      systemHash: 99999,
      toolNames: ["bash", "file_read", "web_search"],
      perToolHashes: { bash: 111, file_read: 222, web_search: 333 },
      toolsHash: 99999, // must change toolsHash to trigger per-tool diff
    });
    expect(event).not.toBeNull();
    expect(event!.reason).toBe("system_changed");
  });

  it("when toolsChanged AND retentionChanged, reason is tools_changed", () => {
    const event = triggerBreakWithChanges({
      toolNames: ["bash", "file_read", "web_search"],
      perToolHashes: { bash: 111, file_read: 222, web_search: 333 },
      toolsHash: 99999, // must change toolsHash to trigger per-tool diff
      retention: "long",
    });
    expect(event).not.toBeNull();
    expect(event!.reason).toBe("tools_changed");
  });

  it("when retentionChanged AND metadataChanged, reason is retention_changed", () => {
    const event = triggerBreakWithChanges({ retention: "long", cacheMetadataHash: 55555 });
    expect(event).not.toBeNull();
    expect(event!.reason).toBe("retention_changed");
  });

  it("when metadataChanged only, reason is cache_metadata_changed", () => {
    const event = triggerBreakWithChanges({ cacheMetadataHash: 55555 });
    expect(event).not.toBeNull();
    expect(event!.reason).toBe("cache_metadata_changed");
  });

  it("when no prompt-state changes but token drop detected, reason is server_eviction", () => {
    const event = triggerBreakWithChanges({});
    expect(event).not.toBeNull();
    expect(event!.reason).toBe("server_eviction");
  });
});

// ---------------------------------------------------------------------------
// notifyCompaction
// ---------------------------------------------------------------------------

describe("notifyCompaction", () => {
  let detector: CacheBreakDetector;

  beforeEach(() => {
    detector = createCacheBreakDetector(noopLogger, { clock: testClock });
    detector.reset();
  });

  it("after notifyCompaction, next check returns null (baseline reset)", () => {
    detector.recordPromptState(makeBaseInput());
    detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000 });
    detector.notifyCompaction("test-session");
    detector.recordPromptState(makeBaseInput());
    // Even with a huge token drop, compaction resets baseline
    const event = detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 5000, cacheWriteTokens: 0, totalInputTokens: 60000 });
    expect(event).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// notifyTtlExpiry
// ---------------------------------------------------------------------------

describe("notifyTtlExpiry", () => {
  let detector: CacheBreakDetector;

  beforeEach(() => {
    detector = createCacheBreakDetector(noopLogger, { clock: testClock });
    detector.reset();
  });

  it("after notifyTtlExpiry, next check with token drop attributes reason as ttl_expiry", () => {
    detector.recordPromptState(makeBaseInput());
    detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000 });
    detector.notifyTtlExpiry("test-session");
    detector.recordPromptState(makeBaseInput());
    const event = detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 0, cacheWriteTokens: 0, totalInputTokens: 60000 });
    expect(event).not.toBeNull();
    expect(event!.reason).toBe("ttl_expiry");
  });
});

// ---------------------------------------------------------------------------
// Session isolation
// ---------------------------------------------------------------------------

describe("session isolation", () => {
  let detector: CacheBreakDetector;

  beforeEach(() => {
    detector = createCacheBreakDetector(noopLogger, { clock: testClock });
    detector.reset();
  });

  it("state for session A does not affect session B", () => {
    detector.recordPromptState(makeBaseInput({ sessionKey: "session-a" }));
    detector.checkResponseForCacheBreak({ sessionKey: "session-a", provider: "anthropic", cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000 });

    // Session B has no state
    const event = detector.checkResponseForCacheBreak({ sessionKey: "session-b", provider: "anthropic", cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000 });
    expect(event).toBeNull();
  });

  it("clearCacheBreakDetectorSession removes session A state, B unaffected", () => {
    detector.recordPromptState(makeBaseInput({ sessionKey: "session-a" }));
    detector.checkResponseForCacheBreak({ sessionKey: "session-a", provider: "anthropic", cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000 });

    detector.recordPromptState(makeBaseInput({ sessionKey: "session-b" }));
    detector.checkResponseForCacheBreak({ sessionKey: "session-b", provider: "anthropic", cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000 });

    clearCacheBreakDetectorSession("session-a");

    // Session A state gone -> checkResponseForCacheBreak returns null (no state)
    const eventA = detector.checkResponseForCacheBreak({ sessionKey: "session-a", provider: "anthropic", cacheReadTokens: 0, cacheWriteTokens: 0, totalInputTokens: 60000 });
    expect(eventA).toBeNull();

    // Session B still has state -> should detect drop
    detector.recordPromptState(makeBaseInput({ sessionKey: "session-b" }));
    const eventB = detector.checkResponseForCacheBreak({ sessionKey: "session-b", provider: "anthropic", cacheReadTokens: 0, cacheWriteTokens: 0, totalInputTokens: 60000 });
    expect(eventB).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// callCount tracking
// ---------------------------------------------------------------------------

describe("callCount", () => {
  let detector: CacheBreakDetector;

  beforeEach(() => {
    detector = createCacheBreakDetector(noopLogger, { clock: testClock });
    detector.reset();
  });

  it("callCount increments on each recordPromptState call", () => {
    detector.recordPromptState(makeBaseInput());
    detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000 });

    detector.recordPromptState(makeBaseInput({ systemHash: 99999 }));
    const event = detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 0, cacheWriteTokens: 0, totalInputTokens: 60000 });
    expect(event).not.toBeNull();
    expect(event!.callCount).toBe(2);

    detector.recordPromptState(makeBaseInput({ systemHash: 88888 }));
    const event2 = detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 0, cacheWriteTokens: 10000, totalInputTokens: 60000 });
    // After a drop from 0 to 0, no drop -- should be null since no drop
    // Let's set a real baseline first
    expect(event2).toBeNull(); // 0 to 0 is no drop
  });
});

// ---------------------------------------------------------------------------
// CacheBreakEvent structure
// ---------------------------------------------------------------------------

describe("CacheBreakEvent structure", () => {
  let detector: CacheBreakDetector;

  beforeEach(() => {
    detector = createCacheBreakDetector(noopLogger, { clock: testClock });
    detector.reset();
  });

  it("returned event includes all required CacheBreakEvent fields", () => {
    detector.recordPromptState(makeBaseInput());
    detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000 });
    detector.recordPromptState(makeBaseInput({
      systemHash: 99999,
      toolNames: ["bash", "file_read", "mcp__myserver--read_file"],
      perToolHashes: { bash: 111, file_read: 222, "mcp__myserver--read_file": 444 },
      toolsHash: 99999, // must change toolsHash to trigger per-tool diff
    }));
    const event = detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 30000, cacheWriteTokens: 0, totalInputTokens: 60000 });
    expect(event).not.toBeNull();

    // All required fields
    expect(event).toHaveProperty("provider");
    expect(event).toHaveProperty("reason");
    expect(event).toHaveProperty("tokenDrop");
    expect(event).toHaveProperty("tokenDropRelative");
    expect(event).toHaveProperty("previousCacheRead");
    expect(event).toHaveProperty("currentCacheRead");
    expect(event).toHaveProperty("callCount");
    expect(event).toHaveProperty("changes");
    expect(event).toHaveProperty("toolsChanged");
    expect(event).toHaveProperty("ttlCategory");
    expect(event).toHaveProperty("agentId");
    expect(event).toHaveProperty("sessionKey");
    expect(event).toHaveProperty("timestamp");

    // Verify toolsChanged contains sanitized MCP names
    expect(event!.toolsChanged).toEqual(expect.arrayContaining(["mcp__myserver"]));
  });
});

// ---------------------------------------------------------------------------
// notifyContentModification
// ---------------------------------------------------------------------------

describe("notifyContentModification", () => {
  let detector: CacheBreakDetector;

  beforeEach(() => {
    detector = createCacheBreakDetector(noopLogger, { clock: testClock });
    detector.reset();
  });

  // Helper: establish a baseline with two recordPromptState + one checkResponse
  function establishBaseline(sessionKey = "test-session"): void {
    detector.recordPromptState(makeBaseInput({ sessionKey }));
    detector.checkResponseForCacheBreak({
      sessionKey, provider: "anthropic", cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    // Record again (same state) so pendingChanges is computed
    detector.recordPromptState(makeBaseInput({ sessionKey }));
  }

  // --- Observation masking false positive suppression ---

  it("notifyContentModification + check with no pendingChanges returns null (suppressed)", () => {
    establishBaseline();
    detector.notifyContentModification("test-session");
    // Token drop from 50000 -> 30000 (would normally trigger cache break)
    const event = detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 30000, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    expect(event).toBeNull();
  });

  it("notifyContentModification + token drop but no real changes returns null (pure content modification)", () => {
    establishBaseline();
    detector.notifyContentModification("test-session");
    // Complete cache miss -- pure content modification should suppress
    const event = detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 0, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    expect(event).toBeNull();
  });

  // --- Microcompaction false positive suppression ---
  // (Same mechanism, scenario-named for clarity)

  it("microcompaction-triggered notifyContentModification suppresses false positive", () => {
    establishBaseline();
    // Microcompaction offloads content -- same mechanism as masking
    detector.notifyContentModification("test-session");
    const event = detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 25000, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    expect(event).toBeNull();
  });

  // --- Genuine break detection with content modification ---

  it("notifyContentModification + systemChanged returns CacheBreakEvent with reason system_changed", () => {
    establishBaseline();
    // Record state with changed system hash
    detector.recordPromptState(makeBaseInput({ systemHash: 99999 }));
    detector.notifyContentModification("test-session");
    const event = detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 30000, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    expect(event).not.toBeNull();
    expect(event!.reason).toBe("system_changed");
  });

  it("notifyContentModification + toolsChanged returns CacheBreakEvent with reason tools_changed", () => {
    establishBaseline();
    detector.recordPromptState(makeBaseInput({
      toolNames: ["bash", "file_read", "web_search"],
      perToolHashes: { bash: 111, file_read: 222, web_search: 333 },
      toolsHash: 99999, // must change toolsHash to trigger per-tool diff
    }));
    detector.notifyContentModification("test-session");
    const event = detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 30000, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    expect(event).not.toBeNull();
    expect(event!.reason).toBe("tools_changed");
  });

  it("notifyContentModification + modelChanged returns CacheBreakEvent with reason model_changed", () => {
    establishBaseline();
    detector.recordPromptState(makeBaseInput({ model: "claude-opus-4-5" }));
    detector.notifyContentModification("test-session");
    const event = detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 30000, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    expect(event).not.toBeNull();
    expect(event!.reason).toBe("model_changed");
  });

  it("notifyContentModification + retentionChanged returns CacheBreakEvent with reason retention_changed", () => {
    establishBaseline();
    detector.recordPromptState(makeBaseInput({ retention: "long" }));
    detector.notifyContentModification("test-session");
    const event = detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 30000, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    expect(event).not.toBeNull();
    expect(event!.reason).toBe("retention_changed");
  });

  it("notifyContentModification + metadataChanged returns CacheBreakEvent with reason cache_metadata_changed", () => {
    establishBaseline();
    detector.recordPromptState(makeBaseInput({ cacheMetadataHash: 55555 }));
    detector.notifyContentModification("test-session");
    const event = detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 30000, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    expect(event).not.toBeNull();
    expect(event!.reason).toBe("cache_metadata_changed");
  });

  // --- Regression tests ---

  it("without notifyContentModification, a real token drop still emits CacheBreakEvent (no false suppression)", () => {
    establishBaseline();
    // Do NOT call notifyContentModification
    const event = detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 0, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    // No content modification notification, so normal detection path applies
    expect(event).not.toBeNull();
    expect(event!.reason).toBe("server_eviction");
  });

  it("contentModified flag is consumed after one checkResponseForCacheBreak call", () => {
    establishBaseline();
    detector.notifyContentModification("test-session");
    // First check -- contentModified consumed, suppresses
    detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 30000, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    // Record same state again for next cycle
    detector.recordPromptState(makeBaseInput());
    // Second check -- contentModified already consumed, should NOT suppress
    const event = detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 0, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    expect(event).not.toBeNull();
    expect(event!.reason).toBe("server_eviction");
  });
});

// ---------------------------------------------------------------------------
// Detector integration for header / extra-body changes
// (extractor-only header / extraBody assertions live in
//  anthropic-extractor.test.ts)
// ---------------------------------------------------------------------------

describe("attributeReason priority for headers/extra-body", () => {
  let detector: CacheBreakDetector;

  beforeEach(() => {
    detector = createCacheBreakDetector(noopLogger, { clock: testClock });
    detector.reset();
  });

  function triggerBreakWithChanges(changes: Partial<RecordPromptStateInput>): CacheBreakEvent | null {
    detector.recordPromptState(makeBaseInput());
    detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000 });
    detector.recordPromptState(makeBaseInput(changes));
    return detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 0, cacheWriteTokens: 0, totalInputTokens: 60000 });
  }

  it("attributeReason returns headers_changed when headersChanged is true", () => {
    const event = triggerBreakWithChanges({ headersHash: 99999 });
    expect(event).not.toBeNull();
    expect(event!.reason).toBe("headers_changed");
  });

  it("attributeReason returns extra_body_changed when extraBodyChanged is true", () => {
    const event = triggerBreakWithChanges({ extraBodyHash: 88888 });
    expect(event).not.toBeNull();
    expect(event!.reason).toBe("extra_body_changed");
  });

  it("headers_changed has lower priority than cache_metadata_changed", () => {
    const event = triggerBreakWithChanges({ cacheMetadataHash: 55555, headersHash: 99999 });
    expect(event).not.toBeNull();
    expect(event!.reason).toBe("cache_metadata_changed");
  });

  it("extra_body_changed has lower priority than headers_changed", () => {
    const event = triggerBreakWithChanges({ headersHash: 99999, extraBodyHash: 88888 });
    expect(event).not.toBeNull();
    expect(event!.reason).toBe("headers_changed");
  });

  it("headers_changed has higher priority than ttl_expiry", () => {
    detector.recordPromptState(makeBaseInput());
    detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000 });
    detector.notifyTtlExpiry("test-session");
    detector.recordPromptState(makeBaseInput({ headersHash: 99999 }));
    const event = detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 0, cacheWriteTokens: 0, totalInputTokens: 60000 });
    expect(event).not.toBeNull();
    expect(event!.reason).toBe("headers_changed");
  });
});

describe("detector integration for headers/extra-body reasons", () => {
  let detector: CacheBreakDetector;

  beforeEach(() => {
    detector = createCacheBreakDetector(noopLogger, { clock: testClock });
    detector.reset();
  });

  it("detector emits headers_changed when header hash differs between turns", () => {
    // Turn 1: no headers hash
    detector.recordPromptState(makeBaseInput({ headersHash: null }));
    detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000 });
    // Turn 2: headers hash present (changed)
    detector.recordPromptState(makeBaseInput({ headersHash: 12345 }));
    const event = detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 0, cacheWriteTokens: 0, totalInputTokens: 60000 });
    expect(event).not.toBeNull();
    expect(event!.reason).toBe("headers_changed");
    expect(event!.changes.headersChanged).toBe(true);
  });

  it("detector emits extra_body_changed when extra body hash differs between turns", () => {
    // Turn 1: no extra body
    detector.recordPromptState(makeBaseInput({ extraBodyHash: null }));
    detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000 });
    // Turn 2: extra body hash present
    detector.recordPromptState(makeBaseInput({ extraBodyHash: 54321 }));
    const event = detector.checkResponseForCacheBreak({ sessionKey: "test-session", provider: "anthropic", cacheReadTokens: 0, cacheWriteTokens: 0, totalInputTokens: 60000 });
    expect(event).not.toBeNull();
    expect(event!.reason).toBe("extra_body_changed");
    expect(event!.changes.extraBodyChanged).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// LRU-bounded tracking
// ---------------------------------------------------------------------------

describe("LRU-bounded tracking", () => {
  let detector: CacheBreakDetector;

  beforeEach(() => {
    detector = createCacheBreakDetector(noopLogger, { clock: testClock });
    detector.reset();
  });

  it("when 16th unique sessionKey is recorded, the least-recently-used entry is evicted (map size stays at 15)", () => {
    // Record state for 15 sessions
    for (let i = 1; i <= 15; i++) {
      detector.recordPromptState(makeBaseInput({ sessionKey: `session-${i}` }));
      detector.checkResponseForCacheBreak({
        sessionKey: `session-${i}`, provider: "anthropic",
        cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000,
      });
    }

    // Record a 16th session -- should evict session-1 (LRU)
    detector.recordPromptState(makeBaseInput({ sessionKey: "session-16" }));
    detector.checkResponseForCacheBreak({
      sessionKey: "session-16", provider: "anthropic",
      cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000,
    });

    // session-1 should be evicted: checkResponseForCacheBreak returns null (no state)
    const event = detector.checkResponseForCacheBreak({
      sessionKey: "session-1", provider: "anthropic",
      cacheReadTokens: 0, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    expect(event).toBeNull();

    // session-2 should still be present
    detector.recordPromptState(makeBaseInput({ sessionKey: "session-2" }));
    const event2 = detector.checkResponseForCacheBreak({
      sessionKey: "session-2", provider: "anthropic",
      cacheReadTokens: 0, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    expect(event2).not.toBeNull();
  });

  it("accessing an entry via recordPromptState moves it to most-recently-used (not evicted)", () => {
    // Record state for 15 sessions
    for (let i = 1; i <= 15; i++) {
      detector.recordPromptState(makeBaseInput({ sessionKey: `session-${i}` }));
    }

    // Touch session-1 to make it most-recently-used
    detector.recordPromptState(makeBaseInput({ sessionKey: "session-1" }));

    // Add 2 new sessions to evict the 2 oldest non-touched entries (session-2 and session-3)
    detector.recordPromptState(makeBaseInput({ sessionKey: "session-16" }));
    detector.recordPromptState(makeBaseInput({ sessionKey: "session-17" }));

    // session-1 was touched, should still exist (returns non-null on checkResponse after baseline)
    detector.checkResponseForCacheBreak({
      sessionKey: "session-1", provider: "anthropic",
      cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    detector.recordPromptState(makeBaseInput({ sessionKey: "session-1" }));
    const event = detector.checkResponseForCacheBreak({
      sessionKey: "session-1", provider: "anthropic",
      cacheReadTokens: 0, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    expect(event).not.toBeNull();

    // session-2 should have been evicted
    const evicted = detector.checkResponseForCacheBreak({
      sessionKey: "session-2", provider: "anthropic",
      cacheReadTokens: 0, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    expect(evicted).toBeNull();
  });

  it("cleanupSession on an evicted key does not throw", () => {
    // Record 16 sessions to evict session-1
    for (let i = 1; i <= 16; i++) {
      detector.recordPromptState(makeBaseInput({ sessionKey: `session-${i}` }));
    }
    // session-1 is evicted; cleanupSession should not throw
    expect(() => detector.cleanupSession("session-1")).not.toThrow();
  });

  it("reset() clears all entries and LRU order", () => {
    for (let i = 1; i <= 10; i++) {
      detector.recordPromptState(makeBaseInput({ sessionKey: `session-${i}` }));
    }
    detector.reset();
    // After reset, all sessions should be gone
    const event = detector.checkResponseForCacheBreak({
      sessionKey: "session-1", provider: "anthropic",
      cacheReadTokens: 0, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    expect(event).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// model exclusion
// ---------------------------------------------------------------------------

describe("model exclusion", () => {
  let detector: CacheBreakDetector;

  beforeEach(() => {
    detector = createCacheBreakDetector(noopLogger, { clock: testClock });
    detector.reset();
  });

  it("checkResponseForCacheBreak returns null when model contains 'haiku' (e.g., 'claude-3-haiku-20240307')", () => {
    detector.recordPromptState(makeBaseInput({ model: "claude-3-haiku-20240307" }));
    detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic",
      cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    detector.recordPromptState(makeBaseInput({ model: "claude-3-haiku-20240307" }));
    // Token drop from 50000 -> 0 would normally trigger a break
    const event = detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic",
      cacheReadTokens: 0, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    expect(event).toBeNull();
  });

  it("checkResponseForCacheBreak returns null when model is 'claude-3-5-haiku-20241022'", () => {
    detector.recordPromptState(makeBaseInput({ model: "claude-3-5-haiku-20241022" }));
    detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic",
      cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    detector.recordPromptState(makeBaseInput({ model: "claude-3-5-haiku-20241022" }));
    const event = detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic",
      cacheReadTokens: 0, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    expect(event).toBeNull();
  });

  it("checkResponseForCacheBreak still detects breaks for non-haiku models (e.g., 'claude-sonnet-4-5')", () => {
    detector.recordPromptState(makeBaseInput({ model: "claude-sonnet-4-5" }));
    detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic",
      cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    detector.recordPromptState(makeBaseInput({ model: "claude-sonnet-4-5" }));
    const event = detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic",
      cacheReadTokens: 0, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    expect(event).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// tiered server-side attribution
// ---------------------------------------------------------------------------

describe("tiered server-side attribution", () => {
  let detector: CacheBreakDetector;

  beforeEach(() => {
    detector = createCacheBreakDetector(noopLogger, { clock: testClock });
    detector.reset();
  });

  function triggerBreakNoChanges(lastResponseElapsedMs?: number): CacheBreakEvent | null {
    detector.recordPromptState(makeBaseInput());
    detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic",
      cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    detector.recordPromptState(makeBaseInput());
    return detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic",
      cacheReadTokens: 0, cacheWriteTokens: 0, totalInputTokens: 60000,
      lastResponseElapsedMs,
    });
  }

  it("when no pending changes and lastResponseElapsedMs > 3,600,000 (60min), reason is 'ttl_expiry_long'", () => {
    const event = triggerBreakNoChanges(3_600_001);
    expect(event).not.toBeNull();
    expect(event!.reason).toBe("ttl_expiry_long");
  });

  it("when no pending changes and lastResponseElapsedMs > 300,000 (5min) but < 3,600,000, reason is 'ttl_expiry_short'", () => {
    const event = triggerBreakNoChanges(300_001);
    expect(event).not.toBeNull();
    expect(event!.reason).toBe("ttl_expiry_short");
  });

  it("when no pending changes and lastResponseElapsedMs < 300,000, reason is 'likely_server_eviction'", () => {
    const event = triggerBreakNoChanges(60_000);
    expect(event).not.toBeNull();
    expect(event!.reason).toBe("likely_server_eviction");
  });

  it("when no pending changes and lastResponseElapsedMs is undefined (cold start), reason is 'server_eviction' (fallback)", () => {
    const event = triggerBreakNoChanges(undefined);
    expect(event).not.toBeNull();
    expect(event!.reason).toBe("server_eviction");
  });

  it("tiered attribution does NOT apply when there ARE pending changes (systemChanged returns 'system_changed')", () => {
    detector.recordPromptState(makeBaseInput());
    detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic",
      cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    detector.recordPromptState(makeBaseInput({ systemHash: 99999 }));
    const event = detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic",
      cacheReadTokens: 0, cacheWriteTokens: 0, totalInputTokens: 60000,
      lastResponseElapsedMs: 3_600_001, // Would be ttl_expiry_long if no changes
    });
    expect(event).not.toBeNull();
    expect(event!.reason).toBe("system_changed");
  });
});

// ---------------------------------------------------------------------------
// lookback-aware cache break attribution
// ---------------------------------------------------------------------------

describe("lookback-aware cache break attribution", () => {
  let detector: CacheBreakDetector;

  beforeEach(() => {
    detector = createCacheBreakDetector(noopLogger, { clock: testClock });
    detector.reset();
  });

  function triggerBreakWithBlockCount(
    messageBlockCount: number,
    lastResponseElapsedMs?: number,
  ): CacheBreakEvent | null {
    detector.recordPromptState(makeBaseInput());
    detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic",
      cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    // Record same state (no changes)
    detector.recordPromptState(makeBaseInput());
    return detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic",
      cacheReadTokens: 0, cacheWriteTokens: 0, totalInputTokens: 60000,
      lastResponseElapsedMs,
      messageBlockCount,
    });
  }

  it("returns 'lookback_window_exceeded' when conversation > 20 blocks and elapsed < TTL_SHORT (5min)", () => {
    const event = triggerBreakWithBlockCount(25, 60_000); // 1 min elapsed, 25 blocks
    expect(event).not.toBeNull();
    expect(event!.reason).toBe("lookback_window_exceeded");
  });

  it("returns 'likely_server_eviction' when conversation <= 20 blocks", () => {
    const event = triggerBreakWithBlockCount(15, 60_000); // 1 min elapsed, 15 blocks
    expect(event).not.toBeNull();
    expect(event!.reason).toBe("likely_server_eviction");
  });

  it("returns 'lookback_window_exceeded' for exactly 21 blocks (boundary)", () => {
    const event = triggerBreakWithBlockCount(21, 60_000);
    expect(event).not.toBeNull();
    expect(event!.reason).toBe("lookback_window_exceeded");
  });

  it("returns 'likely_server_eviction' for exactly 20 blocks (boundary)", () => {
    const event = triggerBreakWithBlockCount(20, 60_000);
    expect(event).not.toBeNull();
    expect(event!.reason).toBe("likely_server_eviction");
  });

  it("includes conversationBlockCount in event when lookback detected", () => {
    const event = triggerBreakWithBlockCount(30, 60_000);
    expect(event).not.toBeNull();
    expect(event!.conversationBlockCount).toBe(30);
  });

  it("defaults to 0 block count when messageBlockCount not provided", () => {
    // No messageBlockCount provided, should fall through to likely_server_eviction
    detector.recordPromptState(makeBaseInput());
    detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic",
      cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    detector.recordPromptState(makeBaseInput());
    const event = detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic",
      cacheReadTokens: 0, cacheWriteTokens: 0, totalInputTokens: 60000,
      lastResponseElapsedMs: 60_000,
      // messageBlockCount intentionally omitted
    });
    expect(event).not.toBeNull();
    expect(event!.reason).toBe("likely_server_eviction");
  });

  it("returns 'ttl_expiry_short' when > 20 blocks but elapsed > TTL_SHORT (lookback requires elapsed <= TTL_SHORT)", () => {
    // elapsed 6 min > TTL_SHORT=5min, even with > 20 blocks, should be ttl_expiry_short not lookback
    const event = triggerBreakWithBlockCount(25, 301_000);
    expect(event).not.toBeNull();
    expect(event!.reason).toBe("ttl_expiry_short");
  });
});

// ---------------------------------------------------------------------------
// effort value tracking (detector integration)
// ---------------------------------------------------------------------------

describe("effort value tracking", () => {
  let detector: CacheBreakDetector;

  beforeEach(() => {
    detector = createCacheBreakDetector(noopLogger, { clock: testClock });
    detector.reset();
  });

  it("when effortValue changes between turns, buildPendingChanges sets effortChanged: true", () => {
    // Turn 1: no effort value
    detector.recordPromptState(makeBaseInput());
    detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic",
      cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    // Turn 2: effort value set
    detector.recordPromptState(makeBaseInput({ effortValue: '{"type":"enabled","budget_tokens":1024}' }));
    const event = detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic",
      cacheReadTokens: 0, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    expect(event).not.toBeNull();
    expect(event!.changes.effortChanged).toBe(true);
  });

  it("when effortChanged is true, attributeReason returns effort_changed", () => {
    detector.recordPromptState(makeBaseInput());
    detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic",
      cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    detector.recordPromptState(makeBaseInput({ effortValue: '{"type":"enabled","budget_tokens":1024}' }));
    const event = detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic",
      cacheReadTokens: 0, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    expect(event).not.toBeNull();
    expect(event!.reason).toBe("effort_changed");
  });

  it("effort_changed has lower priority than extra_body_changed", () => {
    detector.recordPromptState(makeBaseInput());
    detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic",
      cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    detector.recordPromptState(makeBaseInput({
      extraBodyHash: 88888,
      effortValue: '{"type":"enabled","budget_tokens":2048}',
    }));
    const event = detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic",
      cacheReadTokens: 0, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    expect(event).not.toBeNull();
    expect(event!.reason).toBe("extra_body_changed");
  });

  it("effort_changed has higher priority than cache_control_changed", () => {
    detector.recordPromptState(makeBaseInput());
    detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic",
      cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    detector.recordPromptState(makeBaseInput({
      effortValue: '{"type":"enabled","budget_tokens":2048}',
      cacheControlHash: 99999,
    }));
    const event = detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic",
      cacheReadTokens: 0, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    expect(event).not.toBeNull();
    expect(event!.reason).toBe("effort_changed");
  });

  it("CacheBreakEvent includes effortValue from current snapshot when break detected", () => {
    const effortStr = '{"type":"enabled","budget_tokens":4096}';
    detector.recordPromptState(makeBaseInput());
    detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic",
      cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    detector.recordPromptState(makeBaseInput({ effortValue: effortStr }));
    const event = detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic",
      cacheReadTokens: 0, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    expect(event).not.toBeNull();
    expect(event!.effortValue).toBe(effortStr);
  });
});

// ---------------------------------------------------------------------------
// cacheControlHash tracking (detector integration)
// ---------------------------------------------------------------------------

describe("cacheControlHash detector integration", () => {
  let detector: CacheBreakDetector;

  beforeEach(() => {
    detector = createCacheBreakDetector(noopLogger, { clock: testClock });
    detector.reset();
  });

  it("when cacheControlChanged is true, buildPendingChanges sets cacheControlChanged: true", () => {
    detector.recordPromptState(makeBaseInput());
    detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic",
      cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    detector.recordPromptState(makeBaseInput({ cacheControlHash: 99999 }));
    const event = detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic",
      cacheReadTokens: 0, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    expect(event).not.toBeNull();
    expect(event!.changes.cacheControlChanged).toBe(true);
  });

  it("when cacheControlChanged is true, attributeReason returns cache_control_changed", () => {
    detector.recordPromptState(makeBaseInput());
    detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic",
      cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    detector.recordPromptState(makeBaseInput({ cacheControlHash: 99999 }));
    const event = detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic",
      cacheReadTokens: 0, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    expect(event).not.toBeNull();
    expect(event!.reason).toBe("cache_control_changed");
  });

  it("cache_control_changed has lower priority than effort_changed", () => {
    detector.recordPromptState(makeBaseInput());
    detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic",
      cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    detector.recordPromptState(makeBaseInput({
      effortValue: '{"type":"enabled"}',
      cacheControlHash: 99999,
    }));
    const event = detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic",
      cacheReadTokens: 0, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    expect(event).not.toBeNull();
    expect(event!.reason).toBe("effort_changed");
  });

  it("cache_control_changed has higher priority than ttl_expiry", () => {
    detector.recordPromptState(makeBaseInput());
    detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic",
      cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    detector.notifyTtlExpiry("test-session");
    detector.recordPromptState(makeBaseInput({ cacheControlHash: 99999 }));
    const event = detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic",
      cacheReadTokens: 0, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    expect(event).not.toBeNull();
    expect(event!.reason).toBe("cache_control_changed");
  });
});

// ---------------------------------------------------------------------------
// lazy buildDiffableContent (detector integration)
// ---------------------------------------------------------------------------

describe("lazy buildDiffableContent detector integration", () => {
  let detector: CacheBreakDetector;

  beforeEach(() => {
    detector = createCacheBreakDetector(noopLogger, { clock: testClock });
    detector.reset();
  });

  it("when no cache break detected (tokenDrop <= 0), buildDiffableContent getter is never called", () => {
    const mockGetter = vi.fn().mockReturnValue({ system: "test", tools: "test" });
    // Record turn 1 with the spy getter
    detector.recordPromptState(makeBaseInput({ buildDiffableContent: mockGetter }));
    // Set baseline
    detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic",
      cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    // Record turn 2 with the spy getter
    detector.recordPromptState(makeBaseInput({ buildDiffableContent: mockGetter }));
    // No drop (50000 -> 55000 = increase, not drop)
    detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic",
      cacheReadTokens: 55000, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    expect(mockGetter).not.toHaveBeenCalled();
  });

  it("CacheBreakEvent has previousSystem/currentSystem/previousTools/currentTools from lazy getter when break IS detected", () => {
    const getter1 = () => ({ system: "old system", tools: "old tools" });
    const getter2 = () => ({ system: "new system", tools: "new tools" });

    detector.recordPromptState(makeBaseInput({ buildDiffableContent: getter1 }));
    detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic",
      cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    detector.recordPromptState(makeBaseInput({
      systemHash: 99999,
      buildDiffableContent: getter2,
    }));
    const event = detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic",
      cacheReadTokens: 0, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    expect(event).not.toBeNull();
    expect(event!.previousSystem).toBe("old system");
    expect(event!.previousTools).toBe("old tools");
    expect(event!.currentSystem).toBe("new system");
    expect(event!.currentTools).toBe("new tools");
  });
});

// ---------------------------------------------------------------------------
// aliasSession
// ---------------------------------------------------------------------------

describe("aliasSession", () => {
  let detector: CacheBreakDetector;

  beforeEach(() => {
    detector = createCacheBreakDetector(noopLogger, { clock: testClock });
    detector.reset();
  });

  it("redirects compaction key lookups to parent state -- recordPromptState with compaction key updates parent", () => {
    // Record state under parent key
    detector.recordPromptState(makeBaseInput({ sessionKey: "parent-key" }));
    detector.checkResponseForCacheBreak({
      sessionKey: "parent-key", provider: "anthropic",
      cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000,
    });

    // Alias compaction key to parent key
    detector.aliasSession("compaction-key", "parent-key");

    // Record state under compaction key -- should update parent's DetectorState
    detector.recordPromptState(makeBaseInput({ sessionKey: "compaction-key", systemHash: 99999 }));

    // Check for break under compaction key -- should see the system change relative to parent baseline
    const event = detector.checkResponseForCacheBreak({
      sessionKey: "compaction-key", provider: "anthropic",
      cacheReadTokens: 0, cacheWriteTokens: 0, totalInputTokens: 60000,
    });

    expect(event).not.toBeNull();
    expect(event!.reason).toBe("system_changed");
  });

  it("is a no-op when parentKey has no state -- no error, no state created", () => {
    // Call aliasSession with a parent that has no state -- should not throw
    expect(() => detector.aliasSession("compaction-key", "nonexistent-parent")).not.toThrow();

    // Verify no state was created for the compaction key
    const event = detector.checkResponseForCacheBreak({
      sessionKey: "compaction-key", provider: "anthropic",
      cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    expect(event).toBeNull();
  });

  it("checkResponseForCacheBreak after compaction-to-main transition does not produce false break when aliased", () => {
    // Set up parent session with stable cache reads
    detector.recordPromptState(makeBaseInput({ sessionKey: "parent-key" }));
    detector.checkResponseForCacheBreak({
      sessionKey: "parent-key", provider: "anthropic",
      cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000,
    });

    // Alias compaction key
    detector.aliasSession("compaction-key", "parent-key");

    // Notify compaction (resets baseline)
    detector.notifyCompaction("compaction-key");

    // Record same state under compaction key (no actual changes)
    detector.recordPromptState(makeBaseInput({ sessionKey: "compaction-key" }));

    // After compaction, baseline resets -- no false break
    const event = detector.checkResponseForCacheBreak({
      sessionKey: "compaction-key", provider: "anthropic",
      cacheReadTokens: 30000, cacheWriteTokens: 5000, totalInputTokens: 60000,
    });
    expect(event).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// API error suppression
// ---------------------------------------------------------------------------

describe("API error suppression", () => {
  let detector: CacheBreakDetector;

  beforeEach(() => {
    detector = createCacheBreakDetector(noopLogger, { clock: testClock });
    detector.reset();
  });

  /** Establish a 50K cache_read baseline over 2 calls. */
  function establishBaseline(): void {
    detector.recordPromptState(makeBaseInput());
    // First call: establishes baseline
    detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic",
      cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    // Second call with same tokens: no break
    detector.recordPromptState(makeBaseInput());
  }

  it("checkResponseForCacheBreak with apiError=true returns null (no break event emitted)", () => {
    establishBaseline();
    const event = detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic",
      cacheReadTokens: 0, cacheWriteTokens: 0, totalInputTokens: 0,
      apiError: true,
    });
    expect(event).toBeNull();
  });

  it("checkResponseForCacheBreak with apiError=true does NOT update previousCacheReadTokens (baseline preserved)", () => {
    establishBaseline();
    // API error with zero tokens -- should NOT update baseline
    detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic",
      cacheReadTokens: 0, cacheWriteTokens: 0, totalInputTokens: 0,
      apiError: true,
    });
    // Next successful call with same tokens as original baseline -- no drop, no break
    detector.recordPromptState(makeBaseInput());
    const event = detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic",
      cacheReadTokens: 50000, cacheWriteTokens: 0, totalInputTokens: 60000,
    });
    expect(event).toBeNull();
  });

  it("API error then recovery -- no false break on return to previous cache level", () => {
    establishBaseline();
    // API error turn with 0 tokens
    detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic",
      cacheReadTokens: 0, cacheWriteTokens: 0, totalInputTokens: 0,
      apiError: true,
    });
    // Recovery: back to normal cache_read (slightly higher due to new content)
    detector.recordPromptState(makeBaseInput());
    const event = detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic",
      cacheReadTokens: 52000, cacheWriteTokens: 1000, totalInputTokens: 60000,
    });
    // Should NOT be a break -- cache_read went UP from 50K baseline
    expect(event).toBeNull();
  });

  it("API error then real eviction -- genuine cache miss IS detected after recovery", () => {
    establishBaseline();
    // API error turn
    detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic",
      cacheReadTokens: 0, cacheWriteTokens: 0, totalInputTokens: 0,
      apiError: true,
    });
    // Recovery with genuine cache miss (only 5K of 50K cached)
    detector.recordPromptState(makeBaseInput());
    const event = detector.checkResponseForCacheBreak({
      sessionKey: "test-session", provider: "anthropic",
      cacheReadTokens: 5000, cacheWriteTokens: 45000, totalInputTokens: 60000,
    });
    // Should be a break: 50K -> 5K = 45K drop (90% relative, 45K absolute)
    expect(event).not.toBeNull();
    expect(event!.tokenDrop).toBe(45000);
    expect(event!.previousCacheRead).toBe(50000);
    expect(event!.currentCacheRead).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// LRU eviction warning + configurable MAX_TRACKING_ENTRIES
// ---------------------------------------------------------------------------

describe("cache break detector LRU eviction warning", () => {
  it("logs WARN when evicting oldest session from tracking map", () => {
    const warnSpy = vi.fn();
    const logger = {
      debug: () => {},
      info: () => {},
      warn: warnSpy,
    };
    // Use small maxTrackingEntries for testing
    const detector = createCacheBreakDetector(logger, { maxTrackingEntries: 3, clock: testClock });

    // Fill up to capacity
    detector.recordPromptState(makeBaseInput({ sessionKey: "session-1" }));
    detector.recordPromptState(makeBaseInput({ sessionKey: "session-2" }));
    detector.recordPromptState(makeBaseInput({ sessionKey: "session-3" }));

    expect(warnSpy).not.toHaveBeenCalled();

    // Adding 4th should evict session-1 and log WARN
    detector.recordPromptState(makeBaseInput({ sessionKey: "session-4" }));

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][1]).toMatch(/LRU eviction/);
  });

  it("MAX_TRACKING_ENTRIES can be overridden via options parameter", () => {
    const warnSpy = vi.fn();
    const logger = { debug: () => {}, info: () => {}, warn: warnSpy };
    const detector = createCacheBreakDetector(logger, { maxTrackingEntries: 2, clock: testClock });

    detector.recordPromptState(makeBaseInput({ sessionKey: "s1" }));
    detector.recordPromptState(makeBaseInput({ sessionKey: "s2" }));

    // No warn yet
    expect(warnSpy).not.toHaveBeenCalled();

    // 3rd session triggers eviction
    detector.recordPromptState(makeBaseInput({ sessionKey: "s3" }));
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it("default MAX_TRACKING_ENTRIES is 15", () => {
    expect(MAX_TRACKING_ENTRIES).toBe(15);
  });
});

// Sentinel: ensure the imported fixtureParams and extractAnthropicPromptState
// reference is consumed — pins that the Anthropic extractor's output shape
// composes with the detector's RecordPromptStateInput.
const _crossCheck = extractAnthropicPromptState(fixtureParams, "claude-sonnet-4-5", "short", "sess-1", "agent-1");
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _ensureUsed: unknown = _crossCheck;
