// SPDX-License-Identifier: Apache-2.0
/**
 * The VERIFY-ONLY cache-stack assertion (the "do-not-rebuild" guard).
 *
 * The multi-zone cache strategy, cache-break attribution, adaptive/monotonic TTL,
 * defer-recall, and strip-thinking are SHIPPED machinery this file ASSERTS — it does not
 * re-implement them. This file is that assertion: it imports each stabilizer and
 * makes a minimal behavioral check so a future refactor that DELETES or RENAMES a
 * stabilizer trips a named failing test
 * rather than silently dropping a load-bearing cache-stability control.
 *
 * It ALSO pins the cooperation invariant of the every-turn microcompact
 * pass: `runEveryTurnMicrocompact` must signal `onContentModification` when
 * it clears (so the cache-break detector attributes the change as DELIBERATE, not
 * a cache bust) and must NOT call `onAdaptiveRetentionReset` (the warm-cache rule,
 * mirroring `runTokenCeilingMicrocompact`). The every-turn pass cooperates with —
 * never bypasses — the verify-only stack.
 *
 * This is a guard/assertion test. If an import
 * fails to resolve or a behavioral check fails, that is a regression in the shipped
 * stack (or the every-turn wiring) to fix, not a license to rebuild here.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import type { ClockPort } from "@comis/core";

// --- The verify-only stabilizers, each imported at its canonical name. ---
import {
  createAdaptiveCacheRetention,
  createStaticRetention,
  PREFIX_INSTABILITY_THRESHOLD,
} from "../../adaptive-cache-retention.js";
import {
  recordLastResponseTs,
  getElapsedSinceLastResponse,
  clearSessionLastResponseTs,
} from "../../ttl-guard.js";
import {
  createCacheBreakDetector,
  clearCacheBreakDetectorSession,
} from "../../cache-detection/index.js";
import {
  createBlockStabilityTracker,
  clearSessionBlockStability,
} from "../../block-stability-tracker.js";
import { buildDiffableContent } from "../../cache-break-diff-writer.js";
import {
  stripReplayThinking,
  stripTransientRecallFromHistory,
  deferRecallToUncachedTail,
} from "./tool-result-clearing.js";

// --- The every-turn microcompact pass whose cooperation with the stack we pin. ---
import { runEveryTurnMicrocompact } from "./microcompact.js";
import { createMockLogger } from "../__test-helpers/index.js";
import type { RequestBodyInjectorConfig } from "./types.js";

/** A deterministic, advanceable stub clock for the time-keyed stabilizers. */
function makeStubClock(start = 1_700_000_000_000): { clock: ClockPort; advance: (ms: number) => void } {
  let nowMs = start;
  const clock = { now: () => nowMs, monotonicNow: () => nowMs } as unknown as ClockPort;
  return { clock, advance: (ms: number) => { nowMs += ms; } };
}

describe("verify-only cache stack is present and unbroken (do-not-rebuild guard)", () => {
  it("adaptive-cache-retention escalates cold→warm on confirmed reads + turns, and resets", () => {
    // The adaptive retention starts cold ("short") and escalates to warm ("long")
    // once enough turns + cache reads confirm a warm cache — the multi-zone retention
    // signal placeCacheBreakpoints consumes. reset() returns it to cold-start.
    const retention = createAdaptiveCacheRetention({
      coldStartRetention: "short",
      warmRetention: "long",
      escalationThreshold: 1000,
      escalationTurnThreshold: 3,
    });
    expect(retention.getRetention()).toBe("short");
    expect(retention.hasEscalated()).toBe(false);
    retention.recordCacheReads(5000);
    for (let i = 0; i < 3; i++) retention.recordTurn();
    expect(retention.getRetention()).toBe("long");
    expect(retention.hasEscalated()).toBe(true);
    retention.reset();
    expect(retention.getRetention()).toBe("short");
  });

  it("adaptive-cache-retention prefix-instability forces retention back to short (monotonic-safety)", () => {
    // When cache reads stay stuck at the system-prompt baseline for
    // PREFIX_INSTABILITY_THRESHOLD consecutive turns, the prefix is unstable and
    // 1h writes are wasted — retention is forced back to "short". Pin both the
    // exported threshold and the downgrade behavior.
    expect(PREFIX_INSTABILITY_THRESHOLD).toBeGreaterThan(0);
    const retention = createAdaptiveCacheRetention({
      coldStartRetention: "short",
      warmRetention: "long",
      escalationThreshold: 1000,
      escalationTurnThreshold: 1,
    });
    retention.recordCacheReads(5000);
    retention.recordTurn();
    expect(retention.getRetention()).toBe("long");
    // Baseline-only reads for the full threshold window force it back to short.
    let forced = false;
    for (let i = 0; i < PREFIX_INSTABILITY_THRESHOLD; i++) {
      forced = retention.recordCacheReadForStability(1000, 1000);
    }
    expect(forced).toBe(true);
    expect(retention.getRetention()).toBe("short");
  });

  it("createStaticRetention pins a fixed retention that never escalates", () => {
    const stat = createStaticRetention("long");
    expect(stat.getRetention()).toBe("long");
    stat.recordCacheReads(99_999);
    stat.recordTurn();
    expect(stat.hasEscalated()).toBe(false);
    expect(stat.getRetention()).toBe("long");
  });

  it("ttl-guard records + reports elapsed-since-last-response off the injected clock (monotonic TTL)", () => {
    const sessionKey = "verify-ttl-session";
    const { clock, advance } = makeStubClock();
    try {
      expect(getElapsedSinceLastResponse(sessionKey, clock)).toBeUndefined(); // cold-start
      recordLastResponseTs(sessionKey, "long", clock);
      advance(300_000); // 5 minutes
      expect(getElapsedSinceLastResponse(sessionKey, clock)).toBe(300_000);
    } finally {
      clearSessionLastResponseTs(sessionKey);
    }
  });

  it("cache-break detector exposes notifyContentModification — the deliberate-change attribution the every-turn pass rides", () => {
    // The cache-break detector is the attribution engine: a deliberate content
    // modification (microcompaction / observation masking) must be announced via
    // notifyContentModification so the NEXT response is not flagged as a cache bust.
    // Assert the detector constructs + exposes that entrypoint (the seam the every-turn pass uses).
    const sessionKey = "verify-detector-session";
    const eventBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() } as unknown as Parameters<
      typeof createCacheBreakDetector
    >[0];
    const { clock } = makeStubClock();
    try {
      const detector = createCacheBreakDetector(eventBus, { clock });
      expect(typeof detector.notifyContentModification).toBe("function");
      expect(typeof detector.notifyTtlExpiry).toBe("function");
      expect(typeof detector.checkResponseForCacheBreak).toBe("function");
      // Calling it for an unknown session is a safe no-op (no throw) — the
      // deliberate-modification signal precedes the first recorded state.
      expect(() => detector.notifyContentModification(sessionKey)).not.toThrow();
    } finally {
      clearCacheBreakDetectorSession(sessionKey);
    }
  });

  it("block-stability-tracker counts consecutive identical zone hashes to a stability threshold", () => {
    const tracker = createBlockStabilityTracker();
    const sessionKey = "verify-stability-session";
    try {
      tracker.recordZoneHash(sessionKey, "system", 12345);
      expect(tracker.isStable(sessionKey, "system", 2)).toBe(false); // 1 occurrence
      tracker.recordZoneHash(sessionKey, "system", 12345);
      expect(tracker.isStable(sessionKey, "system", 2)).toBe(true); // 2 consecutive
      // A changed hash resets the consecutive count.
      tracker.recordZoneHash(sessionKey, "system", 99999);
      expect(tracker.isStable(sessionKey, "system", 2)).toBe(false);
    } finally {
      clearSessionBlockStability(sessionKey);
    }
  });

  it("cache-break-diff-writer builds a deterministic system+tools diff blob", () => {
    // The diff writer is the cache-break attribution artifact — it must keep
    // building a stable, model-tagged system/tools blob for the diff file.
    const blob = buildDiffableContent("SYS-PROMPT", "TOOLS-DEF", "claude-test");
    expect(blob).toContain("Model: claude-test");
    expect(blob).toContain("=== System Prompt ===");
    expect(blob).toContain("SYS-PROMPT");
    expect(blob).toContain("=== Tools ===");
    expect(blob).toContain("TOOLS-DEF");
  });

  it("strip-thinking removes non-redacted thinking blocks from assistant messages", () => {
    const messages: Array<Record<string, unknown>> = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal reasoning" },
          { type: "text", text: "the answer" },
        ],
      },
    ];
    const stripped = stripReplayThinking(messages);
    expect(stripped).toBe(1);
    const content = messages[0]!.content as Array<Record<string, unknown>>;
    expect(content.some((b) => b.type === "thinking")).toBe(false);
    expect(content.some((b) => b.type === "text")).toBe(true);
  });

  it("defer-recall strips transient recall from history and defers it off the cached prefix", () => {
    // The recall block (envelope-wrapper top-1 RAG) must be stripped from historical
    // user turns (prefix stability) and, on the current turn, deferred to an uncached
    // trailing block — the two defer-recall stabilizers.
    // Must match the shipped INLINE_RECALL_BLOCK_RE: a `(recorded YYYY-MM-DD)`
    // stamp and the block at the START of the text (the envelope-wrapper prepends it).
    const recallLine = "[Relevant context from memory: the user prefers metric units (recorded 2026-06-20)]";
    const messages: Array<Record<string, unknown>> = [
      { role: "user", content: `${recallLine}\nWhat is the weather?` },
      { role: "assistant", content: [{ type: "text", text: "Sunny." }] },
      { role: "user", content: `${recallLine}\nAnd tomorrow?` },
    ];
    const strippedFromHistory = stripTransientRecallFromHistory(messages);
    expect(strippedFromHistory).toBe(1); // the historical (first) user turn
    expect(messages[0]!.content).not.toContain("Relevant context from memory");
    // The latest user turn still carries the recall — defer it to the uncached tail.
    const deferred = deferRecallToUncachedTail(messages);
    expect(deferred).toBe(1);
    const latest = messages[2]!.content as Array<Record<string, unknown>>;
    expect(Array.isArray(latest)).toBe(true);
    // The recall is now a SEPARATE trailing block (after the query block).
    expect(latest.length).toBe(2);
    expect(latest[1]!.text).toContain("Relevant context from memory");
  });
});

/** A minimal config exposing only the fields runEveryTurnMicrocompact reads. */
function makeConfig(overrides: Partial<RequestBodyInjectorConfig> = {}): RequestBodyInjectorConfig {
  return {
    sessionKey: "verify-eff-cooperation",
    observationKeepWindow: 1,
    ...overrides,
  } as unknown as RequestBodyInjectorConfig;
}

/** A message array with `count` stale `read` tool_results, each preceded by its tool_use. */
function messagesWithStaleReads(count: number): Array<Record<string, unknown>> {
  const STALE = "X".repeat(1500); // > MICROCOMPACT_MIN_CONTENT_LENGTH (1000)
  const msgs: Array<Record<string, unknown>> = [];
  for (let i = 0; i < count; i++) {
    msgs.push({ role: "user", content: [{ type: "text", text: `u${i}` }] });
    msgs.push({ role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "read", input: {} }] });
    msgs.push({ role: "tool", tool_use_id: `t${i}`, content: [{ type: "text", text: STALE }] });
  }
  return msgs;
}

describe("every-turn microcompact pass cooperates with the verify-only stack (does NOT bypass it)", () => {
  it("calls onContentModification when it clears so the cache-break detector treats it as deliberate", () => {
    // The cooperation invariant: clearing stale results must announce a deliberate
    // content modification (wired to detector.notifyContentModification in the
    // factory) so the next response is not mis-flagged as a cache bust.
    const onContentModification = vi.fn();
    const onAdaptiveRetentionReset = vi.fn();
    const result: Record<string, unknown> = { messages: messagesWithStaleReads(3) };
    const config = makeConfig({ onContentModification, onAdaptiveRetentionReset });

    runEveryTurnMicrocompact(result, config, createMockLogger());

    expect(onContentModification).toHaveBeenCalledTimes(1);
  });

  it("NEVER calls onAdaptiveRetentionReset on clear (the warm-cache rule, mirrors the ceiling trigger)", () => {
    // The every-turn pass runs on a (possibly) warm cache, so — unlike the
    // TTL-expiry trigger — it must NOT reset adaptive retention. Resetting would
    // throw away the escalated 1h retention and re-pay cold-start writes.
    const onContentModification = vi.fn();
    const onAdaptiveRetentionReset = vi.fn();
    const result: Record<string, unknown> = { messages: messagesWithStaleReads(3) };
    const config = makeConfig({ onContentModification, onAdaptiveRetentionReset });

    runEveryTurnMicrocompact(result, config, createMockLogger());

    expect(onAdaptiveRetentionReset).not.toHaveBeenCalled();
  });

  it("signals NEITHER callback when nothing is clearable (no spurious cache-break attribution)", () => {
    // With everything inside the keep window, nothing clears → no deliberate-change
    // signal fires, so the detector is not told of a phantom modification.
    const onContentModification = vi.fn();
    const onAdaptiveRetentionReset = vi.fn();
    const result: Record<string, unknown> = { messages: messagesWithStaleReads(2) };
    const config = makeConfig({
      observationKeepWindow: 10, // both reads within the window → nothing clears
      onContentModification,
      onAdaptiveRetentionReset,
    });

    runEveryTurnMicrocompact(result, config, createMockLogger());

    expect(onContentModification).not.toHaveBeenCalled();
    expect(onAdaptiveRetentionReset).not.toHaveBeenCalled();
  });
});
