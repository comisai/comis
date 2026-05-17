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
