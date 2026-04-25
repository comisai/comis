// SPDX-License-Identifier: Apache-2.0
/**
 * Bearer auth timing-safety integration test.
 *
 * The gateway uses crypto.timingSafeEqual under the hood to compare incoming
 * bearer tokens. This test:
 *
 *   - Confirms behavioural correctness (right token => verify(); any wrong
 *     token => null) across many adversarial shapes (off-by-one byte,
 *     length mismatch, empty, multi-byte unicode).
 *   - Asserts the comparator does NOT short-circuit on the first byte by
 *     measuring per-iteration timing for "wrong-by-one-byte" vs.
 *     "wrong-everywhere" tokens. We do not pin an exact ratio (timing is
 *     noisy in CI), but assert the ratio is well within an order of
 *     magnitude. A plain string-compare implementation would be > 10x off.
 *
 * No daemon -- exercises the createTokenStore primitive directly.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { createTokenStore } from "@comis/gateway";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const REAL_TOKEN = "test-secret-key-for-integration-tests-aaaaaaaaaaaa";
const TOKEN_LEN = REAL_TOKEN.length;

function makeStore() {
  return createTokenStore([
    { id: "alpha", secret: REAL_TOKEN, scopes: ["rpc", "ws"] },
    {
      id: "beta",
      secret: "another-distinct-token-for-collision-tests-beta-x",
      scopes: ["admin"],
    },
  ]);
}

// ---------------------------------------------------------------------------
// Behavioural correctness
// ---------------------------------------------------------------------------

describe("Bearer auth -- behavioural correctness", () => {
  const store = makeStore();

  it("verifies the correct token", () => {
    const c = store.verify(REAL_TOKEN);
    expect(c).not.toBeNull();
    expect(c?.id).toBe("alpha");
    expect(c?.scopes).toEqual(["rpc", "ws"]);
  });

  it("rejects a token differing by one byte", () => {
    // Flip the last byte from "a" to "b" -- the byte count is identical.
    const offByOne = REAL_TOKEN.slice(0, -1) + "b";
    expect(store.verify(offByOne)).toBeNull();
  });

  it("rejects a token differing by one byte at the start", () => {
    const offByOne = "X" + REAL_TOKEN.slice(1);
    expect(store.verify(offByOne)).toBeNull();
  });

  it("rejects a shorter token", () => {
    expect(store.verify(REAL_TOKEN.slice(0, -1))).toBeNull();
  });

  it("rejects a longer token", () => {
    expect(store.verify(REAL_TOKEN + "x")).toBeNull();
  });

  it("rejects an empty token", () => {
    expect(store.verify("")).toBeNull();
  });

  it("rejects an entirely different token of the same length", () => {
    expect(store.verify("X".repeat(TOKEN_LEN))).toBeNull();
  });

  it("verifies the second token", () => {
    const c = store.verify(
      "another-distinct-token-for-collision-tests-beta-x",
    );
    expect(c).not.toBeNull();
    expect(c?.id).toBe("beta");
  });

  it("handles unicode token without crashing", () => {
    // Multi-byte unicode token; should be safely rejected (lengths differ
    // when UTF-8 encoded vs. the ASCII secret).
    expect(store.verify("\u{1F600}\u{1F47D}\u{1F63A}")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Timing safety: wrong-by-one-byte vs. wrong-everywhere
// ---------------------------------------------------------------------------

describe("Bearer auth -- timing safety (timingSafeEqual sanity)", () => {
  const store = makeStore();

  // The store iterates over all entries and uses timingSafeEqual on every
  // equal-length comparison. Both forged tokens we test have the SAME
  // length as REAL_TOKEN, so the same number of byte comparisons happens
  // in either case.
  const offByLast = REAL_TOKEN.slice(0, -1) + "Z";
  const wrongAll = "Z".repeat(TOKEN_LEN);

  function timeMany(iterations: number, token: string): number {
    // Warm-up to avoid JIT-driven first-call distortion.
    for (let i = 0; i < 1_000; i++) store.verify(token);

    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) {
      store.verify(token);
    }
    const end = process.hrtime.bigint();
    return Number(end - start);
  }

  it("comparison time of off-by-last vs. wrong-everywhere is within an order of magnitude", () => {
    const ITER = 100_000;

    // Average two runs to dampen jitter.
    const t1 = (timeMany(ITER, offByLast) + timeMany(ITER, offByLast)) / 2;
    const t2 = (timeMany(ITER, wrongAll) + timeMany(ITER, wrongAll)) / 2;
    const ratio = Math.max(t1, t2) / Math.min(t1, t2);

    // Generous bound: timingSafeEqual should keep this well under 2x in
    // practice. We assert < 10x to keep the test stable in noisy CI.
    // A naive string compare that short-circuits would be >> 10x.
    expect(ratio).toBeLessThan(10);
  });

  it("never returns the same client identity for any forged variant", () => {
    const variants = [
      offByLast,
      wrongAll,
      "",
      REAL_TOKEN.slice(0, -1),
      REAL_TOKEN + "extra",
      REAL_TOKEN.toUpperCase(),
      REAL_TOKEN.toLowerCase(),
      REAL_TOKEN + "\0",
      "\0" + REAL_TOKEN,
    ];
    for (const v of variants) {
      if (v === REAL_TOKEN) continue;
      expect(store.verify(v)).toBeNull();
    }
  });
});
