// SPDX-License-Identifier: Apache-2.0
/**
 * Pure-function tests for breakpoint-placement.ts.
 *
 * Targeted unit tests for `placeCacheBreakpoints` + `placeSingleBreakpoint`
 * that exercise the public function directly (without
 * createRequestBodyInjector). Integration paths that wire through the
 * factory remain in factory.test.ts (lookback window enforcement,
 * token-density semi-stable placement, breakpoint strategy config).
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { placeCacheBreakpoints, placeSingleBreakpoint } from "./breakpoint-placement.js";
import { addCacheControlToLastBlock } from "./cache-control-block.js";

function makeMessages(roles: string[]): Array<Record<string, unknown>> {
  return roles.map((role, i) => ({
    role,
    content: [{ type: "text", text: `msg ${i}` }],
  }));
}

describe("placeCacheBreakpoints — pure", () => {
  it("returns 0 when messages.length < 4", () => {
    const msgs = makeMessages(["user", "assistant", "user"]);
    const placed = placeCacheBreakpoints(msgs, {
      minTokens: 0,
      maxBreakpoints: 3,
    });
    expect(placed).toBe(0);
    // No cache_control markers should have been added.
    for (const msg of msgs) {
      const content = msg.content as Array<Record<string, unknown>>;
      expect(content.every(b => !b.cache_control)).toBe(true);
    }
  });

  it("returns 0 when maxBreakpoints <= 0", () => {
    const msgs = makeMessages(["user", "assistant", "user", "assistant", "user"]);
    const placed = placeCacheBreakpoints(msgs, {
      minTokens: 0,
      maxBreakpoints: 0,
    });
    expect(placed).toBe(0);
  });

  it("delegates to placeSingleBreakpoint when strategy === 'single'", () => {
    // 4+ user messages so the single-breakpoint path finds a second-to-last user.
    const msgs = makeMessages([
      "user", "assistant", "user", "assistant", "user", "assistant", "user",
    ]);
    const placed = placeCacheBreakpoints(msgs, {
      minTokens: 0,
      maxBreakpoints: 3,
      strategy: "single",
    });
    expect(placed).toBe(1);
    // The second-to-last user message (index 4) should carry cache_control.
    const secondToLastUser = msgs[4]!.content as Array<Record<string, unknown>>;
    expect(secondToLastUser[0]!.cache_control).toBeDefined();
  });
});

describe("placeCacheBreakpoints — lookback-window coverage on long conversations (cache C-FIX-2, 2026-06-18)", () => {
  // Live evidence: on a long tool turn the markers clustered as semi-stable@blk13 +
  // recent@blk35 + SDK@blk38 — the recent marker is REDUNDANT with the SDK's end marker
  // (3 blocks apart) while the gap blk13→blk35 (22 blocks) had NO marker and exceeded the
  // Anthropic 20-block lookback window → that middle segment missed the cache every turn.
  // The fix keeps the FIRST marker within the window of the start and BRIDGES the mid gap
  // (priority over the redundant recent marker), so no inter-marker gap exceeds the window.
  const CACHE_LOOKBACK_WINDOW = 20;

  function markerIndices(msgs: Array<Record<string, unknown>>): number[] {
    const out: number[] = [];
    for (let i = 0; i < msgs.length; i++) {
      const c = msgs[i]!.content;
      if (Array.isArray(c) && c.some((b) => (b as Record<string, unknown>).cache_control)) out.push(i);
    }
    return out;
  }

  it("bounds every gap (start→first, first→second) within the lookback window on a long conversation", () => {
    // 50 alternating 1-block messages → 50%-token semi-stable ≈ idx 25 (> 20 from start) and
    // the recent zone ≈ idx 48 (clustered with the would-be SDK end marker), leaving a >20 gap.
    const roles: string[] = [];
    for (let i = 0; i < 50; i++) roles.push(i % 2 === 0 ? "user" : "assistant");
    const msgs = makeMessages(roles);
    placeCacheBreakpoints(msgs, { minTokens: 0, maxBreakpoints: 2, strategy: "multi-zone" });
    const idx = markerIndices(msgs); // 1 block per message → index == block offset
    expect(idx.length).toBeGreaterThanOrEqual(1);
    // First marker within the lookback window of the conversation start (block 0).
    expect(idx[0]!).toBeLessThanOrEqual(CACHE_LOOKBACK_WINDOW);
    // No gap between consecutive Comis markers exceeds the window (the mid-gap is bridged,
    // not left to a recent marker clustered at the end).
    for (let i = 1; i < idx.length; i++) {
      expect(idx[i]! - idx[i - 1]!).toBeLessThanOrEqual(CACHE_LOOKBACK_WINDOW);
    }
  });

  it("anchors the first marker to a STABLE block-boundary position as the conversation grows (C-FIX-2b incremental hits)", () => {
    // The markers must NOT drift turn-to-turn: a drifting 50%-token marker lands on different
    // messages each turn, so the cache prefix the previous turn wrote is no longer marked →
    // read-drops + ~18K token re-writes. Anchoring to the latest user at/before block W gives a
    // FIXED position (append-only), so two conversations sharing a prefix mark the SAME message.
    function conv(n: number): Array<Record<string, unknown>> {
      const r: string[] = [];
      for (let i = 0; i < n; i++) r.push(i % 2 === 0 ? "user" : "assistant");
      return makeMessages(r);
    }
    const m30 = conv(30); placeCacheBreakpoints(m30, { minTokens: 0, maxBreakpoints: 2, strategy: "multi-zone" });
    const m36 = conv(36); placeCacheBreakpoints(m36, { minTokens: 0, maxBreakpoints: 2, strategy: "multi-zone" });
    // First marker stable across lengths (was: drifted with 50%-token → cache misses).
    expect(markerIndices(m36)[0]).toBe(markerIndices(m30)[0]);
  });

  it("short conversations are unaffected (no bridge needed; original recent-zone behavior)", () => {
    const msgs = makeMessages(["user", "assistant", "user", "assistant", "user", "assistant", "user", "assistant"]);
    const placed = placeCacheBreakpoints(msgs, { minTokens: 0, maxBreakpoints: 2, strategy: "multi-zone" });
    expect(placed).toBeGreaterThan(0);
    expect(markerIndices(msgs)[0]!).toBeLessThanOrEqual(CACHE_LOOKBACK_WINDOW);
  });
});

describe("placeSingleBreakpoint — pure", () => {
  it("returns 0 when fewer than 2 messages", () => {
    const msgs = makeMessages(["user"]);
    const placed = placeSingleBreakpoint(msgs);
    expect(placed).toBe(0);
  });

  it("targets second-to-last user message by default", () => {
    const msgs = makeMessages(["user", "assistant", "user", "assistant", "user"]);
    const placed = placeSingleBreakpoint(msgs);
    expect(placed).toBe(1);
    // Second-to-last user is index 2.
    const second = msgs[2]!.content as Array<Record<string, unknown>>;
    expect(second[0]!.cache_control).toBeDefined();
  });

  it("targets third-to-last user message when skipCacheWrite is true", () => {
    const msgs = makeMessages(["user", "assistant", "user", "assistant", "user", "assistant", "user"]);
    const placed = placeSingleBreakpoint(msgs, undefined, /* skipCacheWrite */ true);
    expect(placed).toBe(1);
    // Third-to-last user is index 2 (indices 0, 2, 4, 6 are user).
    const third = msgs[2]!.content as Array<Record<string, unknown>>;
    expect(third[0]!.cache_control).toBeDefined();
  });

  it("falls back to second-to-last user when skipCacheWrite has no third-to-last", () => {
    // Only 2 user messages.
    const msgs = makeMessages(["user", "assistant", "user"]);
    const placed = placeSingleBreakpoint(msgs, undefined, /* skipCacheWrite */ true);
    expect(placed).toBe(1);
    // Falls back to second-to-last (index 0).
    const second = msgs[0]!.content as Array<Record<string, unknown>>;
    expect(second[0]!.cache_control).toBeDefined();
  });

  it("propagates retention to addCacheControlToLastBlock", () => {
    const msgs = makeMessages(["user", "assistant", "user", "assistant", "user"]);
    placeSingleBreakpoint(msgs, "long" as any);
    const second = msgs[2]!.content as Array<Record<string, unknown>>;
    expect(second[0]!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("addCacheControlToLastBlock is the shared helper consumed by single placement", () => {
    // Regression: confirm the dependency is exposed via cache-control-block.ts
    // (the sibling module breakpoint-placement.ts imports from).
    const msg: Record<string, unknown> = {
      role: "user",
      content: [{ type: "text", text: "hello" }],
    };
    addCacheControlToLastBlock(msg);
    expect((msg.content as Array<Record<string, unknown>>)[0]!.cache_control).toBeDefined();
  });
});
