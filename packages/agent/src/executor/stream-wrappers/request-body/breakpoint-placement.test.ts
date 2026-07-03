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

describe("placeCacheBreakpoints — tail-reaching coverage on long conversations", () => {
  // Live evidence: Anthropic honors at most 4 cache_control breakpoints, and
  // TWO are consumed outside placeCacheBreakpoints (the system/tools marker + the SDK's auto-marker
  // on the LAST message). Placing 3 Comis markers (semi-stable + bridge + recent) pushes the total
  // to 5 → Anthropic SILENTLY DROPS the tail-reaching markers → the cache freezes at the early
  // markers and re-writes the whole growing suffix every turn (O(N²); read frozen at 54961). Hence:
  // cap Comis at 2 markers (anchor + recent) so the total stays ≤4 and the RECENT marker reaches
  // the tail (its fresh write caches the whole prefix; live: single-tail read 54961→142941).
  const CACHE_LOOKBACK_WINDOW = 20;

  function markerIndices(msgs: Array<Record<string, unknown>>): number[] {
    const out: number[] = [];
    for (let i = 0; i < msgs.length; i++) {
      const c = msgs[i]!.content;
      if (Array.isArray(c) && c.some((b) => (b as Record<string, unknown>).cache_control)) out.push(i);
    }
    return out;
  }

  it("places AT MOST 2 markers (leaving room for system + SDK within Anthropic's 4-limit)", () => {
    const roles: string[] = [];
    for (let i = 0; i < 50; i++) roles.push(i % 2 === 0 ? "user" : "assistant");
    const msgs = makeMessages(roles);
    const placed = placeCacheBreakpoints(msgs, { minTokens: 0, maxBreakpoints: 4, strategy: "multi-zone" });
    expect(placed).toBeLessThanOrEqual(2); // even when given maxBreakpoints:4, Comis reserves 2 for system+SDK
    expect(markerIndices(msgs).length).toBeLessThanOrEqual(2);
  });

  it("places the RECENT marker in the tail zone (chains the SDK last-message marker), not stranded early", () => {
    // 50 alternating 1-block messages. The load-bearing marker must be at the second-to-last user
    // message (idx 48), NOT clustered at the start — otherwise the tail is never cached.
    const roles: string[] = [];
    for (let i = 0; i < 50; i++) roles.push(i % 2 === 0 ? "user" : "assistant");
    const msgs = makeMessages(roles);
    placeCacheBreakpoints(msgs, { minTokens: 0, maxBreakpoints: 4, strategy: "multi-zone" });
    const idx = markerIndices(msgs); // 1 block per message → index == block offset
    expect(idx.length).toBeGreaterThanOrEqual(1);
    // The LAST Comis marker reaches the recent/tail zone: second-to-last user message.
    // Messages 0..49 alternate user(even)/assistant(odd) → last user=48, second-to-last user=46.
    expect(idx[idx.length - 1]!).toBe(46);
  });

  it("anchors the first marker to a STABLE block-boundary position as the conversation grows (incremental hits)", () => {
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
