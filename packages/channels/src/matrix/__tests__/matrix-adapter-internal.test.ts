// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { reactionKey } from "../matrix-adapter-internal.js";

describe("reactionKey", () => {
  it("does not collide when a component contains the delimiter character", () => {
    // The retained-reaction map keys on (room, message, emoji). If a component can
    // contain the delimiter, two DISTINCT triples must not map to the same key —
    // otherwise removeReaction for one silently redacts the other's annotation.
    const a = reactionKey("!r:hs", "$m:hs", "a|b");
    const b = reactionKey("!r:hs", "$m:hs|a", "b");
    expect(a).not.toBe(b);
  });

  it("is stable and distinguishes each of the three components", () => {
    const base = reactionKey("!r:hs", "$m:hs", "👍");
    expect(reactionKey("!r:hs", "$m:hs", "👍")).toBe(base);
    expect(reactionKey("!other:hs", "$m:hs", "👍")).not.toBe(base);
    expect(reactionKey("!r:hs", "$other:hs", "👍")).not.toBe(base);
    expect(reactionKey("!r:hs", "$m:hs", "🎉")).not.toBe(base);
  });
});
